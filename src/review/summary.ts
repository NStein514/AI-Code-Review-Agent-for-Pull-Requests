import type { Finding, Severity } from "../types.js";

export const REVIEW_MARKER_PREFIX = "<!-- ai-code-review:";

export function markerFor(headSha: string): string {
  return `${REVIEW_MARKER_PREFIX}${headSha} -->`;
}

export function hasReviewMarker(body: string | null | undefined, headSha: string): boolean {
  return typeof body === "string" && body.includes(markerFor(headSha));
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

function confidenceLabel(finding: Finding): string {
  return `${Math.round(finding.confidence * 100)}%`;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

export function buildCommentBody(finding: Finding): string {
  const lines: string[] = [
    `**${finding.title}** · \`${finding.severity}\` · ${finding.category}`,
    "",
    finding.body.trim(),
  ];

  if (finding.suggestion) {
    lines.push("", "```suggestion", finding.suggestion.replace(/\n+$/, ""), "```");
  }

  const trust =
    finding.source === "both"
      ? `Confidence ${confidenceLabel(finding)} · corroborated by Semgrep`
      : finding.source === "semgrep"
        ? `Deterministic static analysis (${finding.ruleId ?? "semgrep"})`
        : `Confidence ${confidenceLabel(finding)}`;

  lines.push("", `_${trust}_`);
  return lines.join("\n").slice(0, 60_000);
}

export interface SummaryInput {
  headSha: string;
  posted: Finding[];
  withheld: Finding[];
  filesReviewed: number;
  skippedFiles: Array<{ path: string; reason: string }>;
  semgrep: { available: boolean; count: number; error?: string };
  analysisErrors: string[];
  durationMs: number;
}

export function buildReviewBody(input: SummaryInput): string {
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const finding of input.posted) counts[finding.severity] += 1;

  const total = input.posted.length;
  const lines: string[] = [
    markerFor(input.headSha),
    "## Automated code review",
    "",
  ];

  if (total === 0) {
    lines.push(
      input.filesReviewed === 0
        ? "**No reviewable changes** (only generated, vendored, binary, or oversized files)."
        : `**No issues found** in ${input.filesReviewed} file${
            input.filesReviewed === 1 ? "" : "s"
          } reviewed.`,
    );
  } else {
    const breakdown = (Object.keys(counts) as Severity[])
      .filter((severity) => counts[severity] > 0)
      .map((severity) => `${counts[severity]} ${severity}`)
      .join(" · ");
    lines.push(
      `**${total} issue${total === 1 ? "" : "s"} found** · ${breakdown} · ${input.filesReviewed} file${
        input.filesReviewed === 1 ? "" : "s"
      } reviewed`,
      "",
      "| Severity | Location | Finding | Confidence |",
      "| --- | --- | --- | --- |",
    );

    for (const finding of input.posted) {
      lines.push(
        `| ${SEVERITY_LABEL[finding.severity]} | \`${escapeTableCell(
          `${finding.path}:${finding.line}`,
        )}\` | ${escapeTableCell(finding.title)} | ${confidenceLabel(finding)} |`,
      );
    }
  }

  const staticSummary = input.semgrep.available
    ? `Semgrep baseline: ${input.semgrep.count} finding${input.semgrep.count === 1 ? "" : "s"}`
    : `Semgrep baseline: unavailable${input.semgrep.error ? ` (${input.semgrep.error})` : ""}`;
  lines.push("", `_${staticSummary}._`);

  if (input.withheld.length > 0) {
    lines.push(
      "",
      `<details><summary>Not posted (${input.withheld.length} low-confidence or over-limit observation${
        input.withheld.length === 1 ? "" : "s"
      })</summary>`,
      "",
    );
    for (const finding of input.withheld.slice(0, 20)) {
      lines.push(
        `- \`${finding.path}:${finding.line}\` ${SEVERITY_LABEL[finding.severity]}: ${finding.title} (confidence ${confidenceLabel(finding)})`,
      );
    }
    if (input.withheld.length > 20) {
      lines.push(`- ... and ${input.withheld.length - 20} more`);
    }
    lines.push("", "</details>");
  }

  if (input.skippedFiles.length > 0) {
    lines.push(
      "",
      `<details><summary>Skipped files (${input.skippedFiles.length})</summary>`,
      "",
    );
    for (const skipped of input.skippedFiles.slice(0, 10)) {
      lines.push(`- \`${skipped.path}\`: ${skipped.reason}`);
    }
    if (input.skippedFiles.length > 10) {
      lines.push(`- ... and ${input.skippedFiles.length - 10} more`);
    }
    lines.push("", "</details>");
  }

  if (input.analysisErrors.length > 0) {
    lines.push(
      "",
      `<details><summary>Reviewer warnings (${input.analysisErrors.length})</summary>`,
      "",
    );
    for (const error of input.analysisErrors.slice(0, 10)) {
      lines.push(`- ${error.replace(/`/g, "'")}`);
    }
    lines.push("", "</details>");
  }

  lines.push(
    "",
    `_Automated review of \`${input.headSha.slice(0, 7)}\` in ${(input.durationMs / 1000).toFixed(
      1,
    )}s. Findings can be wrong; verify before acting on them._`,
  );

  return lines.join("\n").slice(0, 60_000);
}

/** Used when GitHub rejects inline comments and only a summary can be posted. */
export function serializeFindingsAsText(findings: Finding[]): string {
  if (findings.length === 0) return "";
  const lines = ["### Findings (inline comments unavailable)", ""];
  for (const finding of findings) {
    lines.push(
      `#### ${finding.title} — \`${finding.path}:${finding.line}\` (${finding.severity})`,
      "",
      finding.body,
      "",
    );
    if (finding.suggestion) {
      lines.push("```suggestion", finding.suggestion, "```", "");
    }
  }
  return lines.join("\n");
}
