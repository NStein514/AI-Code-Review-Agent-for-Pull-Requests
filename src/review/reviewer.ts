import type { Octokit } from "@octokit/rest";
import type { Logger } from "pino";
import type { GitHubConfig, LlmShellConfig } from "../config.js";
import { installationClient } from "../github/app.js";
import { fetchSourceFiles } from "../github/contents.js";
import {
  buildLineIndex,
  findFileDiff,
  linesInRange,
  normalizePath,
  parseFilePatch,
  type FileDiff,
} from "../github/diff.js";
import type { Finding, PullRequestOutcome } from "../types.js";
import {
  ReviewerAnalyzer,
  type AnalyzerLike,
  type AnalyzerOptions,
} from "./analyzer.js";
import {
  capFindings,
  dedupeFindings,
  filterByConfidence,
  mergeSemgrepWithLlm,
  normalizeLlmFindings,
  normalizeSemgrepFindings,
} from "./findings.js";
import { runSemgrep } from "./semgrep.js";
import {
  buildCommentBody,
  buildReviewBody,
  markedSha,
  serializeFindingsAsText,
} from "./summary.js";

export type ReviewRuntimeConfig = LlmShellConfig & { github?: GitHubConfig };

export interface ReviewJob {
  /** GitHub App installation; omitted in token mode. */
  installationId?: number;
  owner: string;
  repo: string;
  pullNumber: number;
  /** Head SHA from the webhook; the reviewer re-reads the current head. */
  headSha: string;
  action: string;
}

/** Optional seams used by integration tests. */
export interface ReviewerDependencies {
  /** Prebuilt client, used by token mode and tests. Skips GitHub App auth. */
  octokit?: Octokit;
  getOctokit?: (
    credentials: Pick<GitHubConfig, "appId" | "privateKey">,
    installationId: number,
    logger?: Logger,
  ) => Octokit;
  createAnalyzer?: (options: AnalyzerOptions) => AnalyzerLike;
  runSemgrep?: typeof runSemgrep;
}

export interface PullRequestFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

type CreateReviewParams = NonNullable<
  Parameters<Octokit["rest"]["pulls"]["createReview"]>[0]
>;

interface ReviewState {
  alreadyReviewed: boolean;
  lastReviewedSha: string | null;
  botReviewIds: Set<number>;
}

interface IncrementalDiff {
  files: PullRequestFile[];
  commits: number;
}

interface ExistingReviewComment {
  id: number;
  path: string;
  line: number | null;
  startLine: number | null;
}

interface CommentReconciliation {
  staleIds: number[];
  anchors: Set<string>;
}

function installationOctokit(
  config: ReviewRuntimeConfig,
  job: ReviewJob,
  deps: ReviewerDependencies,
  log: Logger,
): Octokit {
  if (!config.github) {
    throw new Error(
      "GitHub App credentials are required unless a token client is supplied",
    );
  }
  if (job.installationId === undefined) {
    throw new Error("installationId is required for GitHub App authentication");
  }
  return (deps.getOctokit ?? installationClient)(
    config.github,
    job.installationId,
    log,
  );
}

/** Lockfiles, generated output, vendored code and binaries are not worth reviewing. */
const IGNORED_PATHS: RegExp[] = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|Pipfile\.lock)$/,
  /(^|\/)(dist|build|out|vendor|node_modules|__snapshots__|coverage)\//,
  /\.min\.(js|css|mjs)$/,
  /\.(map|lock)$/,
  /\.(png|jpe?g|gif|webp|ico|bmp|tiff|pdf|zip|gz|tgz|tar|jar|exe|dll|so|dylib|wasm|woff2?|ttf|eot|mp4|mov|avi|mp3)$/i,
];

const FILE_LIMIT_REASON = "over the per-review file limit";

