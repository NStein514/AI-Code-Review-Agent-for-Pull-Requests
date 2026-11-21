import { describe, expect, it } from "vitest";
import { parseFilePatch } from "../src/github/diff.js";
import { ReviewerAnalyzer, type ModelCaller } from "../src/review/analyzer.js";
import type { LlmFinding } from "../src/review/findings.js";

function diffFor(path: string, addedLine: string) {
  return parseFilePatch(
    path,
    ["@@ -1,2 +1,3 @@", " before", `+${addedLine}`, " after"].join("\n"),
    "modified",
  );
}

const fileA = diffFor("src/a.ts", "const a = 1;");
const fileB = diffFor("src/b.ts", "const b = 2;");

function finding(path: string, title: string): LlmFinding {
  return {
    path,
    line: 2,
    severity: "high",
    category: "bug",
    title,
    body: "The added line breaks an invariant that callers depend on.",
    confidence: 0.8,
    evidence: "const value = 1;",
  };
}

const input = {
  repoFullName: "acme/api",
  prNumber: 1,
  prTitle: "change",
  prBody: null,
  author: "dev",
  baseRef: "main",
  headRef: "feature",
  headSha: "a".repeat(40),
  files: [fileA, fileB],
  omittedFiles: 0,
  semgrepFindings: [],
};

function analyzerWith(callModel: ModelCaller): ReviewerAnalyzer {
  return new ReviewerAnalyzer({
    apiKey: "test-key",
    model: "test-model",
    maxTokens: 8192,
    maxDiffChars: 100_000,
    callModel,
  });
}

describe("ReviewerAnalyzer truncation handling", () => {
  it("discards a truncated payload and splits the batch in half", async () => {
    const tokenBudgets: number[] = [];
    let call = 0;

    const callModel: ModelCaller = async ({ maxTokens }) => {
      tokenBudgets.push(maxTokens);
      call += 1;

      if (call === 1) {
        return {
          stopReason: "max_tokens",
          toolCalled: true,
          toolInput: { findings: [finding("src/a.ts", "partial result")] },
          usage: { inputTokens: 100, outputTokens: 10 },
        };
      }

      const path = call === 2 ? "src/a.ts" : "src/b.ts";
      return {
        stopReason: "tool_use",
        toolCalled: true,
        toolInput: { findings: [finding(path, `recovered ${path}`)] },
        usage: { inputTokens: 50, outputTokens: 5 },
      };
    };

    const result = await analyzerWith(callModel).analyze(input);

    expect(tokenBudgets).toEqual([8192, 8192, 8192]);
    expect(result.findings.map((entry) => entry.title)).toEqual([
      "recovered src/a.ts",
      "recovered src/b.ts",
    ]);
    expect(result.findings.some((entry) => entry.title === "partial result")).toBe(false);
    expect(result.truncatedBatches).toBe(1);
    expect(result.failedBatches).toBe(0);
    expect(result.failedModelCalls).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
  });

  it("retries a single file with a larger output budget", async () => {
    const tokenBudgets: number[] = [];

    const callModel: ModelCaller = async ({ maxTokens }) => {
      tokenBudgets.push(maxTokens);
      if (tokenBudgets.length === 1) {
        return {
          stopReason: "max_tokens",
          toolCalled: true,
          toolInput: { findings: [finding("src/a.ts", "partial result")] },
          usage: { inputTokens: 10, outputTokens: 2 },
        };
      }
      return {
        stopReason: "tool_use",
        toolCalled: true,
        toolInput: { findings: [finding("src/a.ts", "recovered single file")] },
        usage: { inputTokens: 20, outputTokens: 4 },
      };
    };

    const result = await analyzerWith(callModel).analyze({
      ...input,
      files: [fileA],
    });

    expect(tokenBudgets).toEqual([8192, 16384]);
    expect(result.findings.map((entry) => entry.title)).toEqual([
      "recovered single file",
    ]);
    expect(result.truncatedBatches).toBe(1);
    expect(result.failedModelCalls).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 6 });
  });

  it("reports a failed batch when the model does not call the tool", async () => {
    const callModel: ModelCaller = async () => ({
      stopReason: "end_turn",
      toolCalled: false,
      usage: { inputTokens: 5, outputTokens: 1 },
    });

    const result = await analyzerWith(callModel).analyze(input);

    expect(result.failedBatches).toBe(1);
    expect(result.failedModelCalls).toBe(1);
    expect(result.findings).toHaveLength(0);
    expect(result.errors[0]).toContain("did not call submit_findings");
  });

  it("fails after the token budget cannot grow further", async () => {
    const tokenBudgets: number[] = [];
    const callModel: ModelCaller = async ({ maxTokens }) => {
      tokenBudgets.push(maxTokens);
      return {
        stopReason: "max_tokens",
        toolCalled: true,
        toolInput: { findings: [] },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };

    const result = await analyzerWith(callModel).analyze({
      ...input,
      files: [fileA],
    });

    expect(tokenBudgets).toEqual([8192, 16384, 32000]);
    expect(result.failedBatches).toBe(1);
    expect(result.failedModelCalls).toBe(3);
    expect(result.truncatedBatches).toBe(1);
    expect(result.errors[0]).toContain("could not be recovered");
  });
});
