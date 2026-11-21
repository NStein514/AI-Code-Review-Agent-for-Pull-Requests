export type Severity = "critical" | "high" | "medium" | "low";

export type Category =
  | "bug"
  | "security"
  | "performance"
  | "style"
  | "maintainability"
  | "testing"
  | "docs"
  | "other";

export type FindingSource = "llm" | "semgrep" | "both";

/**
 * A review finding that has been checked against the pull request diff and is
 * ready to be scored, filtered and posted.
 */
export interface Finding {
  path: string;
  /** New-file line number (RIGHT side of the diff). */
  line: number;
  /** Inclusive start of a multi-line comment, when present. */
  startLine?: number;
  severity: Severity;
  category: Category;
  title: string;
  body: string;
  /** Full replacement for the target line(s), used in a GitHub suggestion block. */
  suggestion?: string;
  /** 0..1 self-reported or derived confidence. */
  confidence: number;
  evidence?: string;
  source: FindingSource;
  ruleId?: string;
}

export interface RejectedFinding {
  reason: string;
  title?: string;
  path?: string;
  line?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type PullRequestOutcomeStatus = "reviewed" | "skipped" | "failed";

export interface PullRequestOutcome {
  status: PullRequestOutcomeStatus;
  reason?: string;
  posted: number;
  withheld: number;
  filesReviewed: number;
  durationMs: number;
}
