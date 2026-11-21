import "dotenv/config";
import path from "node:path";
import process from "node:process";
import pino from "pino";
import { ConfigError, loadLlmConfig } from "../config.js";
import {
  compareSnapshots,
  createBaseline,
  loadBaseline,
  saveBaseline,
  type BaselineComparison,
} from "./baseline.js";
import { evaluate, type EvalReport, type SourceSummary } from "./evaluate.js";

interface CliOptions {
  casesDir: string;
  baselinePath: string;
  threshold?: number;
  model?: string;
  json: boolean;
  semgrep: boolean;
  saveBaseline: boolean;
  verbose: boolean;
}

const USAGE = `Usage: npm run eval -- [options]

Runs the labeled fixture cases through the review pipeline and reports
precision, recall, F1 and confidence calibration. Requires ANTHROPIC_API_KEY.

Options:
  --cases <dir>          Fixture directory (default: fixtures/eval)
  --baseline <path>      Baseline file (default: <cases>/baseline.json)
  --threshold <0..1>     Confidence cutoff (default: REVIEW_CONFIDENCE_THRESHOLD)
  --model <id>           Override ANTHROPIC_MODEL
  --json                 Print the report and baseline comparison as JSON
  --no-semgrep           Skip the static-analysis baseline
  --no-save-baseline     Do not write the current run to the baseline file
  --verbose              List missed labels and false positives per case
  --help                 Show this help
`;

function parseArgs(argv: string[]): CliOptions {
  let casesDir = path.join("fixtures", "eval");
  let baselinePath: string | undefined;
  let threshold: number | undefined;
  let model: string | undefined;
  let json = false;
  let semgrep = true;
  let saveBaseline = true;
  let verbose = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--cases":
        if (!next) throw new Error("--cases requires a path");
        casesDir = next;
        index += 1;
        break;
      case "--baseline":
        if (!next) throw new Error("--baseline requires a path");
        baselinePath = next;
        index += 1;
        break;
      case "--threshold": {
        const parsed = Number(next);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          throw new Error("--threshold must be between 0 and 1");
        }
        threshold = parsed;
        index += 1;
        break;
      }
      case "--model":
        if (!next) throw new Error("--model requires an id");
        model = next;
        index += 1;
        break;
      case "--json":
        json = true;
        break;
      case "--no-semgrep":
        semgrep = false;
        break;
      case "--no-save-baseline":
        saveBaseline = false;
        break;
      case "--verbose":
        verbose = true;
        break;
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    casesDir,
    baselinePath: baselinePath ?? path.join(casesDir, "baseline.json"),
    ...(threshold !== undefined ? { threshold } : {}),
    ...(model ? { model } : {}),
    json,
    semgrep,
    saveBaseline,
    verbose,
  };
}

function pct(value: number): string {
  return (value * 100).toFixed(1).padStart(6);
}

