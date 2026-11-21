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

function buildFakeOctokit(options: {
  createReview?: ReturnType<typeof vi.fn>;
  reviews?: Array<{ body: string | null }>;
} = {}) {
  const createReview =
    options.createReview ?? vi.fn().mockResolvedValue({ data: {} });

  const octokit = {
    rest: {
      pulls: {
        get: vi.fn().mockResolvedValue({ data: pullRequestResponse() }),
        listFiles: vi.fn().mockResolvedValue({
          data: [
            {
              filename: "src/config.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              changes: 1,
              patch,
            },
          ],
        }),
        listReviews: vi.fn().mockResolvedValue({ data: options.reviews ?? [] }),
        createReview,
      },
      repos: {
        getContent: vi.fn(),
      },
    },
  } as unknown as Octokit;

  return { octokit, createReview };
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
    const { octokit } = buildFakeOctokit({ createReview });
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

    const params = createReview.mock.calls[0]?.[0] as ReviewParams;
    expect(params.comments).toHaveLength(1);
    expect(params.comments?.[0]?.path).toBe("src/config.ts");
    expect(params.comments?.[0]?.body).toContain("process.env.PASSWORD");
  });

  it("skips a commit that already has a review marker", async () => {
    const { octokit, createReview } = buildFakeOctokit({
      reviews: [{ body: `<!-- ai-code-review:${headSha} -->` }],
    });
    const { outcome, analyze } = await runReview(octokit);

    const result = await outcome;
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("already reviewed");
    expect(analyze).not.toHaveBeenCalled();
    expect(createReview).not.toHaveBeenCalled();
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

  it("requires GitHub App credentials when no client is supplied", async () => {
    await expect(
      reviewPullRequest(tokenConfig, tokenJob, logger, {
        createAnalyzer: () => ({ analyze: vi.fn() }),
      }),
    ).rejects.toThrow("GitHub App credentials are required");
  });
});