export function prepareDiffs(
  files: PullRequestFile[],
  maxFiles: number,
  maxPatchChars = 24_000,
): { reviewable: FileDiff[]; skipped: Array<{ path: string; reason: string }> } {
  const candidates: FileDiff[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const file of files) {
    if (IGNORED_PATHS.some((pattern) => pattern.test(file.filename))) {
      skipped.push({ path: file.filename, reason: "generated, vendored, or binary file" });
      continue;
    }
    if (!file.patch || file.patch.trim().length === 0) {
      skipped.push({ path: file.filename, reason: "no textual patch available" });
      continue;
    }
    if (file.patch.length > maxPatchChars) {
      skipped.push({ path: file.filename, reason: "patch is too large to review" });
      continue;
    }

    const diff = parseFilePatch(
      file.filename,
      file.patch,
      file.status,
      file.previous_filename,
    );
    if (diff.hunks.length === 0) {
      skipped.push({ path: file.filename, reason: "no reviewable hunks" });
      continue;
    }
    candidates.push(diff);
  }

  const reviewable = candidates.slice(0, maxFiles);
  for (const extra of candidates.slice(maxFiles)) {
    skipped.push({ path: extra.path, reason: FILE_LIMIT_REASON });
  }

  return { reviewable, skipped };
}

async function listPullRequestFiles(
  octokit: Octokit,
  params: { owner: string; repo: string; pull_number: number },
  maxFiles = 300,
): Promise<PullRequestFile[]> {
  const files: PullRequestFile[] = [];

  for (let page = 1; files.length < maxFiles; page += 1) {
    const response = await octokit.rest.pulls.listFiles({
      ...params,
      per_page: 100,
      page,
    });

    for (const file of response.data) {
      files.push({
        filename: file.filename,
        ...(file.previous_filename ? { previous_filename: file.previous_filename } : {}),
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        ...(file.patch ? { patch: file.patch } : {}),
      });
    }

    if (response.data.length < 100) break;
  }

  return files.slice(0, maxFiles);
}

async function findReviewState(
  octokit: Octokit,
  params: { owner: string; repo: string; pull_number: number },
  headSha: string,
): Promise<ReviewState> {
  const normalizedHead = headSha.toLowerCase();
  const marked: Array<{ id: number; sha: string; submittedAt: string }> = [];

  for (let page = 1; page <= 5; page += 1) {
    const response = await octokit.rest.pulls.listReviews({
      ...params,
      per_page: 100,
      page,
    });

    for (const review of response.data) {
      const sha = markedSha(review.body);
      if (sha) {
        marked.push({
          id: review.id,
          sha,
          submittedAt: review.submitted_at ?? "",
        });
      }
    }
    if (response.data.length < 100) break;
  }

  const alreadyReviewed = marked.some((entry) => entry.sha === normalizedHead);
  const lastReviewedSha =
    marked
      .filter((entry) => entry.sha !== normalizedHead)
      .sort(
        (left, right) =>
          left.submittedAt.localeCompare(right.submittedAt) || left.id - right.id,
      )
      .at(-1)?.sha ?? null;

  return {
    alreadyReviewed,
    lastReviewedSha,
    botReviewIds: new Set(marked.map((entry) => entry.id)),
  };
}

async function compareSince(
  octokit: Octokit,
  params: { owner: string; repo: string },
  baseSha: string,
  headSha: string,
  log: Logger,
): Promise<IncrementalDiff | null> {
  try {
    const response = await octokit.rest.repos.compareCommits({
      owner: params.owner,
      repo: params.repo,
      base: baseSha,
      head: headSha,
    });

    if (response.data.status !== "ahead") {
      log.info(
        { baseSha, headSha, status: response.data.status },
        "reviewed SHA is no longer strictly behind the head; using the full pull request diff",
      );
      return null;
    }

    return {
      files: (response.data.files ?? []).map((file) => ({
        filename: file.filename,
        ...(file.previous_filename
          ? { previous_filename: file.previous_filename }
          : {}),
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        ...(file.patch ? { patch: file.patch } : {}),
      })),
      commits: response.data.commits?.length ?? 0,
    };
  } catch (error) {
    log.warn(
      { err: error, baseSha, headSha },
      "could not compare the last reviewed SHA; using the full pull request diff",
    );
    return null;
  }
}