function signedPoints(value: number): string {
  const points = value * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)} pts`;
}

function metricLine(label: string, summary: SourceSummary): string {
  return `${label.padEnd(22)} P ${pct(summary.precision)}  R ${pct(summary.recall)}  F1 ${pct(
    summary.f1,
  )}  TP ${String(summary.truePositives).padStart(2)}  FP ${String(
    summary.falsePositives,
  ).padStart(2)}  FN ${String(summary.falseNegatives).padStart(2)}`;
}

function printReport(
  report: EvalReport,
  comparison: BaselineComparison | null,
  baselinePath: string,
  saved: boolean,
  verbose: boolean,
): void {
  const labeled = report.cases.filter((entry) => entry.labels > 0).length;

  console.log(
    `\nEvaluation: ${report.cases.length} cases (${labeled} labeled, ${
      report.cases.length - labeled
    } clean) · ${report.model} · threshold ${report.threshold.toFixed(2)}`,
  );
  console.log("");

  const header = `${"Case".padEnd(26)}${"Labels".padStart(7)}${"Preds".padStart(
    7,
  )}${"P".padStart(7)}${"R".padStart(7)}${"F1".padStart(7)}${"TP".padStart(
    5,
  )}${"FP".padStart(5)}${"FN".padStart(5)}`;
  console.log(header);
  console.log("-".repeat(header.length));

  for (const entry of report.cases) {
    console.log(
      `${entry.name.padEnd(26)}${String(entry.labels).padStart(7)}${String(
        entry.predictions,
      ).padStart(7)}${pct(entry.merged.precision)}${pct(entry.merged.recall)}${pct(
        entry.merged.f1,
      )}${String(entry.merged.truePositives).padStart(5)}${String(
        entry.merged.falsePositives,
      ).padStart(5)}${String(entry.merged.falseNegatives).padStart(5)}`,
    );
  }

  console.log("");
  console.log(metricLine("Merged (LLM + Semgrep)", report.aggregate.merged));
  console.log(metricLine("LLM only", report.aggregate.llm));
  if (report.aggregate.semgrep) {
    console.log(
      metricLine(
        `Semgrep only (${report.aggregate.semgrepCases} scanned)`,
        report.aggregate.semgrep,
      ),
    );
  } else {
    console.log(`${"Semgrep only".padEnd(22)} not run or unavailable`);
  }

  console.log(
    `\nCalibration: ECE ${(report.calibration.expectedCalibrationError * 100).toFixed(
      1,
    )}% over ${report.calibration.total} prediction${
      report.calibration.total === 1 ? "" : "s"
    }`,
  );
  for (const bucket of report.calibration.buckets) {
    if (bucket.total === 0 || bucket.precision === null) continue;
    console.log(
      `  ${bucket.label}  n=${String(bucket.total).padStart(2)}  precision ${(
        bucket.precision * 100
      ).toFixed(1)}%`,
    );
  }

  if (verbose) {
    for (const entry of report.cases) {
      for (const miss of entry.misses) {
        console.log(`  MISS  ${entry.name}  ${miss.path}:${miss.line} (${miss.category})`);
      }
      for (const falsePositive of entry.falsePositives) {
        console.log(
          `  FALSE ${entry.name}  ${falsePositive.path}:${falsePositive.line} ${falsePositive.title} (${Math.round(
            falsePositive.confidence * 100,
          )}%)`,
        );
      }
    }
  }

  console.log(
    `\nTokens: ${report.usage.inputTokens.toLocaleString()} in / ${report.usage.outputTokens.toLocaleString()} out · ${(
      report.durationMs / 1000
    ).toFixed(1)}s`,
  );

  if (report.warnings.length > 0) {
    console.log(`Warnings: ${report.warnings.length} (use --json for details)`);
  }

  if (comparison) {
    console.log(
      `\nBaseline ${baselinePath} (${comparison.baselineGeneratedAt.slice(0, 10)}): ` +
        `P ${signedPoints(comparison.precisionDelta)}, R ${signedPoints(
          comparison.recallDelta,
        )}, F1 ${signedPoints(comparison.f1Delta)}, ECE ${
          comparison.calibrationDelta >= 0 ? "+" : ""
        }${(comparison.calibrationDelta * 100).toFixed(1)} pts`,
    );
    for (const changed of comparison.changedCases.slice(0, 5)) {
      console.log(`  ${changed.name}: F1 ${signedPoints(changed.f1Delta)}`);
    }
  }

  if (saved) console.log(`Saved baseline to ${baselinePath}`);
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n`);
    console.error(USAGE);
    process.exit(2);
  }

  let config;
  try {
    config = loadLlmConfig();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : String(error));
    process.exit(1);
  }

  const anthropic = options.model
    ? { ...config.anthropic, model: options.model }
    : config.anthropic;

  const report = await evaluate(
    {
      casesDir: options.casesDir,
      anthropic,
      review: { maxDiffChars: config.review.maxDiffChars },
      semgrep: config.semgrep,
      threshold: options.threshold ?? config.review.confidenceThreshold,
      semgrepEnabled: options.semgrep,
      logger: pino({ level: process.env.LOG_LEVEL ?? "silent" }),
      onCaseStart: (name, index, total) => {
        process.stderr.write(`[${index}/${total}] ${name}\n`);
      },
    },
    {},
  );

  const previous = await loadBaseline(options.baselinePath);
  const snapshot = createBaseline(report);
  const comparison = previous ? compareSnapshots(snapshot, previous) : null;
  const baselineSaved = options.saveBaseline && report.modelFailures === 0;

  if (baselineSaved) {
    await saveBaseline(options.baselinePath, snapshot);
  } else if (options.saveBaseline) {
    process.stderr.write(
      `Baseline not saved: ${report.modelFailures} case(s) failed to reach the model.\n`,
    );
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          report,
          baseline: comparison,
          baselinePath: options.baselinePath,
          baselineSaved,
        },
        null,
        2,
      ),
    );
    return;
  }

  printReport(
    report,
    comparison,
    options.baselinePath,
    baselineSaved,
    options.verbose,
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
