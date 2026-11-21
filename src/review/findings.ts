import { z } from "zod";
import type { FileDiff } from "../github/diff.js";
import {
  buildAddedLines,
  buildLineIndex,
  findFileDiff,
  linesInRange,
  nearestReviewableLine,
  normalizePath,
} from "../github/diff.js";
import type { Category, Finding, RejectedFinding, Severity } from "../types.js";
import type { SemgrepFinding } from "./semgrep.js";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const CATEGORIES = [
  "bug",
  "security",
  "performance",
  "style",
  "maintainability",
  "testing",
  "docs",
  "other",
] as const;

export const llmFindingSchema = z.object({
  path: z.string().trim().min(1).max(500),
  line: z.number().int().positive().max(5_000_000),
  start_line: z.number().int().positive().max(5_000_000).optional(),
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(10).max(4_000),
  suggestion: z.string().max(4_000).optional(),
  confidence: z.number().min(0).max(1),
  evidence: z.string().max(1_000),
});

export const llmResponseSchema = z.object({
  findings: z.array(llmFindingSchema).max(100),
  summary: z.string().max(2_000).optional(),
});

export type LlmFinding = z.infer<typeof llmFindingSchema>;

export interface ParsedToolInput {
  findings: LlmFinding[];
  summary?: string;
  issues: string[];
}

/**
 * Accepts either a fully valid tool payload or a partially valid one, so a
 * single malformed finding does not discard the whole review.
 */
export function parseLlmToolInput(input: unknown): ParsedToolInput {
  const direct = llmResponseSchema.safeParse(input);
  if (direct.success) {
    return {
      findings: direct.data.findings,
      ...(direct.data.summary ? { summary: direct.data.summary } : {}),
      issues: [],
    };
  }

  const record =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : undefined;

  if (!record || !Array.isArray(record.findings)) {
    return {
      findings: [],
      issues: ["tool input did not contain a findings array"],
    };
  }

  const findings: LlmFinding[] = [];
  const issues: string[] = [];

  record.findings.forEach((entry, index) => {
    const parsed = llmFindingSchema.safeParse(entry);
    if (parsed.success) {
      findings.push(parsed.data);
    } else {
      issues.push(
        `finding[${index}]: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
          .join("; ")}`,
      );
    }
  });

  const summary =
    typeof record.summary === "string" ? record.summary.slice(0, 2_000) : undefined;

  return { findings, ...(summary ? { summary } : {}), issues };
}

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (left, right) =>
      SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
      right.confidence - left.confidence ||
      left.path.localeCompare(right.path) ||
      left.line - right.line,
  );
}

interface NormalizeResult {
  accepted: Finding[];
  rejected: RejectedFinding[];
}

interface FileContext {
  diff: FileDiff;
  index: Map<number, string>;
  added: Set<number>;
}

function buildContexts(files: FileDiff[]): Map<string, FileContext> {
  const contexts = new Map<string, FileContext>();
  for (const diff of files) {
    const context: FileContext = {
      diff,
      index: buildLineIndex(diff),
      added: buildAddedLines(diff),
    };
    contexts.set(diff.path, context);
    if (diff.previousPath) contexts.set(diff.previousPath, context);
  }
  return contexts;
}

