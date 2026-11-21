import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canSaveBaseline,
  compareSnapshots,
  createBaseline,
  loadBaseline,
  saveBaseline,
} from "../src/eval/baseline.js";
import type { EvalReport } from "../src/eval/evaluate.js";
import type { MetricsWithCounts } from "../src/eval/metrics.js";

function metrics(overrides: Partial<MetricsWithCounts> = {}): MetricsWithCounts {
  return {
    truePositives: 3,
    falsePositives: 1,
    falseNegatives: 1,
    precision: 0.75,
    recall: 0.75,
    f1: 0.75,
    ...overrides,
  };
}

function report(overrides: Partial<EvalReport> = {}): EvalReport {
  const merged = metrics();
  return {
    generatedAt: "2026-11-21T00:00:00.000Z",
    model: "model-a",
    threshold: 0.6,
    cases: [
      {
        name: "sql-injection",
        labels: 2,
        predictions: 2,
        merged,
        llm: merged,
        semgrep: null,
        severityBelowFloor: 0,
        usage: { inputTokens: 10, outputTokens: 5 },
        misses: [],
        falsePositives: [],
      },
    ],
    aggregate: {
      merged: { ...merged, cases: 1 },
      llm: { ...merged, cases: 1 },
      semgrep: null,
      semgrepCases: 0,
    },
    calibration: {
      buckets: [],
      expectedCalibrationError: 0.12,
      total: 4,
    },
    usage: { inputTokens: 10, outputTokens: 5 },
    durationMs: 100,
    failedModelBatches: 0,
    warnings: [],
    ...overrides,
  };
}

describe("baseline snapshots", () => {
  it("refuses a baseline when any model batch failed", () => {
    expect(canSaveBaseline(report())).toBe(true);
    expect(canSaveBaseline(report({ failedModelBatches: 1 }))).toBe(false);
  });

  it("captures aggregate, per-case and calibration values", () => {
    const snapshot = createBaseline(report());

    expect(snapshot.version).toBe(1);
    expect(snapshot.model).toBe("model-a");
    expect(snapshot.merged.f1).toBe(0.75);
    expect(snapshot.cases["sql-injection"]?.precision).toBe(0.75);
    expect(snapshot.expectedCalibrationError).toBe(0.12);
  });

  it("reports deltas and changed cases against a previous snapshot", () => {
    const baseline = createBaseline(report());
    const improvedCase = metrics({
      truePositives: 4,
      falseNegatives: 0,
      precision: 0.8,
      recall: 1,
      f1: 0.889,
    });
    const current = createBaseline(
      report({
        aggregate: {
          merged: { ...improvedCase, cases: 1 },
          llm: { ...improvedCase, cases: 1 },
          semgrep: null,
          semgrepCases: 0,
        },
        cases: [
          {
            name: "sql-injection",
            labels: 2,
            predictions: 2,
            merged: improvedCase,
            llm: improvedCase,
            semgrep: null,
            severityBelowFloor: 0,
            usage: { inputTokens: 10, outputTokens: 5 },
            misses: [],
            falsePositives: [],
          },
        ],
        calibration: { buckets: [], expectedCalibrationError: 0.05, total: 4 },
      }),
    );

    const comparison = compareSnapshots(current, baseline);

    expect(comparison.precisionDelta).toBeCloseTo(0.05, 5);
    expect(comparison.recallDelta).toBeCloseTo(0.25, 5);
    expect(comparison.f1Delta).toBeCloseTo(0.139, 3);
    expect(comparison.calibrationDelta).toBeCloseTo(-0.07, 5);
    expect(comparison.changedCases).toEqual([
      { name: "sql-injection", f1Delta: expect.closeTo(0.139, 3) },
    ]);
  });

  it("round-trips a baseline through disk and ignores a missing file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "eval-baseline-"));
    const file = path.join(dir, "nested", "baseline.json");

    try {
      const snapshot = createBaseline(report());
      await saveBaseline(file, snapshot);
      await expect(loadBaseline(file)).resolves.toEqual(snapshot);
      await expect(loadBaseline(path.join(dir, "missing.json"))).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
