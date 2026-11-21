import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type { SourceFile } from "../github/contents.js";
import type { Category, Severity } from "../types.js";

const execFileAsync = promisify(execFile);

export interface SemgrepFinding {
  ruleId: string;
  path: string;
  line: number;
  endLine?: number;
  severity: Severity;
  category: Category;
  message: string;
  snippet?: string;
}

export interface SemgrepRunResult {
  available: boolean;
  findings: SemgrepFinding[];
  durationMs: number;
  error?: string;
  errorCount: number;
}

interface SemgrepJsonResult {
  check_id?: string;
  path?: string;
  start?: { line?: number };
  end?: { line?: number };
  extra?: {
    message?: string;
    severity?: string;
    lines?: string;
    metadata?: Record<string, unknown>;
  };
}

interface SemgrepJson {
  results?: SemgrepJsonResult[];
  errors?: Array<{ message?: string }>;
}

const KNOWN_CATEGORIES: readonly Category[] = [
  "bug",
  "security",
  "performance",
  "style",
  "maintainability",
  "testing",
  "docs",
  "other",
];

export function mapSemgrepSeverity(value: string | undefined): Severity {
  switch ((value ?? "").toUpperCase()) {
    case "ERROR":
      return "high";
    case "WARNING":
      return "medium";
    case "INFO":
      return "low";
    default:
      return "medium";
  }
}

function mapCategory(metadata: Record<string, unknown> | undefined): Category {
  const value = metadata?.category;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (KNOWN_CATEGORIES.includes(normalized as Category)) return normalized as Category;
  }
  return "security";
}

function normalizeResultPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Parses `semgrep --json` output; kept pure so it can be unit tested. */
export function parseSemgrepOutput(stdout: string): {
  findings: SemgrepFinding[];
  errorCount: number;
} {
  let parsed: SemgrepJson;
  try {
    parsed = JSON.parse(stdout) as SemgrepJson;
  } catch {
    // Semgrep can emit a warning line before the JSON object.
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start === -1 || end <= start) return { findings: [], errorCount: 1 };
    try {
      parsed = JSON.parse(stdout.slice(start, end + 1)) as SemgrepJson;
    } catch {
      return { findings: [], errorCount: 1 };
    }
  }

  const findings: SemgrepFinding[] = [];

  for (const result of parsed.results ?? []) {
    const ruleId = result.check_id;
    const filePath = result.path;
    const line = result.start?.line;
    if (!ruleId || !filePath || typeof line !== "number" || line < 1) continue;

    const snippet = result.extra?.lines?.trim();
    findings.push({
      ruleId,
      path: normalizeResultPath(filePath),
      line,
      ...(result.end?.line ? { endLine: result.end.line } : {}),
      severity: mapSemgrepSeverity(result.extra?.severity),
      category: mapCategory(result.extra?.metadata),
      message: result.extra?.message?.trim() || ruleId,
      ...(snippet ? { snippet } : {}),
    });
  }

  return { findings, errorCount: parsed.errors?.length ?? 0 };
}

function safeRelativePath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return null;
  }
  return normalized;
}

/**
 * Runs the Semgrep CLI over the changed files in an isolated temp directory.
 * Missing CLI or a broken rules file degrades to "unavailable"; it never fails
 * the whole review.
 */
export async function runSemgrep(options: {
  files: SourceFile[];
  config: string;
  timeoutMs: number;
  logger?: Logger;
}): Promise<SemgrepRunResult> {
  const startedAt = Date.now();

  if (options.files.length === 0) {
    return { available: true, findings: [], durationMs: 0, errorCount: 0 };
  }

  const isRegistryConfig = /^(auto|p\/|r\/)/.test(options.config);
  const configPath = isRegistryConfig
    ? options.config
    : path.resolve(process.cwd(), options.config);

  if (!isRegistryConfig && !existsSync(configPath)) {
    options.logger?.warn({ config: configPath }, "semgrep config not found; skipping baseline");
    return {
      available: false,
      findings: [],
      durationMs: Date.now() - startedAt,
      error: `Semgrep config not found at ${configPath}`,
      errorCount: 0,
    };
  }

  const workdir = await mkdtemp(path.join(tmpdir(), "ai-review-semgrep-"));
  const written: string[] = [];

  try {
    for (const file of options.files) {
      const relative = safeRelativePath(file.path);
      if (!relative) continue;
      const destination = path.join(workdir, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content, "utf8");
      written.push(relative);
    }

    if (written.length === 0) {
      return { available: true, findings: [], durationMs: Date.now() - startedAt, errorCount: 0 };
    }

    const args = [
      "--json",
      "--quiet",
      "--metrics=off",
      "--disable-version-check",
      "--config",
      configPath,
      "--timeout",
      "30",
      ...written,
    ];

    const { stdout } = (await execFileAsync("semgrep", args, {
      cwd: workdir,
      timeout: options.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      encoding: "utf8",
    })) as { stdout: string };

    const parsed = parseSemgrepOutput(stdout);
    return {
      available: true,
      findings: parsed.findings,
      durationMs: Date.now() - startedAt,
      errorCount: parsed.errorCount,
    };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & { stdout?: string; killed?: boolean };
    const durationMs = Date.now() - startedAt;

    if (execError.code === "ENOENT") {
      options.logger?.warn(
        "semgrep CLI not found; continuing without the static-analysis baseline",
      );
      return {
        available: false,
        findings: [],
        durationMs,
        error: "Semgrep CLI is not installed",
        errorCount: 0,
      };
    }

    if (typeof execError.stdout === "string" && execError.stdout.trim().startsWith("{")) {
      const parsed = parseSemgrepOutput(execError.stdout);
      if (parsed.findings.length > 0) {
        options.logger?.warn(
          { err: execError.message },
          "semgrep exited with an error but returned partial results",
        );
        return {
          available: true,
          findings: parsed.findings,
          durationMs,
          error: execError.message,
          errorCount: parsed.errorCount,
        };
      }
    }

    options.logger?.warn({ err: execError.message }, "semgrep run failed");
    return {
      available: false,
      findings: [],
      durationMs,
      error: execError.killed ? "Semgrep timed out" : execError.message,
      errorCount: 0,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}
