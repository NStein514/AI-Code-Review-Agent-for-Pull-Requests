import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { AnthropicConfig, ReviewConfig, SemgrepConfig } from "../config.js";
import {
  dedupeFindings,
  filterByConfidence,
  mergeSemgrepWithLlm,
  normalizeLlmFindings,
  normalizeSemgrepFindings,
} from "../review/findings.js";
import {
  ReviewerAnalyzer,
  type AnalyzerLike,
  type AnalyzerOptions,
} from "../review/analyzer.js";
import { runSemgrep, type SemgrepRunResult } from "../review/semgrep.js";
import type { Finding, TokenUsage } from "../types.js";
import { labelsForCase, loadEvalCases } from "./cases.js";
import {
  calibrationBuckets,
  computeMetrics,
  matchFindings,
  scorePredictions,
  sumCounts,
  type CalibrationBucket,
  type CalibrationSample,
  type Counts,
  type EvalLabel,
  type MetricsWithCounts,
} from "./metrics.js";

export interface EvalCaseReport {
  name: string;
  labels: number;
  predictions: number;
  merged: MetricsWithCounts;
  llm: MetricsWithCounts;
  semgrep: MetricsWithCounts | null;
  semgrepAvailable: boolean;
  severityBelowFloor: number;
  usage: TokenUsage;
  durationMs: number;
  misses: EvalLabel[];
  falsePositives: Array<{
    path: string;
    line: number;
    title: string;
    confidence: number;
  }>;
}

export interface SourceSummary extends MetricsWithCounts {
  cases: number;
}

export interface EvalReport {
  generatedAt: string;
  model: string;
  threshold: number;
  cases: EvalCaseReport[];
  aggregate: {
    merged: SourceSummary;
    llm: SourceSummary;
    semgrep: SourceSummary | null;
    semgrepCases: number;
  };
  calibration: {
    buckets: CalibrationBucket[];
    expectedCalibrationError: number;
    total: number;
  };
  usage: TokenUsage;
  durationMs: number;
  /** Cases where every model batch failed; used to refuse bad baselines. */
  modelFailures: number;
  warnings: string[];
}

export interface EvaluationOptions {
  casesDir: string;
  anthropic: AnthropicConfig;
  review: Pick<ReviewConfig, "maxDiffChars">;
  semgrep: SemgrepConfig;
  threshold: number;
  semgrepEnabled: boolean;
  logger?: Logger;
  onCaseStart?: (name: string, index: number, total: number) => void;
}

export interface EvaluationDependencies {
  createAnalyzer?: (options: AnalyzerOptions) => AnalyzerLike;
  runSemgrep?: typeof runSemgrep;
}

function countsOf(metrics: MetricsWithCounts): Counts {
  return {
    truePositives: metrics.truePositives,
    falsePositives: metrics.falsePositives,
    falseNegatives: metrics.falseNegatives,
  };
}

function summarize(counts: Counts, cases: number): SourceSummary {
  return { ...counts, ...computeMetrics(counts), cases };
}

