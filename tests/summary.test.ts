import { describe, expect, it } from "vitest";
import type { Finding } from "../src/types.js";
import {
  buildCommentBody,
  buildReviewBody,
  hasReviewMarker,
  markerFor,
  serializeFindingsAsText,
} from "../src/review/summary.js";

const headSha = "a".repeat(40);

const finding: Finding = {
  path: "src/users.ts",
  line: 11,
  severity: "high",
  category: "security",
  title: "SQL injection in user search",
  body: "The name parameter is concatenated into the query.",
  suggestion:
    "  const users = await db.query(\n    \"SELECT id, email FROM users WHERE name = $1\",\n    [name],\n  );",
  confidence: 0.94,
  source: "llm",
};

const withheld: Finding = {
  ...finding,
  line: 20,
  severity: "low",
  title: "Possible null dereference",
  confidence: 0.35,
};

describe("review markers", () => {
  it("builds and detects a per-commit marker", () => {
    expect(markerFor(headSha)).toContain(headSha);
    expect(hasReviewMarker(`hello ${markerFor(headSha)}`, headSha)).toBe(true);
    expect(hasReviewMarker("hello", headSha)).toBe(false);
  });
});

describe("buildReviewBody", () => {
  it("summarizes counts, locations and static analysis", () => {
    const body = buildReviewBody({
      headSha,
      posted: [finding],
      withheld: [withheld],
      filesReviewed: 3,
      skippedFiles: [{ path: "package-lock.json", reason: "generated" }],
      semgrep: { available: true, count: 2 },
      analysisErrors: ["batch 1: timeout"],
      durationMs: 4200,
    });

    expect(body.startsWith(markerFor(headSha))).toBe(true);
    expect(body).toContain("**1 issue found**");
    expect(body).toContain("1 high");
    expect(body).toContain("`src/users.ts:11`");
    expect(body).toContain("Semgrep baseline: 2 findings");
    expect(body).toContain("Not posted (1");
    expect(body).toContain("Skipped files (1)");
    expect(body).toContain("Reviewer warnings (1)");
    expect(body).toContain("4.2s");
  });

  it("reports a clean review when nothing was found", () => {
    const body = buildReviewBody({
      headSha,
      posted: [],
      withheld: [],
      filesReviewed: 2,
      skippedFiles: [],
      semgrep: { available: false, count: 0, error: "not installed" },
      analysisErrors: [],
      durationMs: 1000,
    });
    expect(body).toContain("**No issues found** in 2 files reviewed.");
    expect(body).toContain("Semgrep baseline: unavailable (not installed)");
  });

  it("explains when there was nothing reviewable", () => {
    const body = buildReviewBody({
      headSha,
      posted: [],
      withheld: [],
      filesReviewed: 0,
      skippedFiles: [{ path: "yarn.lock", reason: "generated" }],
      semgrep: { available: true, count: 0 },
      analysisErrors: [],
      durationMs: 100,
    });
    expect(body).toContain("**No reviewable changes**");
  });

  it("escapes table separators in titles", () => {
    const body = buildReviewBody({
      headSha,
      posted: [{ ...finding, title: "a | b" }],
      withheld: [],
      filesReviewed: 1,
      skippedFiles: [],
      semgrep: { available: true, count: 0 },
      analysisErrors: [],
      durationMs: 500,
    });
    expect(body).toContain("a \\| b");
  });
});

describe("buildCommentBody", () => {
  it("includes a GitHub suggestion block and confidence", () => {
    const body = buildCommentBody(finding);
    expect(body).toContain("**SQL injection in user search**");
    expect(body).toContain("```suggestion");
    expect(body).toContain("Confidence 94%");
  });

  it("marks corroborated static findings", () => {
    const body = buildCommentBody({ ...finding, source: "both" });
    expect(body).toContain("corroborated by Semgrep");
  });

  it("marks deterministic findings", () => {
    const body = buildCommentBody({
      ...finding,
      source: "semgrep",
      ruleId: "ai-review-js-eval",
    });
    expect(body).toContain("ai-review-js-eval");
  });
});

describe("serializeFindingsAsText", () => {
  it("falls back to a readable list", () => {
    const text = serializeFindingsAsText([finding]);
    expect(text).toContain("inline comments unavailable");
    expect(text).toContain("src/users.ts:11");
    expect(text).toContain("```suggestion");
  });
});
