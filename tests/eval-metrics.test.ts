import { describe, expect, it } from "vitest";
import {
  calibrationBuckets,
  computeMetrics,
  matchFindings,
  scorePredictions,
  sumCounts,
  type EvalLabel,
} from "../src/eval/metrics.js";
import type { Finding } from "../src/types.js";

function prediction(overrides: Partial<Finding> = {}): Finding {
  return {
    path: "src/a.ts",
    line: 10,
    severity: "high",
    category: "security",
    title: "Finding",
    body: "The change introduces a defect.",
    confidence: 0.9,
    source: "llm",
    ...overrides,
  };
}

function label(overrides: Partial<EvalLabel> = {}): EvalLabel {
  return { path: "src/a.ts", line: 10, category: "security", ...overrides };
}

describe("matchFindings", () => {
  it("matches the same path and category within two lines", () => {
    const outcome = matchFindings(
      [prediction({ path: "./src/a.ts", line: 12 })],
      [label({ line: 10 })],
    );

    expect(outcome.pairs).toHaveLength(1);
    expect(outcome.pairs[0]?.lineDistance).toBe(2);
    expect(outcome.falsePositives).toHaveLength(0);
    expect(outcome.falseNegatives).toHaveLength(0);
  });

  it("rejects lines beyond the tolerance", () => {
    const outcome = matchFindings([prediction({ line: 13 })], [label({ line: 10 })]);

    expect(outcome.pairs).toHaveLength(0);
    expect(outcome.falsePositives).toHaveLength(1);
    expect(outcome.falseNegatives).toHaveLength(1);
  });

  it("requires the category and path to match exactly", () => {
    expect(
      matchFindings([prediction({ category: "bug" })], [label()]).pairs,
    ).toHaveLength(0);
    expect(
      matchFindings([prediction({ path: "src/b.ts" })], [label()]).pairs,
    ).toHaveLength(0);
  });

  it("matches one-to-one and prefers the closest prediction", () => {
    const outcome = matchFindings(
      [
        prediction({ line: 9, confidence: 0.99 }),
        prediction({ line: 11, confidence: 0.4 }),
      ],
      [label({ line: 10 })],
    );

    expect(outcome.pairs).toHaveLength(1);
    expect(outcome.pairs[0]?.prediction.line).toBe(9);
    expect(outcome.falsePositives).toHaveLength(1);
  });

  it("does not reuse a prediction for two labels", () => {
    const outcome = matchFindings(
      [prediction({ line: 11 })],
      [label({ line: 10 }), label({ line: 12 })],
    );

    expect(outcome.pairs).toHaveLength(1);
    expect(outcome.falseNegatives).toHaveLength(1);
  });

  it("reports a severity below the label floor but still counts the detection", () => {
    const result = scorePredictions(
      [prediction({ severity: "medium" })],
      [label({ minSeverity: "high" })],
    );

    expect(result.metrics.truePositives).toBe(1);
    expect(result.metrics.precision).toBe(1);
    expect(result.severityBelowFloor).toBe(1);
    expect(result.outcome.pairs[0]?.severityMet).toBe(false);
  });
});

describe("computeMetrics", () => {
  it("computes precision, recall and F1", () => {
    const metrics = computeMetrics({
      truePositives: 3,
      falsePositives: 2,
      falseNegatives: 1,
    });

    expect(metrics.precision).toBeCloseTo(0.6, 5);
    expect(metrics.recall).toBeCloseTo(0.75, 5);
    expect(metrics.f1).toBeCloseTo(0.6667, 4);
  });

  it("defines empty edge cases explicitly", () => {
    expect(
      computeMetrics({ truePositives: 0, falsePositives: 0, falseNegatives: 2 }),
    ).toEqual({ precision: 1, recall: 0, f1: 0 });

    expect(
      computeMetrics({ truePositives: 0, falsePositives: 2, falseNegatives: 0 }),
    ).toEqual({ precision: 0, recall: 1, f1: 0 });
  });

  it("sums counts across cases", () => {
    expect(
      sumCounts([
        { truePositives: 1, falsePositives: 2, falseNegatives: 3 },
        { truePositives: 4, falsePositives: 5, falseNegatives: 6 },
      ]),
    ).toEqual({ truePositives: 5, falsePositives: 7, falseNegatives: 9 });
  });
});

describe("calibrationBuckets", () => {
  it("groups predictions by confidence and computes expected calibration error", () => {
    const result = calibrationBuckets([
      { confidence: 0.65, matched: true },
      { confidence: 0.62, matched: false },
      { confidence: 0.95, matched: true },
      { confidence: 0.92, matched: true },
    ]);

    const mid = result.buckets.find((bucket) => bucket.label === "0.6-0.7");
    expect(mid?.total).toBe(2);
    expect(mid?.matched).toBe(1);
    expect(mid?.precision).toBeCloseTo(0.5, 5);
    expect(mid?.averageConfidence).toBeCloseTo(0.635, 5);

    const high = result.buckets.find((bucket) => bucket.label === "0.9-1.0");
    expect(high?.total).toBe(2);
    expect(high?.precision).toBe(1);

    // 0.5*|0.5-0.635| + 0.5*|1-0.935| = 0.1
    expect(result.expectedCalibrationError).toBeCloseTo(0.1, 5);
    expect(result.total).toBe(4);
  });

  it("puts a confidence of exactly 1.0 in the top bucket", () => {
    const result = calibrationBuckets([{ confidence: 1, matched: true }]);
    expect(result.buckets.at(-1)?.total).toBe(1);
  });

  it("handles an empty sample set", () => {
    const result = calibrationBuckets([]);
    expect(result.total).toBe(0);
    expect(result.expectedCalibrationError).toBe(0);
    expect(result.buckets.every((bucket) => bucket.precision === null)).toBe(true);
  });
});
