import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ConfigError, loadLlmConfig } from "../config.js";
import { parseUnifiedDiff } from "../github/diff.js";
import type { SourceFile } from "../github/contents.js";
import { ReviewerAnalyzer } from "../review/analyzer.js";
import {
  capFindings,
  dedupeFindings,
  filterByConfidence,
  mergeSemgrepWithLlm,
  normalizeLlmFindings,
  normalizeSemgrepFindings,
} from "../review/findings.js";
import { runSemgrep } from "../review/semgrep.js";

interface CliOptions {
  diffPath: string;
  sourceDir?: string;
  semgrep: boolean;
  json: boolean;
  threshold?: number;
}

const USAGE = `Usage: npm run review:diff -- --diff <file.diff> [options]

Options:
  --diff <path>       Unified diff to review (required)
  --dir <path>        Source tree used for Semgrep; enables the baseline
  --no-semgrep        Skip Semgrep even when --dir is provided
  --threshold <0..1>  Override REVIEW_CONFIDENCE_THRESHOLD
  --json              Print the full result as JSON
  --help              Show this help
`;

function parseArgs(argv: string[]): CliOptions {
  let diffPath: string | undefined;
  let sourceDir: string | undefined;
  let semgrep = true;
  let json = false;
  let threshold: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--diff":
        diffPath = next;
        index += 1;
        break;
      case "--dir":
        sourceDir = next;
        index += 1;
        break;
      case "--no-semgrep":
        semgrep = false;
        break;
      case "--json":
        json = true;
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
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        if (arg?.startsWith("--diff=")) {
          diffPath = arg.slice("--diff=".length);
        } else if (arg?.startsWith("--dir=")) {
          sourceDir = arg.slice("--dir=".length);
        } else {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }
  }

  if (!diffPath) throw new Error("--diff is required");
  return { diffPath, sourceDir, semgrep, json, threshold };
}

async function readSourceFiles(
  sourceDir: string,
  paths: string[],
): Promise<{ files: SourceFile[]; missing: string[] }> {
  const files: SourceFile[] = [];
  const missing: string[] = [];

  for (const filePath of paths) {
    try {
      const content = await readFile(path.join(sourceDir, filePath), "utf8");
      files.push({ path: filePath, content });
    } catch {
      missing.push(filePath);
    }
  }

  return { files, missing };
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
    console.error(
      error instanceof ConfigError ? error.message : String(error),
    );
    process.exit(1);
  }

  const diffText = await readFile(options.diffPath, "utf8");
  const allDiffs = parseUnifiedDiff(diffText);
  if (allDiffs.length === 0) {
    console.error("No file diffs found. Expected a unified diff with @@ hunks.");
    process.exit(1);
  }

  const diffs = allDiffs.slice(0, config.review.maxFiles);
  const omittedFiles = Math.max(0, allDiffs.length - diffs.length);

  let semgrepRun = { available: false, findings: [], durationMs: 0, errorCount: 0 } as Awaited<
    ReturnType<typeof runSemgrep>
  >;
  const missingSources: string[] = [];

  if (options.semgrep && options.sourceDir) {
    const sources = await readSourceFiles(
      options.sourceDir,
      diffs.map((diff) => diff.path),
    );
    missingSources.push(...sources.missing);
    semgrepRun = await runSemgrep({
      files: sources.files,
      config: config.semgrep.config,
      timeoutMs: config.semgrep.timeoutMs,
    });
  }

  const analyzer = new ReviewerAnalyzer({
    ...config.anthropic,
    maxDiffChars: config.review.maxDiffChars,
  });

  const analysis = await analyzer.analyze({
    repoFullName: "local/dry-run",
    prNumber: 0,
    prTitle: `Dry run for ${path.basename(options.diffPath)}`,
    prBody: null,
    author: "local",
    baseRef: "base",
    headRef: "head",
    headSha: "0".repeat(40),
    files: diffs,
    omittedFiles,
    semgrepFindings: semgrepRun.findings,
    ...(config.review.customInstructions
      ? { customInstructions: config.review.customInstructions }
      : {}),
  });

  const llm = normalizeLlmFindings(analysis.findings, diffs);
  const semgrep = normalizeSemgrepFindings(semgrepRun.findings, diffs);
  const merged = dedupeFindings(mergeSemgrepWithLlm(llm.accepted, semgrep.accepted));
  const threshold = options.threshold ?? config.review.confidenceThreshold;
  const thresholded = filterByConfidence(merged, threshold);
  const capped = capFindings(thresholded.posted, config.review.maxFindings);

  const result = {
    files: diffs.map((diff) => diff.path),
    semgrep: {
      available: semgrepRun.available,
      findings: semgrepRun.findings.length,
      ...(semgrepRun.error ? { error: semgrepRun.error } : {}),
      ...(missingSources.length > 0 ? { missingSources } : {}),
    },
    batches: analysis.batches,
    usage: analysis.usage,
    posted: capped.kept,
    withheld: [...thresholded.withheld, ...capped.dropped],
    rejected: [...llm.rejected, ...semgrep.rejected],
    warnings: analysis.errors,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(
    `Reviewed ${diffs.length} file(s) in ${analysis.batches} batch(es); ` +
      `${capped.kept.length} finding(s) above threshold ${threshold}.`,
  );
  console.log(
    `Semgrep: ${
      semgrepRun.available
        ? `${semgrepRun.findings.length} finding(s)`
        : `unavailable${semgrepRun.error ? ` (${semgrepRun.error})` : ""}`
    }`,
  );

  for (const finding of capped.kept) {
    console.log(
      `\n[${finding.severity}] ${finding.path}:${finding.line} — ${finding.title} ` +
        `(${finding.category}, ${Math.round(finding.confidence * 100)}%, ${finding.source})`,
    );
    console.log(finding.body);
    if (finding.suggestion) {
      console.log("Suggested replacement:");
      console.log(finding.suggestion);
    }
  }

  if (result.withheld.length > 0) {
    console.log(`\nWithheld (${result.withheld.length}):`);
    for (const finding of result.withheld) {
      console.log(
        `  - ${finding.path}:${finding.line} ${finding.title} ` +
          `(${Math.round(finding.confidence * 100)}%)`,
      );
    }
  }

  if (analysis.errors.length > 0) {
    console.log("\nWarnings:");
    for (const warning of analysis.errors) console.log(`  - ${warning}`);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
