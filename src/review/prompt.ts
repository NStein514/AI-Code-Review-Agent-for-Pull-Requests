import { renderDiffForPrompt, type FileDiff } from "../github/diff.js";
import type { SemgrepFinding } from "./semgrep.js";

export const SYSTEM_PROMPT = `You are a senior software engineer reviewing a pull request. You find defects that would matter in production and explain them concretely.

Review priorities, highest first:
1. Correctness bugs: wrong logic, off-by-one errors, null/undefined handling, broken edge cases, race conditions, incorrect error handling, resource leaks, swallowed exceptions.
2. Security: injection (SQL, shell, path traversal, SSRF), missing authorization, unsafe deserialization, secrets in code, unsafe crypto, unvalidated redirects.
3. Data integrity: migrations, transactions, retries that duplicate writes, unsafe defaults.
4. Performance problems with a plausible, concrete impact.
5. Maintainability and style only when it hides a bug or clearly violates the surrounding code's conventions.

Hard rules:
- Only report issues on lines that exist in the provided diff. The diff is annotated with head-side line numbers; use those exact numbers. Never invent a path or a line number.
- Report a change, not a wish list. Do not comment on pre-existing code that the pull request did not touch.
- Do not report formatting, import ordering, naming taste, or "consider adding tests" unless the missing test protects a specific risky branch you can name.
- Do not report praise, summaries, or questions. Every finding must be actionable.
- Do not duplicate a Semgrep finding listed in <static_analysis>. If you have additional context for one, report it only when it changes the recommended fix, and name the rule id in the body.
- Never include secrets, credentials, or long tokens in titles, bodies, or suggestions. Redact them.
- If you are not confident, say so through the confidence field rather than hedging in the body.

Evidence and suggestions:
- "evidence" must be an exact copy of the target line (or the first line of a multi-line range) as it appears in the diff, without the leading marker or line number. A finding with mismatched evidence is downgraded and its suggestion is dropped.
- "suggestion" must be complete, compilable replacement code for exactly the target line or line range: no markdown fences, no ellipses, no comments like "... rest unchanged". Preserve indentation. If you cannot produce an exact replacement, omit the suggestion and explain the fix in the body.
- Use start_line only when the fix genuinely spans multiple consecutive added lines.

Confidence calibration:
- 0.9-1.0: the defect is certain from the shown code.
- 0.7-0.89: very likely, based on clear evidence in the diff.
- 0.5-0.69: plausible but depends on context you cannot see.
- below 0.5: speculative; prefer not to report it.

Call the submit_findings tool with your findings. An empty array is a valid and expected answer for a clean pull request.`;

export interface PromptInput {
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  prBody: string | null;
  author: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  files: FileDiff[];
  /** Files dropped before analysis because of the per-review file limit. */
  omittedFiles: number;
  semgrepFindings: SemgrepFinding[];
  customInstructions?: string;
  maxDiffChars: number;
}

export interface BuiltPrompt {
  prompt: string;
  includedFiles: number;
  truncated: boolean;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * Builds one review request for a batch of files. The diff is annotated with
 * head-side numbers so the model can cite locations that survive validation.
 */
export function buildUserPrompt(input: PromptInput): BuiltPrompt {
  const sections: string[] = [];

  sections.push(
    `<repository>${input.repoFullName}</repository>`,
    `<pull_request number="${input.prNumber}" author="${input.author}">`,
    `<title>${clip(input.prTitle, 500)}</title>`,
    `<description>${input.prBody ? clip(input.prBody, 3_000) : "(no description)"}</description>`,
    `<refs>${input.baseRef} -> ${input.headRef} at ${input.headSha.slice(0, 12)}</refs>`,
    `</pull_request>`,
  );

  if (input.semgrepFindings.length > 0) {
    const staticLines = input.semgrepFindings
      .slice(0, 40)
      .map(
        (finding) =>
          `- [${finding.severity}] ${finding.path}:${finding.line} (${finding.ruleId}) ${clip(
            finding.message,
            300,
          )}`,
      );
    if (input.semgrepFindings.length > 40) {
      staticLines.push(`- ... and ${input.semgrepFindings.length - 40} more`);
    }
    sections.push(
      `<static_analysis source="semgrep">`,
      "Deterministic findings already reported to the author. Do not repeat them unless you add material context.",
      ...staticLines,
      `</static_analysis>`,
    );
  }

  const fileCount = Math.max(input.files.length, 1);
  const perFileBudget = Math.max(1_500, Math.floor(input.maxDiffChars / fileCount));
  const rendered: string[] = [];
  let included = 0;
  let truncated = false;

  for (const file of input.files) {
    const result = renderDiffForPrompt(file, perFileBudget);
    rendered.push(result.text);
    included += 1;
    if (result.truncated) truncated = true;
  }

  sections.push(
    `<changed_files>`,
    ...rendered,
    `</changed_files>`,
    `<scope>${included} changed file(s) in this request${
      input.omittedFiles > 0 ? `, ${input.omittedFiles} additional file(s) not reviewed` : ""
    }${truncated ? "; some diffs were truncated" : ""}.</scope>`,
  );

  if (input.customInstructions && input.customInstructions.trim().length > 0) {
    sections.push(
      `<maintainer_instructions>`,
      clip(input.customInstructions.trim(), 4_000),
      `</maintainer_instructions>`,
    );
  }

  sections.push(
    "<task>",
    "Review the changed files above. Report only defects you can support with evidence from these diffs, on head-side line numbers. Use the submit_findings tool.",
    "</task>",
  );

  return { prompt: sections.join("\n"), includedFiles: included, truncated };
}
