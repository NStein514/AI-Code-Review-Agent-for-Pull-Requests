import type { Octokit } from "@octokit/rest";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { configForTests } from "./helpers.js";
import { ReviewerAnalyzer, type AnalyzeResult } from "../src/review/analyzer.js";
import { reviewPullRequest, type ReviewJob } from "../src/review/reviewer.js";
import type { LlmFinding } from "../src/review/findings.js";

const headSha = "f".repeat(40);
const logger = pino({ level: "silent" });
const config = configForTests({ SEMGREP_ENABLED: "false" });

const patch = [
  "@@ -1,2 +1,3 @@",
  " export const config = {};",
  '+const password = "hunter2";',
  " export default config;",
].join("\n");

const rawFinding: LlmFinding = {
  path: "src/config.ts",
  line: 2,
  severity: "high",
  category: "security",
  title: "Hardcoded password in config",
  body: "The password is committed to source, so anyone with repository access can read it.",
  suggestion: "const password = process.env.PASSWORD;",
  confidence: 0.92,
  evidence: 'const password = "hunter2";',
};

const analyzerResult: AnalyzeResult = {
  findings: [rawFinding],
  summaries: [],
  errors: [],
  usage: { inputTokens: 120, outputTokens: 40 },
  batches: 1,
  failedBatches: 0,
  failedModelCalls: 0,
  truncatedBatches: 0,
};

const job: ReviewJob = {
  installationId: 99,
  owner: "acme",
  repo: "api",
  pullNumber: 7,
  headSha: "stale".padEnd(40, "0"),
  action: "opened",
};

const tokenConfig = {
  anthropic: config.anthropic,
  review: config.review,
  semgrep: config.semgrep,
};

const tokenJob: ReviewJob = {
  owner: "acme",
  repo: "api",
  pullNumber: 7,
  headSha: "",
  action: "manual",
};

function pullRequestResponse() {
  return {
    number: 7,
    state: "open",
    draft: false,
    title: "Add request config",
    body: "Loads configuration at startup.",
    user: { login: "dev" },
    head: {
      sha: headSha,
      ref: "feature/config",
      repo: { full_name: "acme/api" },
    },
    base: {
      ref: "main",
      repo: { full_name: "acme/api" },
    },
  };
}

interface ReviewParams {
  owner: string;
  repo: string;
  pull_number: number;
  commit_id?: string;
  event?: string;
  body?: string;
  comments?: Array<{
    path: string;
    line?: number;
    side?: string;
    start_line?: number;
    body: string;
  }>;
}

const headSource = [
  "export const config = {};",
  'const password = "hunter2";',
  "export default config;",
  'const version = "1.0.0";',
].join("\n");

interface FakeFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

interface FakeReview {
  id: number;
  body: string | null;
  submitted_at?: string;
}

interface FakeComment {
  id: number;
  path: string;
  line: number | null;
  start_line?: number | null;
  pull_request_review_id: number | null;
}

const configFile: FakeFile = {
  filename: "src/config.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  changes: 1,
  patch,
};

const otherFile: FakeFile = {
  filename: "src/health.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  changes: 1,
  patch: ["@@ -1,1 +1,2 @@", " export function health() {", "+  return { ok: false };"].join(
    "\n",
  ),
};

const removedFile: FakeFile = {
  filename: "src/old.ts",
  status: "removed",
  additions: 0,
  deletions: 1,
  changes: 1,
  patch: ["@@ -1,1 +0,0 @@", "-export const legacy = true;"].join("\n"),
};

