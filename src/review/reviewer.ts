import type { Octokit } from "@octokit/rest";
import type { Logger } from "pino";
import type { AppConfig, GitHubConfig } from "../config.js";
import { installationClient } from "../github/app.js";
import { fetchSourceFiles } from "../github/contents.js";
import { parseFilePatch, type FileDiff } from "../github/diff.js";
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
  hasReviewMarker,
  serializeFindingsAsText,
} from "./summary.js";

export interface ReviewJob {
  installationId: number;
  owner: string;
  repo: string;
  pullNumber: number;
  /** Head SHA from the webhook; the reviewer re-reads the current head. */
  headSha: string;
  action: string;
}

/** Optional seams used by integration tests. */
export interface ReviewerDependencies {
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

/** Lockfiles, generated output, vendored code and binaries are not worth reviewing. */
const IGNORED_PATHS: RegExp[] = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|Pipfile\.lock)$/,
  /(^|\/)(dist|build|out|vendor|node_modules|__snapshots__|coverage)\//,
  /\.min\.(js|css|mjs)$/,
  /\.(map|lock)$/,
  /\.(png|jpe?g|gif|webp|ico|bmp|tiff|pdf|zip|gz|tgz|tar|jar|exe|dll|so|dylib|wasm|woff2?|ttf|eot|mp4|mov|avi|mp3)$/i,
];

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
    skipped.push({ path: extra.path, reason: "over the per-review file limit" });
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

async function alreadyReviewed(
  octokit: Octokit,
  params: { owner: string; repo: string; pull_number: number },
  headSha: string,
): Promise<boolean> {
  for (let page = 1; page <= 5; page += 1) {
    const response = await octokit.rest.pulls.listReviews({
      ...params,
      per_page: 100,
      page,
    });
    if (response.data.some((review) => hasReviewMarker(review.body, headSha))) {
      return true;
    }
    if (response.data.length < 100) break;
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
  config: AppConfig,
  job: ReviewJob,
  log: Logger,
  deps: ReviewerDependencies = {},
): Promise<PullRequestOutcome> {
  const startedAt = Date.now();
  const getOctokit = deps.getOctokit ?? installationClient;
  const octokit = getOctokit(config.github, job.installationId, log);
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

    if (await alreadyReviewed(octokit, params, headSha)) {
      return finish("skipped", "this commit was already reviewed");
    }

    const files = await listPullRequestFiles(octokit, params);
    const { reviewable, skipped } = prepareDiffs(
      files,
      config.review.maxFiles,
      config.review.maxFilePatchChars,
    );
    const omittedFiles = skipped.filter(
      (entry) => entry.reason === "over the per-review file limit",
    ).length;

    const semgrep: {
      available: boolean;
      findingsCount: number;
      error?: string;
    } = { available: false, findingsCount: 0 };

    let semgrepFindings: Finding[] = [];
    const semgrepRejected: string[] = [];

    if (reviewable.length > 0 && config.semgrep.enabled) {
      const fetched = await fetchSourceFiles(octokit, {
        owner: job.owner,
        repo: job.repo,
        ref: headSha,
        paths: reviewable.map((diff) => diff.path),
        maxFileBytes: config.semgrep.maxFileBytes,
      });

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
      files: reviewable,
      omittedFiles,
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
        files: reviewable.length,
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

    const llmNormalized = normalizeLlmFindings(analysis.findings, reviewable);
    const merged = dedupeFindings(
      mergeSemgrepWithLlm(llmNormalized.accepted, semgrepFindings),
    );
    const thresholded = filterByConfidence(
      merged,
      config.review.confidenceThreshold,
    );
    const capped = capFindings(thresholded.posted, config.review.maxFindings);
    const posted = capped.kept;
    const withheld = [...thresholded.withheld, ...capped.dropped];

    const body = buildReviewBody({
      headSha,
      posted,
      withheld,
      filesReviewed: reviewable.length,
      skippedFiles: skipped,
      semgrep: {
        available: semgrep.available,
        count: semgrep.findingsCount,
        ...(semgrep.error ? { error: semgrep.error } : {}),
      },
      analysisErrors: [...analysis.errors, ...semgrepRejected],
      durationMs: Date.now() - startedAt,
    });

    if (posted.length === 0 && withheld.length === 0 && !config.review.summaryOnClean) {
      return finish("reviewed", "no issues found", {
        filesReviewed: reviewable.length,
      });
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
        rejected: llmNormalized.rejected.length + semgrepRejected.length,
        files: reviewable.length,
        durationMs: Date.now() - startedAt,
      },
      "review posted",
    );

    return finish("reviewed", undefined, {
      posted: posted.length,
      withheld: withheld.length,
      filesReviewed: reviewable.length,
    });
  } catch (error) {
    log.error({ err: error }, "review failed");
    return finish(
      "failed",
      error instanceof Error ? error.message : "unknown review error",
    );
  }
}