async function fetchBotComments(
  octokit: Octokit,
  params: { owner: string; repo: string; pull_number: number },
  botReviewIds: Set<number>,
  log: Logger,
): Promise<ExistingReviewComment[]> {
  if (botReviewIds.size === 0) return [];

  const comments: ExistingReviewComment[] = [];
  try {
    for (let page = 1; page <= 10; page += 1) {
      const response = await octokit.rest.pulls.listReviewComments({
        ...params,
        per_page: 100,
        page,
      });

      for (const comment of response.data) {
        if (
          comment.pull_request_review_id !== null &&
          comment.pull_request_review_id !== undefined &&
          botReviewIds.has(comment.pull_request_review_id)
        ) {
          comments.push({
            id: comment.id,
            path: comment.path,
            line: typeof comment.line === "number" ? comment.line : null,
            startLine:
              typeof comment.start_line === "number"
                ? comment.start_line
                : null,
          });
        }
      }
      if (response.data.length < 100) break;
    }
  } catch (error) {
    log.warn({ err: error }, "could not list prior review comments");
    return [];
  }

  return comments;
}

function classifyComments(
  files: PullRequestFile[],
  parsed: FileDiff[],
  comments: ExistingReviewComment[],
): CommentReconciliation {
  const staleIds: number[] = [];
  const anchors = new Set<string>();
  const indexes = new Map<string, Map<number, string>>();

  for (const comment of comments) {
    const normalized = normalizePath(comment.path);
    const raw = files.find(
      (file) =>
        normalizePath(file.filename) === normalized ||
        (file.previous_filename !== undefined &&
          normalizePath(file.previous_filename) === normalized),
    );
    // A truncated file list is not proof that the file is gone.
    if (!raw) continue;

    if (raw.status === "removed") {
      staleIds.push(comment.id);
      continue;
    }

    const diff = findFileDiff(parsed, comment.path);
    if (!diff) continue;

    let index = indexes.get(diff.path);
    if (!index) {
      index = buildLineIndex(diff);
      indexes.set(diff.path, index);
    }

    if (comment.line === null) {
      staleIds.push(comment.id);
      continue;
    }

    const first = Math.min(comment.startLine ?? comment.line, comment.line);
    const last = Math.max(comment.startLine ?? comment.line, comment.line);
    if (!linesInRange(index, first, last)) {
      staleIds.push(comment.id);
      continue;
    }

    const path = normalizePath(diff.path);
    for (let line = first; line <= last; line += 1) {
      anchors.add(`${path}:${line}`);
    }
  }

  return { staleIds, anchors };
}

async function deleteStaleComments(
  octokit: Octokit,
  params: { owner: string; repo: string },
  staleIds: number[],
  log: Logger,
): Promise<number> {
  let deleted = 0;

  for (const commentId of staleIds) {
    try {
      await octokit.rest.pulls.deleteReviewComment({
        owner: params.owner,
        repo: params.repo,
        comment_id: commentId,
      });
      deleted += 1;
    } catch (error) {
      log.warn(
        { err: error, commentId },
        "could not delete an outdated review comment",
      );
    }
  }

  return deleted;
}

/** A finding is a duplicate when any of its lines already has a comment. */
function findingTouchesAnchor(
  finding: Finding,
  anchors: Set<string>,
): boolean {
  const first = Math.min(finding.startLine ?? finding.line, finding.line);
  const last = Math.max(finding.startLine ?? finding.line, finding.line);
  const path = normalizePath(finding.path);

  for (let line = first; line <= last; line += 1) {
    if (anchors.has(`${path}:${line}`)) return true;
  }
  return false;
}