function roundConfidence(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sanitizeSuggestion(
  suggestion: string | undefined,
  originalText: string,
): string | undefined {
  if (!suggestion) return undefined;
  const trimmed = suggestion.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  if (trimmed.length === 0) return undefined;
  if (trimmed.includes("```")) return undefined;
  if (normalizeWhitespace(trimmed) === normalizeWhitespace(originalText)) return undefined;
  return trimmed;
}

/**
 * Validates model findings against the real diff: paths must exist, line
 * numbers must be visible on the head side, evidence must match, and any
 * suggestion is only kept when the quoted evidence was verified.
 */
export function normalizeLlmFindings(
  raw: LlmFinding[],
  files: FileDiff[],
  options: { maxFindings?: number } = {},
): NormalizeResult {
  const contexts = buildContexts(files);
  const accepted: Finding[] = [];
  const rejected: RejectedFinding[] = [];
  const limit = options.maxFindings ?? 100;

  for (const finding of raw.slice(0, limit * 2)) {
    const context = contexts.get(normalizePath(finding.path));
    if (!context) {
      rejected.push({
        reason: "path is not part of the reviewed diff",
        title: finding.title,
        path: finding.path,
        line: finding.line,
      });
      continue;
    }

    let line = finding.line;
    if (!context.index.has(line)) {
      const snapped = nearestReviewableLine(context.diff, line, 3);
      if (snapped === null) {
        rejected.push({
          reason: "line is outside the diff hunks",
          title: finding.title,
          path: finding.path,
          line: finding.line,
        });
        continue;
      }
      line = snapped;
    }

    let startLine: number | undefined;
    if (finding.start_line !== undefined && finding.start_line < line) {
      let start = finding.start_line;
      if (!context.index.has(start)) {
        const snappedStart = nearestReviewableLine(context.diff, start, 2);
        if (snappedStart !== null && snappedStart < line) start = snappedStart;
      }
      if (context.index.has(start) && start < line) startLine = start;
    }

    const targetLines = linesInRange(context.index, startLine ?? line, line);
    const targetText = targetLines?.join("\n") ?? context.index.get(line) ?? "";

    const evidence = finding.evidence.trim();
    const evidenceVerified =
      evidence.length > 0 &&
      normalizeWhitespace(targetText).includes(normalizeWhitespace(evidence));

    let confidence = finding.confidence;
    if (!evidenceVerified) confidence *= 0.85;

    const suggestion = evidenceVerified
      ? sanitizeSuggestion(finding.suggestion, targetText)
      : undefined;

    accepted.push({
      path: context.diff.path,
      line,
      ...(startLine !== undefined ? { startLine } : {}),
      severity: finding.severity,
      category: finding.category,
      title: finding.title.slice(0, 160),
      body: finding.body.slice(0, 3_500),
      ...(suggestion ? { suggestion } : {}),
      confidence: roundConfidence(confidence),
      evidence,
      source: "llm",
    });
  }

  return { accepted: accepted.slice(0, limit), rejected };
}

/**
 * Semgrep findings still have to land on a line GitHub can comment on, but
 * they are deterministic and start with high confidence.
 */
export function normalizeSemgrepFindings(
  raw: SemgrepFinding[],
  files: FileDiff[],
): NormalizeResult {
  const contexts = buildContexts(files);
  const accepted: Finding[] = [];
  const rejected: RejectedFinding[] = [];
  const seen = new Set<string>();

  for (const finding of raw) {
    const context = contexts.get(normalizePath(finding.path));
    if (!context) {
      rejected.push({
        reason: "path is not part of the reviewed diff",
        path: finding.path,
        line: finding.line,
      });
      continue;
    }

    let line: number | null = finding.line;
    if (!context.index.has(line)) {
      line = nearestReviewableLine(context.diff, line, 2);
    }
    if (line === null) {
      rejected.push({
        reason: "line is outside the diff hunks",
        path: finding.path,
        line: finding.line,
      });
      continue;
    }

    const key = `${context.diff.path}:${line}:${finding.ruleId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const message = finding.message.trim() || "Static analysis finding";
    accepted.push({
      path: context.diff.path,
      line,
      severity: finding.severity,
      category: finding.category,
      title: message.split(/[.!?]\s/)[0]?.slice(0, 140) ?? message.slice(0, 140),
      body: `${message}${finding.snippet ? `\n\n\`\`\`\n${finding.snippet}\n\`\`\`` : ""}`,
      confidence: 0.92,
      ...(finding.snippet ? { evidence: finding.snippet } : {}),
      source: "semgrep",
      ruleId: finding.ruleId,
    });
  }

  return { accepted, rejected };
}

/**
 * Corroborated findings are more trustworthy than either source alone; the
 * combined confidence is raised accordingly.
 */
export function mergeSemgrepWithLlm(
  llmFindings: Finding[],
  semgrepFindings: Finding[],
): Finding[] {
  const merged = llmFindings.map((finding) => ({ ...finding }));
  const addedSemgrep: Finding[] = [];

  for (const staticFinding of semgrepFindings) {
    const match = merged.find(
      (finding) =>
        finding.path === staticFinding.path &&
        Math.abs(finding.line - staticFinding.line) <= 2 &&
        (finding.category === staticFinding.category || staticFinding.category === "security"),
    );

    if (!match) {
      addedSemgrep.push(staticFinding);
      continue;
    }

    match.source = "both";
    match.confidence = Math.max(match.confidence, 0.95);
    match.severity =
      SEVERITY_RANK[staticFinding.severity] > SEVERITY_RANK[match.severity]
        ? staticFinding.severity
        : match.severity;
    const note = `_Also reported by Semgrep rule \`${staticFinding.ruleId}\`._`;
    if (!match.body.includes(note)) match.body = `${match.body}\n\n${note}`;
  }

  return dedupeFindings([...merged, ...addedSemgrep]);
}

export function dedupeFindings(findings: Finding[]): Finding[] {
  const best = new Map<string, Finding>();

  for (const finding of findings) {
    const key = `${finding.path}:${finding.line}:${finding.category}`;
    const existing = best.get(key);
    if (
      !existing ||
      SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity] ||
      (SEVERITY_RANK[finding.severity] === SEVERITY_RANK[existing.severity] &&
        finding.confidence > existing.confidence)
    ) {
      best.set(key, finding);
    }
  }

  return sortFindings([...best.values()]);
}

export function filterByConfidence(
  findings: Finding[],
  threshold: number,
): { posted: Finding[]; withheld: Finding[] } {
  const posted: Finding[] = [];
  const withheld: Finding[] = [];
  for (const finding of findings) {
    if (finding.confidence >= threshold) posted.push(finding);
    else withheld.push(finding);
  }
  return { posted, withheld };
}

export function capFindings(
  findings: Finding[],
  max: number,
): { kept: Finding[]; dropped: Finding[] } {
  const sorted = sortFindings(findings);
  return { kept: sorted.slice(0, max), dropped: sorted.slice(max) };
}
