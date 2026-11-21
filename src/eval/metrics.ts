import { normalizePath } from "../github/diff.js";
import { SEVERITY_RANK } from "../review/findings.js";
import type { Category, Finding, Severity } from "../types.js";

export interface EvalLabel {
  path: string;
  line: number;
  category: Category;
  minSeverity?: Severity;
  note?: string;
}

export interface MatchedPair {
  label: EvalLabel;
  prediction: Finding;
  lineDistance: number;
  /** Whether the predicted severity reaches the label's floor. */
  severityMet: boolean;
}

export interface MatchOutcome {
  pairs: MatchedPair[];
  falsePositives: Finding[];
  falseNegatives: EvalLabel[];
}

export interface Counts {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

export interface Metrics {
  precision: number;
  recall: number;
  f1: number;
}

export interface MetricsWithCounts extends Metrics, Counts {}

/**
 * Strict one-to-one matching: same repository-relative path, same category,
 * and a head line within `lineTolerance` (default 2). A severity below the
 * label's floor is reported separately but still counts as a detection.
 */
export function matchFindings(
  predictions: Finding[],
  labels: EvalLabel[],
  options: { lineTolerance?: number } = {},
): MatchOutcome {
  const tolerance = options.lineTolerance ?? 2;
  const candidates: Array<{
    labelIndex: number;
    predictionIndex: number;
    distance: number;
    confidence: number;
  }> = [];

  labels.forEach((label, labelIndex) => {
    predictions.forEach((prediction, predictionIndex) => {
      if (normalizePath(prediction.path) !== normalizePath(label.path)) return;
      if (prediction.category !== label.category) return;

      const distance = Math.abs(prediction.line - label.line);
      if (distance > tolerance) return;

      candidates.push({
        labelIndex,
        predictionIndex,
        distance,
        confidence: prediction.confidence,
      });
    });
  });

  // Closest line wins; ties prefer higher confidence. Greedy over all
  // candidates avoids letting label order decide overlapping matches.
  candidates.sort(
    (left, right) =>
      left.distance - right.distance ||
      right.confidence - left.confidence ||
      left.labelIndex - right.labelIndex ||
      left.predictionIndex - right.predictionIndex,
  );

  const usedLabels = new Set<number>();
  const usedPredictions = new Set<number>();
  const pairs: MatchedPair[] = [];

  for (const candidate of candidates) {
    if (
      usedLabels.has(candidate.labelIndex) ||
      usedPredictions.has(candidate.predictionIndex)
    ) {
      continue;
    }

    usedLabels.add(candidate.labelIndex);
    usedPredictions.add(candidate.predictionIndex);

    const label = labels[candidate.labelIndex];
    const prediction = predictions[candidate.predictionIndex];
    if (!label || !prediction) continue;

    pairs.push({
      label,
      prediction,
      lineDistance: candidate.distance,
      severityMet:
        !label.minSeverity ||
        SEVERITY_RANK[prediction.severity] >= SEVERITY_RANK[label.minSeverity],
    });
  }

  return {
    pairs,
    falsePositives: predictions.filter(
      (_prediction, index) => !usedPredictions.has(index),
    ),
    falseNegatives: labels.filter((_label, index) => !usedLabels.has(index)),
  };
}

export function computeMetrics(counts: Counts): Metrics {
  const { truePositives, falsePositives, falseNegatives } = counts;

  // With no predictions there are no false positives, so precision is 1;
  // with no labels there is nothing to miss, so recall is 1.
  const precision =
    truePositives + falsePositives === 0
      ? 1
      : truePositives / (truePositives + falsePositives);
  const recall =
    truePositives + falseNegatives === 0
      ? 1
      : truePositives / (truePositives + falseNegatives);
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);

  return { precision, recall, f1 };
}

export interface ScoredPredictions {
  outcome: MatchOutcome;
  metrics: MetricsWithCounts;
  severityBelowFloor: number;
}

export function scorePredictions(
  predictions: Finding[],
  labels: EvalLabel[],
  options: { lineTolerance?: number } = {},
): ScoredPredictions {
  const outcome = matchFindings(predictions, labels, options);
  const counts: Counts = {
    truePositives: outcome.pairs.length,
    falsePositives: outcome.falsePositives.length,
    falseNegatives: outcome.falseNegatives.length,
  };

  return {
    outcome,
    metrics: { ...counts, ...computeMetrics(counts) },
    severityBelowFloor: outcome.pairs.filter((pair) => !pair.severityMet).length,
  };
}

export function sumCounts(counts: Counts[]): Counts {
  return counts.reduce(
    (total, entry) => ({
      truePositives: total.truePositives + entry.truePositives,
      falsePositives: total.falsePositives + entry.falsePositives,
      falseNegatives: total.falseNegatives + entry.falseNegatives,
    }),
    { truePositives: 0, falsePositives: 0, falseNegatives: 0 },
  );
}

export interface CalibrationSample {
  confidence: number;
  matched: boolean;
}

export interface CalibrationBucket {
  label: string;
  minConfidence: number;
  maxConfidence: number;
  total: number;
  matched: number;
  precision: number | null;
  averageConfidence: number | null;
}

export interface CalibrationResult {
  buckets: CalibrationBucket[];
  expectedCalibrationError: number;
  total: number;
}

const CALIBRATION_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "0.0-0.5", min: 0, max: 0.5 },
  { label: "0.5-0.6", min: 0.5, max: 0.6 },
  { label: "0.6-0.7", min: 0.6, max: 0.7 },
  { label: "0.7-0.8", min: 0.7, max: 0.8 },
  { label: "0.8-0.9", min: 0.8, max: 0.9 },
  { label: "0.9-1.0", min: 0.9, max: 1.000_000_1 },
];

/**
 * Buckets predictions by confidence and compares confidence with observed
 * precision. Expected calibration error is the count-weighted gap.
 */
export function calibrationBuckets(samples: CalibrationSample[]): CalibrationResult {
  const buckets: CalibrationBucket[] = CALIBRATION_BUCKETS.map((bucket) => ({
    label: bucket.label,
    minConfidence: bucket.min,
    maxConfidence: Math.min(bucket.max, 1),
    total: 0,
    matched: 0,
    precision: null,
    averageConfidence: null,
  }));

  const confidenceSums = new Array<number>(buckets.length).fill(0);

  for (const sample of samples) {
    const index = CALIBRATION_BUCKETS.findIndex(
      (bucket) => sample.confidence >= bucket.min && sample.confidence < bucket.max,
    );
    if (index === -1) continue;

    const bucket = buckets[index];
    if (!bucket) continue;
    bucket.total += 1;
    if (sample.matched) bucket.matched += 1;
    confidenceSums[index] = (confidenceSums[index] ?? 0) + sample.confidence;
  }

  let expectedCalibrationError = 0;

  buckets.forEach((bucket, index) => {
    if (bucket.total === 0) return;
    bucket.precision = bucket.matched / bucket.total;
    bucket.averageConfidence = (confidenceSums[index] ?? 0) / bucket.total;
    if (samples.length > 0) {
      expectedCalibrationError +=
        (bucket.total / samples.length) *
        Math.abs(bucket.precision - bucket.averageConfidence);
    }
  });

  return { buckets, expectedCalibrationError, total: samples.length };
}