function buildFakeOctokit(
  options: {
    createReview?: ReturnType<typeof vi.fn>;
    reviews?: FakeReview[];
    files?: FakeFile[];
    comments?: FakeComment[];
    compare?:
      | { status: string; files?: FakeFile[]; commits?: Array<{ sha: string }> }
      | Error;
    deleteReviewComment?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const createReview =
    options.createReview ?? vi.fn().mockResolvedValue({ data: {} });
  const deleteReviewComment =
    options.deleteReviewComment ?? vi.fn().mockResolvedValue({ data: {} });
  const compareCommits = vi.fn();
  if (options.compare instanceof Error) {
    compareCommits.mockRejectedValue(options.compare);
  } else {
    compareCommits.mockResolvedValue({
      data: options.compare ?? { status: "ahead", files: [], commits: [] },
    });
  }
  const getContent = vi.fn().mockResolvedValue({
    data: {
      type: "file",
      encoding: "base64",
      size: Buffer.byteLength(headSource),
      content: Buffer.from(headSource, "utf8").toString("base64"),
    },
  });

  const octokit = {
    rest: {
      pulls: {
        get: vi.fn().mockResolvedValue({ data: pullRequestResponse() }),
        listFiles: vi.fn().mockResolvedValue({
          data: options.files ?? [configFile],
        }),
        listReviews: vi.fn().mockResolvedValue({ data: options.reviews ?? [] }),
        listReviewComments: vi.fn().mockResolvedValue({
          data: options.comments ?? [],
        }),
        deleteReviewComment,
        createReview,
      },
      repos: {
        getContent,
        compareCommits,
      },
    },
  } as unknown as Octokit;

  return { octokit, createReview, getContent, deleteReviewComment, compareCommits };
}

function runReview(
  octokit: Octokit,
  analyze = vi.fn().mockResolvedValue(analyzerResult),
) {
  return {
    analyze,
    outcome: reviewPullRequest(config, job, logger, {
      getOctokit: () => octokit,
      createAnalyzer: () => ({ analyze }),
    }),
  };
}

function analyzedPaths(analyze: ReturnType<typeof vi.fn>): string[] {
  const input = analyze.mock.calls[0]?.[0] as
    | { files: Array<{ path: string }> }
    | undefined;
  return input?.files.map((file) => file.path) ?? [];
}

describe("reviewPullRequest posting", () => {
  it("posts one review with a marker, inline comment and suggestion", async () => {
    const { octokit, createReview } = buildFakeOctokit();
    const { outcome } = await runReview(octokit);

    const result = await outcome;
    expect(result.status).toBe("reviewed");
    expect(result.posted).toBe(1);
    expect(result.withheld).toBe(0);
    expect(result.filesReviewed).toBe(1);

    expect(createReview).toHaveBeenCalledTimes(1);
    const params = createReview.mock.calls[0]?.[0] as ReviewParams;

    expect(params.owner).toBe("acme");
    expect(params.repo).toBe("api");
    expect(params.pull_number).toBe(7);
    expect(params.commit_id).toBe(headSha);
    expect(params.event).toBe("COMMENT");
    expect(params.body).toContain(`<!-- ai-code-review:${headSha} -->`);
    expect(params.body).toContain("**1 issue found**");
    expect(params.body).toContain("`src/config.ts:2`");

    expect(params.comments).toHaveLength(1);
    const comment = params.comments?.[0];
    expect(comment?.path).toBe("src/config.ts");
    expect(comment?.line).toBe(2);
    expect(comment?.side).toBe("RIGHT");
    expect(comment?.start_line).toBeUndefined();
    expect(comment?.body).toContain("Hardcoded password in config");
    expect(comment?.body).toContain("```suggestion");
    expect(comment?.body).toContain("process.env.PASSWORD");
    expect(comment?.body).toContain("Confidence 92%");
  });

  it("falls back to a summary-only review when GitHub rejects inline comments", async () => {
    const createReview = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("Unprocessable Entity"), { status: 422 }),
      )
      .mockResolvedValueOnce({ data: {} });

    const { octokit } = buildFakeOctokit({ createReview });
    const { outcome } = await runReview(octokit);

    const result = await outcome;
    expect(result.status).toBe("reviewed");
    expect(result.posted).toBe(1);
    expect(createReview).toHaveBeenCalledTimes(2);

    const retryParams = createReview.mock.calls[1]?.[0] as ReviewParams;
    expect(retryParams.commit_id).toBe(headSha);
    expect(retryParams.comments).toEqual([]);
    expect(retryParams.body).toContain("Findings (inline comments unavailable)");
    expect(retryParams.body).toContain("Hardcoded password in config");
    expect(retryParams.body).toContain("process.env.PASSWORD");
  });

  it("runs the real analyzer against a mocked model and posts its findings", async () => {
    const createReview = vi.fn().mockResolvedValue({ data: {} });
    const { octokit, getContent } = buildFakeOctokit({ createReview });
    const callModel = vi.fn().mockResolvedValue({
      stopReason: "tool_use",
      toolCalled: true,
      toolInput: { findings: [rawFinding] },
      usage: { inputTokens: 30, outputTokens: 10 },
    });

    const result = await reviewPullRequest(config, job, logger, {
      getOctokit: () => octokit,
      createAnalyzer: (options) =>
        new ReviewerAnalyzer({ ...options, callModel }),
    });

    expect(result.status).toBe("reviewed");
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(getContent).toHaveBeenCalledTimes(1);

    const request = callModel.mock.calls[0]?.[0] as { user: string };
    const context = request.user.split("<file_context>")[1] ?? "";
    expect(request.user).toContain("<file_context>");
    expect(context).toContain('4 | const version = "1.0.0";');
    expect(context).not.toContain('2 | const password = "hunter2";');

    const params = createReview.mock.calls[0]?.[0] as ReviewParams;
    expect(params.comments).toHaveLength(1);
    expect(params.comments?.[0]?.path).toBe("src/config.ts");
    expect(params.comments?.[0]?.body).toContain("process.env.PASSWORD");
  });

  it("skips a commit that already has a review marker", async () => {
    const { octokit, createReview } = buildFakeOctokit({
      reviews: [
        {
          id: 1,
          body: `<!-- ai-code-review:${headSha} -->`,
          submitted_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const { outcome, analyze } = await runReview(octokit);

    const result = await outcome;
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("already reviewed");
    expect(analyze).not.toHaveBeenCalled();
    expect(createReview).not.toHaveBeenCalled();
  });

  it("analyzes only commits added since the last reviewed SHA", async () => {
    const baseSha = "b".repeat(40);
    const { octokit, createReview, compareCommits } = buildFakeOctokit({
      reviews: [
        {
          id: 10,
          body: `<!-- ai-code-review:${baseSha} -->`,
          submitted_at: "2026-01-01T00:00:00Z",
        },
      ],
      files: [configFile, otherFile],
      compare: {
        status: "ahead",
        commits: [{ sha: "c1" }, { sha: "c2" }],
        // A base-branch merge also touches src/base-branch.ts; it is not part
        // of this pull request and must not be analyzed.
        files: [
          configFile,
          { ...otherFile, filename: "src/base-branch.ts" },
        ],
      },
    });

    const { outcome, analyze } = await runReview(octokit);
    const result = await outcome;

    expect(result.status).toBe("reviewed");
    expect(result.incremental).toEqual({ fromSha: baseSha, commits: 2 });
    expect(compareCommits).toHaveBeenCalledWith(
      expect.objectContaining({ base: baseSha, head: headSha }),
    );

    expect(analyzedPaths(analyze)).toEqual(["src/config.ts"]);

    const params = createReview.mock.calls[0]?.[0] as ReviewParams;
    expect(params.body).toContain(
      "Incremental review: 2 commits since `bbbbbbb`.",
    );
    expect(params.comments).toHaveLength(1);
  });

  it("suppresses a finding that overlaps an existing multi-line comment", async () => {
    const baseSha = "b".repeat(40);
    const { octokit, createReview, deleteReviewComment } = buildFakeOctokit({
      reviews: [
        {
          id: 10,
          body: `<!-- ai-code-review:${baseSha} -->`,
          submitted_at: "2026-01-01T00:00:00Z",
        },
      ],
      compare: { status: "ahead", commits: [{ sha: "c1" }], files: [configFile] },
      comments: [
        {
          id: 101,
          path: "src/config.ts",
          line: 3,
          start_line: 2,
          pull_request_review_id: 10,
        },
      ],
    });

    const { outcome } = await runReview(octokit);
    const result = await outcome;

    expect(result.suppressed).toBe(1);
    expect(result.posted).toBe(0);
    expect(deleteReviewComment).not.toHaveBeenCalled();

    const params = createReview.mock.calls[0]?.[0] as ReviewParams;
    expect(params.comments).toEqual([]);
    expect(params.body).toContain("**No issues found** in 1 file reviewed.");
  });

  it("deletes stale comments and does not re-post duplicates", async () => {
    const baseSha = "b".repeat(40);
    const { octokit, createReview, deleteReviewComment } = buildFakeOctokit({
      reviews: [
        {
          id: 10,
          body: `<!-- ai-code-review:${baseSha} -->`,
          submitted_at: "2026-01-01T00:00:00Z",
        },
      ],
      files: [configFile, removedFile],
      compare: { status: "ahead", commits: [{ sha: "c1" }], files: [configFile] },
      comments: [
        { id: 101, path: "src/config.ts", line: 2, pull_request_review_id: 10 },
        { id: 102, path: "src/old.ts", line: 1, pull_request_review_id: 10 },
        { id: 103, path: "src/config.ts", line: 99, pull_request_review_id: 10 },
        { id: 104, path: "src/config.ts", line: 2, pull_request_review_id: 999 },
      ],
    });

    const { outcome, analyze } = await runReview(octokit);
    const result = await outcome;

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("reviewed");
    expect(result.reconciled).toBe(2);
    expect(result.suppressed).toBe(1);
    expect(result.posted).toBe(0);
    expect(deleteReviewComment).toHaveBeenCalledTimes(2);
    expect(
      deleteReviewComment.mock.calls
        .map((call) => (call[0] as { comment_id: number }).comment_id)
        .sort((left, right) => left - right),
    ).toEqual([102, 103]);

    const params = createReview.mock.calls[0]?.[0] as ReviewParams;
    expect(params.comments).toEqual([]);
    expect(params.body).toContain("Removed 2 outdated inline comments.");
    expect(params.body).toContain("**No issues found** in 1 file reviewed.");
  });

  it("falls back to the full pull request diff on a force-push", async () => {
    const baseSha = "b".repeat(40);
    const { octokit, createReview } = buildFakeOctokit({
      reviews: [
        {
          id: 10,
          body: `<!-- ai-code-review:${baseSha} -->`,
          submitted_at: "2026-01-01T00:00:00Z",
        },
      ],
      files: [configFile, otherFile],
      compare: { status: "diverged", files: [configFile], commits: [] },
    });

    const { outcome, analyze } = await runReview(octokit);
    const result = await outcome;

    expect(result.status).toBe("reviewed");
    expect(result.incremental).toBeUndefined();
    expect(analyzedPaths(analyze).sort()).toEqual([
      "src/config.ts",
      "src/health.ts",
    ]);

    const params = createReview.mock.calls[0]?.[0] as ReviewParams;
    expect(params.body).not.toContain("Incremental review");
  });

  it("falls back to the full pull request diff when the comparison fails", async () => {
    const baseSha = "b".repeat(40);
    const { octokit, createReview, compareCommits } = buildFakeOctokit({
      reviews: [
        {
          id: 10,
          body: `<!-- ai-code-review:${baseSha} -->`,
          submitted_at: "2026-01-01T00:00:00Z",
        },
      ],
      files: [configFile, otherFile],
      compare: new Error("compare failed"),
    });

    const { outcome, analyze } = await runReview(octokit);
    const result = await outcome;

    expect(result.status).toBe("reviewed");
    expect(result.incremental).toBeUndefined();
    expect(compareCommits).toHaveBeenCalledTimes(1);
    expect(analyzedPaths(analyze).sort()).toEqual([
      "src/config.ts",
      "src/health.ts",
    ]);

    const params = createReview.mock.calls[0]?.[0] as ReviewParams;
    expect(params.body).not.toContain("Incremental review");
  });

  it("posts a marker-only review after a clean incremental run", async () => {
    const quiet = configForTests({
      SEMGREP_ENABLED: "false",
      REVIEW_SUMMARY_ON_CLEAN: "false",
    });
    const baseSha = "b".repeat(40);
    const { octokit, createReview } = buildFakeOctokit({
      reviews: [
        {
          id: 10,
          body: `<!-- ai-code-review:${baseSha} -->`,
          submitted_at: "2026-01-01T00:00:00Z",
        },
      ],
      compare: { status: "ahead", commits: [{ sha: "c1" }], files: [configFile] },
    });
    const analyze = vi
      .fn()
      .mockResolvedValue({ ...analyzerResult, findings: [] });

    const result = await reviewPullRequest(quiet, job, logger, {
      getOctokit: () => octokit,
      createAnalyzer: () => ({ analyze }),
    });

    expect(result.status).toBe("reviewed");
    expect(result.reason).toContain("no issues found");
    expect(createReview).toHaveBeenCalledTimes(1);

    const params = createReview.mock.calls[0]?.[0] as ReviewParams;
    expect(params.comments).toEqual([]);
    expect(params.body).toContain(`<!-- ai-code-review:${headSha} -->`);
    expect(params.body).toContain(
      "Incremental review: 1 commit since `bbbbbbb`.",
    );
  });

  it("reviews with a supplied token client and no GitHub App configuration", async () => {
    const { octokit, createReview } = buildFakeOctokit();
    const analyze = vi.fn().mockResolvedValue(analyzerResult);

    const result = await reviewPullRequest(tokenConfig, tokenJob, logger, {
      octokit,
      createAnalyzer: () => ({ analyze }),
    });

    expect(result.status).toBe("reviewed");
    expect(result.posted).toBe(1);
    expect(createReview).toHaveBeenCalledTimes(1);
  });

  it("does not fetch sources when context is disabled", async () => {
    const disabledSettings: Array<Record<string, string>> = [
      { REVIEW_CONTEXT_LINES: "0" },
      { REVIEW_MAX_CONTEXT_CHARS: "0" },
    ];
    for (const overrides of disabledSettings) {
      const disabled = configForTests({
        SEMGREP_ENABLED: "false",
        ...overrides,
      });
      const { octokit, getContent } = buildFakeOctokit();
      const analyze = vi.fn().mockResolvedValue(analyzerResult);

      const result = await reviewPullRequest(disabled, job, logger, {
        getOctokit: () => octokit,
        createAnalyzer: () => ({ analyze }),
      });

      expect(result.status).toBe("reviewed");
      expect(getContent).not.toHaveBeenCalled();
      const input = analyze.mock.calls[0]?.[0] as
        | { sources?: unknown[] }
        | undefined;
      expect(input?.sources).toEqual([]);
    }
  });

  it("requires GitHub App credentials when no client is supplied", async () => {
    await expect(
      reviewPullRequest(tokenConfig, tokenJob, logger, {
        createAnalyzer: () => ({ analyze: vi.fn() }),
      }),
    ).rejects.toThrow("GitHub App credentials are required");
  });
});
