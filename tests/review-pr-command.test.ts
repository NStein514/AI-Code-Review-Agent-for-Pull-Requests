import type { tokenClient } from "../src/github/app.js";
import type { reviewPullRequest } from "../src/review/reviewer.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  main,
  parseArgs,
  resolveTarget,
  runReviewPr,
} from "../src/cli/review-pr-command.js";

const defaults = { semgrep: true, json: false, help: false };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("review-pr CLI", () => {
  it("parses repository, pull request and overrides", () => {
    expect(
      parseArgs([
        "--repo",
        "acme/api",
        "--pr",
        "42",
        "--threshold",
        "0.75",
        "--model",
        "model-x",
        "--no-semgrep",
        "--json",
      ]),
    ).toEqual({
      ...defaults,
      repo: "acme/api",
      pullRequest: "42",
      threshold: 0.75,
      model: "model-x",
      semgrep: false,
      json: true,
    });
  });

  it("derives the repository from a pull request URL", () => {
    const options = parseArgs([
      "--pr",
      "https://github.com/acme/api/pull/42",
    ]);

    expect(options.repo).toBe("acme/api");
    expect(options.pullRequest).toBe("https://github.com/acme/api/pull/42");
  });

  it("resolves the target from environment defaults", () => {
    expect(
      resolveTarget(defaults, {
        GITHUB_REPOSITORY: "acme/api",
        PULL_REQUEST_NUMBER: "7",
      }),
    ).toEqual({ owner: "acme", repo: "api", pullNumber: 7 });
  });

  it("rejects a repository that does not match the URL", () => {
    expect(() =>
      parseArgs([
        "--repo",
        "acme/api",
        "--pr",
        "https://github.com/acme/other/pull/1",
      ]),
    ).toThrow(/does not match/);
  });

  it("requires a token before building a client", async () => {
    await expect(
      runReviewPr(
        { ...defaults, repo: "acme/api", pullRequest: "1" },
        {},
      ),
    ).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it("runs the reviewer through a token client with CLI overrides", async () => {
    const review = vi.fn().mockResolvedValue({
      status: "reviewed",
      posted: 1,
      withheld: 0,
      filesReviewed: 1,
      durationMs: 5,
    });
    const createClient = vi.fn().mockReturnValue({});

    const result = await runReviewPr(
      {
        ...defaults,
        repo: "acme/api",
        pullRequest: "42",
        model: "override-model",
        threshold: 0.8,
        semgrep: false,
      },
      { GITHUB_TOKEN: "token", ANTHROPIC_API_KEY: "key" },
      {
        review: review as unknown as typeof reviewPullRequest,
        createClient: createClient as unknown as typeof tokenClient,
      },
    );

    expect(result.target).toEqual({ owner: "acme", repo: "api", pullNumber: 42 });
    expect(createClient).toHaveBeenCalledWith("token", {
      logger: expect.anything(),
    });

    const [config, job, , deps] = review.mock.calls[0] ?? [];
    expect(config).toMatchObject({
      anthropic: { model: "override-model" },
      review: { confidenceThreshold: 0.8 },
      semgrep: { enabled: false },
    });
    expect(config.github).toBeUndefined();
    expect(job).toMatchObject({ owner: "acme", repo: "api", pullNumber: 42 });
    expect(deps).toEqual({ octokit: {} });
    expect(result.outcome.status).toBe("reviewed");
  });

  it("prints help without requiring credentials", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(main(["--help"], {})).resolves.toBe(0);
    expect(log).toHaveBeenCalledOnce();
  });
});