function addUsage(...usages: TokenUsage[]): TokenUsage {
  return usages.reduce(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
}

function emptySemgrepRun(): SemgrepRunResult {
  return { available: false, findings: [], durationMs: 0, errorCount: 0 };
}

/**
 * Runs every case through the same normalization, merging and thresholding as
 * a real review, then scores the posted findings against the labels.
 */
export async function evaluate(
  options: EvaluationOptions,
  deps: EvaluationDependencies = {},
): Promise<EvalReport> {
  const startedAt = Date.now();
  const cases = await loadEvalCases(options.casesDir);

  const createAnalyzer =
    deps.createAnalyzer ??
    ((analyzerOptions: AnalyzerOptions) => new ReviewerAnalyzer(analyzerOptions));
  const analyzer = createAnalyzer({
    ...options.anthropic,
    maxDiffChars: options.review.maxDiffChars,
    ...(options.logger ? { logger: options.logger } : {}),
  });

  const runStatic = deps.runSemgrep ?? runSemgrep;
  const caseReports: EvalCaseReport[] = [];
  const calibrationSamples: CalibrationSample[] = [];
  const warnings: string[] = [];
  let modelFailures = 0;
  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  for (const [index, evalCase] of cases.entries()) {
    options.onCaseStart?.(evalCase.name, index + 1, cases.length);
    const caseStartedAt = Date.now();
    const labels = labelsForCase(evalCase.meta);

    let semgrepRun = emptySemgrepRun();
    if (options.semgrepEnabled && evalCase.repoFiles.length > 0) {
      semgrepRun = await runStatic({
        files: evalCase.repoFiles,
        config: options.semgrep.config,
        timeoutMs: options.semgrep.timeoutMs,
        ...(options.logger ? { logger: options.logger } : {}),
      });
    }

    const analysis = await analyzer.analyze({
      repoFullName: "eval/fixtures",
      prNumber: index + 1,
      prTitle: evalCase.meta.title ?? evalCase.name,
      prBody: evalCase.meta.description ?? null,
      author: "eval",
      baseRef: "main",
      headRef: "eval",
      headSha: createHash("sha1").update(evalCase.name).digest("hex"),
      files: evalCase.files,
      omittedFiles: 0,
      semgrepFindings: semgrepRun.findings,
    });

    const llm = normalizeLlmFindings(analysis.findings, evalCase.files).accepted;
    const semgrep = normalizeSemgrepFindings(semgrepRun.findings, evalCase.files).accepted;
    const merged = dedupeFindings(mergeSemgrepWithLlm(llm, semgrep));

    const postedLlm = filterByConfidence(llm, options.threshold).posted;
    const postedSemgrep = filterByConfidence(semgrep, options.threshold).posted;
    const postedMerged = filterByConfidence(merged, options.threshold).posted;

    const mergedScore = scorePredictions(postedMerged, labels);
    const llmScore = scorePredictions(postedLlm, labels);
    const semgrepScore = semgrepRun.available
      ? scorePredictions(postedSemgrep, labels)
      : null;

    const unfilteredMatch = matchFindings(merged, labels);
    const matchedPredictions = new Set(
      unfilteredMatch.pairs.map((pair) => pair.prediction),
    );
    for (const prediction of merged) {
      calibrationSamples.push({
        confidence: prediction.confidence,
        matched: matchedPredictions.has(prediction),
      });
    }

    totalUsage = addUsage(totalUsage, analysis.usage);
    if (analysis.batches > 0 && analysis.failedBatches >= analysis.batches) {
      modelFailures += 1;
    }

    warnings.push(
      ...analysis.errors.map((error) => `${evalCase.name}: ${error}`),
    );
    if (options.semgrepEnabled && semgrepRun.error) {
      warnings.push(`${evalCase.name}: semgrep: ${semgrepRun.error}`);
    }

    caseReports.push({
      name: evalCase.name,
      labels: labels.length,
      predictions: postedMerged.length,
      merged: mergedScore.metrics,
      llm: llmScore.metrics,
      semgrep: semgrepScore?.metrics ?? null,
      semgrepAvailable: semgrepRun.available,
      severityBelowFloor: mergedScore.severityBelowFloor,
      usage: analysis.usage,
      durationMs: Date.now() - caseStartedAt,
      misses: mergedScore.outcome.falseNegatives,
      falsePositives: mergedScore.outcome.falsePositives.map((finding) => ({
        path: finding.path,
        line: finding.line,
        title: finding.title,
        confidence: finding.confidence,
      })),
    });
  }

  const semgrepCases = caseReports.filter((report) => report.semgrepAvailable);
  const calibration = calibrationBuckets(calibrationSamples);

  return {
    generatedAt: new Date().toISOString(),
    model: options.anthropic.model,
    threshold: options.threshold,
    cases: caseReports,
    aggregate: {
      merged: summarize(
        sumCounts(caseReports.map((report) => countsOf(report.merged))),
        caseReports.length,
      ),
      llm: summarize(
        sumCounts(caseReports.map((report) => countsOf(report.llm))),
        caseReports.length,
      ),
      semgrep:
        semgrepCases.length > 0
          ? summarize(
              sumCounts(
                semgrepCases.map((report) =>
                  countsOf(report.semgrep ?? {
                    truePositives: 0,
                    falsePositives: 0,
                    falseNegatives: 0,
                    precision: 0,
                    recall: 0,
                    f1: 0,
                  }),
                ),
              ),
              semgrepCases.length,
            )
          : null,
      semgrepCases: semgrepCases.length,
    },
    calibration,
    usage: totalUsage,
    durationMs: Date.now() - startedAt,
    modelFailures,
    warnings,
  };
}