async function postReview(
  octokit: Octokit,
  params: CreateReviewParams,
  posted: Finding[],
  body: string,
  log: Logger,
): Promise<void> {
  try {
    await octokit.rest.pulls.createReview(params);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 422 || !params.comments || params.comments.length === 0) {
      throw error;
    }

    log.warn({ err: error }, "GitHub rejected inline comments; posting a summary review");
    const fallback = `${body}\n\n${serializeFindingsAsText(posted)}`;
    await octokit.rest.pulls.createReview({
      ...params,
      body: fallback.slice(0, 60_000),
      comments: [],
    });
  }
}

export async function reviewPullRequest(
  config: ReviewRuntimeConfig,
  job: ReviewJob,
  log: Logger,
  deps: ReviewerDependencies = {},
): Promise<PullRequestOutcome> {
  const startedAt = Date.now();
  const octokit = deps.octokit ?? installationOctokit(config, job, deps, log);
  const params = {
    owner: job.owner,
    repo: job.repo,
    pull_number: job.pullNumber,
  };

  const finish = (
    status: PullRequestOutcome["status"],
    reason?: string,
    extra: Partial<PullRequestOutcome> = {},
  ): PullRequestOutcome => ({
    status,
    ...(reason ? { reason } : {}),
    posted: 0,
    withheld: 0,
    filesReviewed: 0,
    durationMs: Date.now() - startedAt,
    ...extra,
  });

  try {
    const prResponse = await octokit.rest.pulls.get(params);
    const pr = prResponse.data;
    const headSha = pr.head.sha;

    if (pr.state !== "open") {
      return finish("skipped", `pull request is ${pr.state}`);
    }
    if (pr.draft && config.review.skipDrafts) {
      return finish("skipped", "draft pull request");
    }

    const headRepo = pr.head.repo?.full_name;
    const baseRepo = pr.base.repo?.full_name;
    const isFork = !headRepo || !baseRepo || headRepo !== baseRepo;
    if (isFork && !config.review.reviewForks) {
      return finish("skipped", "pull request comes from a fork");
    }

    const reviewState = await findReviewState(octokit, params, headSha);
    if (reviewState.alreadyReviewed) {
      return finish("skipped", "this commit was already reviewed");
    }

    const files = await listPullRequestFiles(octokit, params);
    // Parse every file once. The whole pull request diff validates model output
    // and anchors earlier comments; `reviewable` only applies the review cap.
    const parsed = prepareDiffs(
      files,
      Math.max(files.length, 1),
      config.review.maxFilePatchChars,
    );
    const reviewable = parsed.reviewable.slice(0, config.review.maxFiles);
    const skipped = [
      ...parsed.skipped,
      ...parsed.reviewable.slice(config.review.maxFiles).map((diff) => ({
        path: diff.path,
        reason: "over the per-review file limit",
      })),
    ];
    const lastReviewedSha = reviewState.lastReviewedSha;

    // Review markers record the commit each review analyzed. When the newest
    // marker is still an ancestor, only commits pushed since then need review;
    // a force-push or unreadable comparison falls back to the full diff.
    let analysisFiles = reviewable;
    let skippedFiles = skipped;
    let incremental: { fromSha: string; commits: number } | undefined;

    if (lastReviewedSha) {
      const delta = await compareSince(
        octokit,
        { owner: job.owner, repo: job.repo },
        lastReviewedSha,
        headSha,
        log,
      );

      if (delta) {
        const prPaths = new Set(
          files.flatMap((file) => [
            normalizePath(file.filename),
            ...(file.previous_filename
              ? [normalizePath(file.previous_filename)]
              : []),
          ]),
        );
        // Merges from the base branch appear in the comparison but are not
        // part of this pull request, so only files it touched are analyzed.
        const changed = delta.files.filter(
          (file) =>
            prPaths.has(normalizePath(file.filename)) ||
            (file.previous_filename !== undefined &&
              prPaths.has(normalizePath(file.previous_filename))),
        );
        const prepared = prepareDiffs(
          changed,
          config.review.maxFiles,
          config.review.maxFilePatchChars,
        );

        analysisFiles = prepared.reviewable;
        skippedFiles = prepared.skipped;
        incremental = { fromSha: lastReviewedSha, commits: delta.commits };
      }
    }

    const omittedFiles = skippedFiles.filter(
      (entry) => entry.reason === FILE_LIMIT_REASON,
    ).length;

    const semgrep: {
      available: boolean;
      findingsCount: number;
      error?: string;
    } = { available: false, findingsCount: 0 };

    let semgrepFindings: Finding[] = [];
    const semgrepRejected: string[] = [];

    // Fetch head-revision sources once: Semgrep needs real files, and the model
    // uses bounded windows of them as verification-only context.
    const contextEnabled =
      config.review.contextLines > 0 && config.review.maxContextChars > 0;
    const needSources =
      analysisFiles.length > 0 && (config.semgrep.enabled || contextEnabled);
    const fetched = needSources
      ? await fetchSourceFiles(octokit, {
          owner: job.owner,
          repo: job.repo,
          ref: headSha,
          paths: analysisFiles.map((diff) => diff.path),
          maxFileBytes: config.semgrep.maxFileBytes,
        })
      : { files: [], skipped: [] };

    if (analysisFiles.length > 0 && config.semgrep.enabled) {
      const run = await (deps.runSemgrep ?? runSemgrep)({
        files: fetched.files,
        config: config.semgrep.config,
        timeoutMs: config.semgrep.timeoutMs,
        logger: log,
      });

      semgrep.available = run.available;
      semgrep.findingsCount = run.findings.length;
      if (run.error) semgrep.error = run.error;

      const normalizedStatic = normalizeSemgrepFindings(run.findings, reviewable);
      semgrepFindings = normalizedStatic.accepted;
      semgrepRejected.push(
        ...normalizedStatic.rejected.map((rejection) => rejection.reason),
      );
      log.debug(
        {
          available: run.available,
          findings: run.findings.length,
          accepted: semgrepFindings.length,
          errorCount: run.errorCount,
        },
        "semgrep baseline finished",
      );
    }

    const createAnalyzer =
      deps.createAnalyzer ??
      ((options: AnalyzerOptions) => new ReviewerAnalyzer(options));
    const analyzer = createAnalyzer({
      ...config.anthropic,
      maxDiffChars: config.review.maxDiffChars,
      contextLines: config.review.contextLines,
      maxContextChars: config.review.maxContextChars,
      logger: log,
    });

    const analysis = await analyzer.analyze({
      repoFullName: `${job.owner}/${job.repo}`,
      prNumber: job.pullNumber,
      prTitle: pr.title,
      prBody: pr.body,
      author: pr.user?.login ?? "unknown",
      baseRef: pr.base.ref,
      headRef: pr.head.ref,
      headSha,
      files: analysisFiles,
      omittedFiles,
      sources: fetched.files,
      semgrepFindings: semgrepFindings.map((finding) => ({
        ruleId: finding.ruleId ?? "semgrep",
        path: finding.path,
        line: finding.line,
        severity: finding.severity,
        category: finding.category,
        message: finding.title,
        ...(finding.evidence ? { snippet: finding.evidence } : {}),
      })),
      ...(config.review.customInstructions
        ? { customInstructions: config.review.customInstructions }
        : {}),
    });

    log.info(
      {
        batches: analysis.batches,
        failedBatches: analysis.failedBatches,
        truncatedBatches: analysis.truncatedBatches,
        files: analysisFiles.length,
        findings: analysis.findings.length,
        inputTokens: analysis.usage.inputTokens,
        outputTokens: analysis.usage.outputTokens,
      },
      "model review finished",
    );

    const allBatchesFailed =
      analysis.batches > 0 &&
      analysis.failedBatches >= analysis.batches &&
      semgrepFindings.length === 0;

    if (allBatchesFailed) {
      return finish("failed", analysis.errors[0] ?? "model review failed");
    }

    // Earlier reviews left inline comments on this pull request. Delete the ones
    // whose lines no longer exist, and remember the valid locations so this
    // pass cannot post a second comment for the same line.
    const earlierComments = lastReviewedSha
      ? await fetchBotComments(octokit, params, reviewState.botReviewIds, log)
      : [];
    const { staleIds, anchors } = classifyComments(
      files,
      parsed.reviewable,
      earlierComments,
    );
    const reconciled = await deleteStaleComments(
      octokit,
      { owner: job.owner, repo: job.repo },
      staleIds,
      log,
    );

    const llmNormalized = normalizeLlmFindings(analysis.findings, reviewable);
    const merged = dedupeFindings(
      mergeSemgrepWithLlm(llmNormalized.accepted, semgrepFindings),
    );
    const thresholded = filterByConfidence(
      merged,
      config.review.confidenceThreshold,
    );
    const fresh = thresholded.posted.filter(
      (finding) => !findingTouchesAnchor(finding, anchors),
    );
    const suppressed = thresholded.posted.length - fresh.length;
    const capped = capFindings(fresh, config.review.maxFindings);
    const posted = capped.kept;
    const withheld = [...thresholded.withheld, ...capped.dropped];

    const body = buildReviewBody({
      headSha,
      posted,
      withheld,
      filesReviewed: analysisFiles.length,
      skippedFiles,
      ...(incremental ? { incremental } : {}),
      ...(reconciled > 0 ? { reconciled } : {}),
      semgrep: {
        available: semgrep.available,
        count: semgrep.findingsCount,
        ...(semgrep.error ? { error: semgrep.error } : {}),
      },
      analysisErrors: [...analysis.errors, ...semgrepRejected],
      durationMs: Date.now() - startedAt,
    });

    const outcomeExtra: Partial<PullRequestOutcome> = {
      filesReviewed: analysisFiles.length,
      ...(incremental ? { incremental } : {}),
      ...(reconciled > 0 ? { reconciled } : {}),
      ...(suppressed > 0 ? { suppressed } : {}),
    };

    if (
      posted.length === 0 &&
      withheld.length === 0 &&
      !config.review.summaryOnClean
    ) {
      if (!incremental) {
        return finish("reviewed", "no issues found", outcomeExtra);
      }
      // A clean incremental run still posts its marker so the next push only
      // analyzes commits after this SHA.
      await postReview(
        octokit,
        {
          ...params,
          commit_id: headSha,
          event: "COMMENT",
          body,
          comments: [],
        },
        [],
        body,
        log,
      );
      log.info(
        {
          files: analysisFiles.length,
          mode: "incremental",
          baseSha: incremental.fromSha,
          commits: incremental.commits,
          reconciled,
          suppressed,
          durationMs: Date.now() - startedAt,
        },
        "clean incremental review posted",
      );
      return finish("reviewed", "no issues found", outcomeExtra);
    }

    const comments = posted.map((finding) => ({
      path: finding.path,
      line: finding.line,
      side: "RIGHT" as const,
      ...(finding.startLine !== undefined
        ? { start_line: finding.startLine, start_side: "RIGHT" as const }
        : {}),
      body: buildCommentBody(finding),
    }));

    await postReview(
      octokit,
      {
        ...params,
        commit_id: headSha,
        event: "COMMENT",
        body,
        comments,
      },
      posted,
      body,
      log,
    );

    log.info(
      {
        posted: posted.length,
        withheld: withheld.length,
        suppressed,
        reconciled,
        rejected: llmNormalized.rejected.length + semgrepRejected.length,
        files: analysisFiles.length,
        mode: incremental ? "incremental" : "full",
        ...(incremental
          ? { baseSha: incremental.fromSha, commits: incremental.commits }
          : {}),
        durationMs: Date.now() - startedAt,
      },
      "review posted",
    );

    return finish("reviewed", undefined, {
      ...outcomeExtra,
      posted: posted.length,
      withheld: withheld.length,
    });
  } catch (error) {
    log.error({ err: error }, "review failed");
    return finish(
      "failed",
      error instanceof Error ? error.message : "unknown review error",
    );
  }
}
