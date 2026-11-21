import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvalReport } from "./evaluate.js";
import type { MetricsWithCounts } from "./metrics.js";

export interface BaselineSnapshot {
  version: 1;
  generatedAt: string;
  model: string;
  threshold: number;
  merged: MetricsWithCounts;
  llm: MetricsWithCounts;
  semgrep: MetricsWithCounts | null;
  expectedCalibrationError: number;
  cases: Record<string, MetricsWithCounts>;
}

export interface BaselineComparison {
  baselineGeneratedAt: string;
  precisionDelta: number;
  recallDelta: number;
  f1Delta: number;
  calibrationDelta: number;
  changedCases: Array<{ name: string; f1Delta: number }>;
}

export function createBaseline(report: EvalReport): BaselineSnapshot {
  return {
    version: 1,
    generatedAt: report.generatedAt,
    model: report.model,
    threshold: report.threshold,
    merged: report.aggregate.merged,
    llm: report.aggregate.llm,
    semgrep: report.aggregate.semgrep,
    expectedCalibrationError: report.calibration.expectedCalibrationError,
    cases: Object.fromEntries(
      report.cases.map((entry) => [entry.name, entry.merged]),
    ),
  };
}

/** A baseline is only trustworthy when every model batch completed. */
export function canSaveBaseline(report: EvalReport): boolean {
  return report.failedModelBatches === 0;
}

/** Compares current aggregate metrics with a saved baseline. */
export function compareSnapshots(
  current: BaselineSnapshot,
  baseline: BaselineSnapshot,
): BaselineComparison {
  const changedCases: Array<{ name: string; f1Delta: number }> = [];

  for (const [name, metrics] of Object.entries(current.cases)) {
    const previous = baseline.cases[name];
    if (!previous) {
      changedCases.push({ name, f1Delta: metrics.f1 });
      continue;
    }
    const delta = metrics.f1 - previous.f1;
    if (Math.abs(delta) > 0.005) changedCases.push({ name, f1Delta: delta });
  }

  for (const name of Object.keys(baseline.cases)) {
    if (!current.cases[name]) {
      changedCases.push({ name, f1Delta: -baseline.cases[name].f1 });
    }
  }

  changedCases.sort((left, right) => Math.abs(right.f1Delta) - Math.abs(left.f1Delta));

  return {
    baselineGeneratedAt: baseline.generatedAt,
    precisionDelta: current.merged.precision - baseline.merged.precision,
    recallDelta: current.merged.recall - baseline.merged.recall,
    f1Delta: current.merged.f1 - baseline.merged.f1,
    calibrationDelta:
      current.expectedCalibrationError - baseline.expectedCalibrationError,
    changedCases,
  };
}

export async function saveBaseline(
  filePath: string,
  snapshot: BaselineSnapshot,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export async function loadBaseline(
  filePath: string,
): Promise<BaselineSnapshot | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as BaselineSnapshot;
    if (parsed.version !== 1 || typeof parsed.merged?.f1 !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
