import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { evaluate } from "../src/eval/evaluate.js";
import type { AnalyzeInput, AnalyzeResult } from "../src/review/analyzer.js";
import type { LlmFinding } from "../src/review/findings.js";

const rawFinding: LlmFinding = {
  path: "src/bug.ts",
  line: 2,
  severity: "high",
  category: "bug",
  title: "Broken constant",
  body: "The added constant breaks the invariant for callers.",
  confidence: 0.9,
  evidence: "const bad = 1;",
};

let root: string;

async function writeCase(
  name: string,
  filePath: string,
  addedLine: string,
  expected: unknown[],
): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "diff.patch"),
    [
      `diff --git a/${filePath} b/${filePath}`,
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      "@@ -1,2 +1,3 @@",
      " before",
      `+${addedLine}`,
      " after",
    ].join("\n"),
    "utf8",
  );
  const repoPath = path.join(dir, "repo", ...filePath.split("/"));
  await mkdir(path.dirname(repoPath), { recursive: true });
  await writeFile(
    repoPath,
    ["before", addedLine, "after"].join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({ title: name, expected }),
    "utf8",
  );
}

const analyze = vi.fn(async (input: AnalyzeInput): Promise<AnalyzeResult> => {
  const buggy = input.files.some((file) => file.path === "src/bug.ts");
  return {
    findings: buggy ? [rawFinding] : [],
    summaries: [],
    errors: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    batches: 1,
    failedBatches: 0,
    failedModelCalls: 0,
    truncatedBatches: 0,
  };
});

function run(threshold: number) {
  return evaluate(
    {
      casesDir: root,
      anthropic: { apiKey: "test-key", model: "test-model", maxTokens: 2048 },
      maxDiffChars: 10_000,
      contextLines: 30,
      maxContextChars: 12_000,
      semgrep: {
        enabled: false,
        config: "unused",
        timeoutMs: 1_000,
        maxFileBytes: 10_000,
      },
      threshold,
    },
    { createAnalyzer: () => ({ analyze }) },
  );
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "eval-run-"));
  await writeCase("buggy", "src/bug.ts", "const bad = 1;", [
    {
      path: "src/bug.ts",
      line: 2,
      category: "bug",
      minSeverity: "high",
    },
  ]);
  await writeCase("clean", "src/clean.ts", "const fine = 2;", []);
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("evaluate", () => {
  it("scores the posted findings across labeled and clean cases", async () => {
    const report = await run(0.6);

    expect(report.cases).toHaveLength(2);
    const buggy = report.cases.find((entry) => entry.name === "buggy");
    const clean = report.cases.find((entry) => entry.name === "clean");

    expect(buggy?.merged).toMatchObject({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
    });
    expect(buggy?.predictions).toBe(1);
    expect(clean?.predictions).toBe(0);
    expect(clean?.merged).toMatchObject({ falsePositives: 0, precision: 1 });

    expect(report.aggregate.merged).toMatchObject({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      cases: 2,
    });
    expect(report.aggregate.semgrep).toBeNull();
    expect(report.aggregate.semgrepCases).toBe(0);
    expect(report.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(report.failedModelBatches).toBe(0);
    expect(report.calibration.total).toBe(1);
    expect(report.calibration.expectedCalibrationError).toBeCloseTo(0.1, 5);
  });

  it("counts cases where the model failed so unreliable baselines are not saved", async () => {
    const failing = vi.fn(async (): Promise<AnalyzeResult> => ({
      findings: [],
      summaries: [],
      errors: ["model request failed: unauthorized"],
      usage: { inputTokens: 0, outputTokens: 0 },
      batches: 2,
      failedBatches: 1,
      failedModelCalls: 1,
      truncatedBatches: 0,
    }));

    const report = await evaluate(
      {
        casesDir: root,
        anthropic: { apiKey: "test-key", model: "test-model", maxTokens: 2048 },
        maxDiffChars: 10_000,
        contextLines: 30,
        maxContextChars: 12_000,
        semgrep: {
          enabled: false,
          config: "unused",
          timeoutMs: 1_000,
          maxFileBytes: 10_000,
        },
        threshold: 0.6,
      },
      { createAnalyzer: () => ({ analyze: failing }) },
    );

    expect(report.failedModelBatches).toBe(2);
  });

  it("passes head-revision sources to the analyzer for context", async () => {
    analyze.mockClear();
    await run(0.6);

    const inputs = analyze.mock.calls.map((call) => call[0] as AnalyzeInput);
    expect(inputs).toHaveLength(2);
    expect(inputs.every((input) => input.sources?.length === 1)).toBe(true);
  });

  it("applies the confidence threshold to posted metrics but not calibration", async () => {
    const report = await run(0.95);
    const buggy = report.cases.find((entry) => entry.name === "buggy");

    expect(buggy?.predictions).toBe(0);
    expect(buggy?.merged).toMatchObject({
      truePositives: 0,
      falseNegatives: 1,
      precision: 1,
      recall: 0,
      f1: 0,
    });
    expect(buggy?.misses).toHaveLength(1);
    expect(report.calibration.total).toBe(1);
    expect(report.calibration.buckets.find((bucket) => bucket.label === "0.9-1.0"))
      .toMatchObject({ total: 1, matched: 1 });
  });
});
