import { describe, expect, it } from "vitest";
import { parseFilePatch } from "../src/github/diff.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "../src/review/prompt.js";

const diff = parseFilePatch(
  "src/users.ts",
  [
    "@@ -1,3 +1,5 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " const d = 5;",
  ].join("\n"),
  "modified",
);

const base = {
  repoFullName: "acme/api",
  prNumber: 42,
  prTitle: "Fix user lookup",
  prBody: "Adds search endpoint.",
  author: "dev",
  baseRef: "main",
  headRef: "feature/users",
  headSha: "b".repeat(40),
  files: [diff],
  omittedFiles: 0,
  semgrepFindings: [],
  maxDiffChars: 20_000,
};

describe("SYSTEM_PROMPT", () => {
  it("states the hard rules around evidence, line numbers and suggestions", () => {
    expect(SYSTEM_PROMPT).toContain("Never invent a path or a line number");
    expect(SYSTEM_PROMPT).toContain("evidence");
    expect(SYSTEM_PROMPT).toContain("submit_findings");
    expect(SYSTEM_PROMPT).toContain("Do not duplicate a Semgrep finding");
  });
});

describe("buildUserPrompt", () => {
  it("includes PR metadata, line-numbered diffs and the tool instruction", () => {
    const built = buildUserPrompt(base);
    expect(built.prompt).toContain("<repository>acme/api</repository>");
    expect(built.prompt).toContain('<pull_request number="42" author="dev">');
    expect(built.prompt).toContain("+    3 | const c = 4;");
    expect(built.prompt).toContain("<task>");
    expect(built.includedFiles).toBe(1);
    expect(built.truncated).toBe(false);
  });

  it("includes Semgrep findings as context to avoid duplicates", () => {
    const built = buildUserPrompt({
      ...base,
      semgrepFindings: [
        {
          ruleId: "ai-review-js-sql-concat",
          path: "src/users.ts",
          line: 3,
          severity: "high",
          category: "security",
          message: "SQL built with concatenation.",
        },
      ],
    });
    expect(built.prompt).toContain('<static_analysis source="semgrep">');
    expect(built.prompt).toContain("ai-review-js-sql-concat");
    expect(built.prompt).toContain("Do not repeat them");
  });

  it("passes maintainer instructions through", () => {
    const built = buildUserPrompt({
      ...base,
      customInstructions: "Never suggest optional chaining.",
    });
    expect(built.prompt).toContain("<maintainer_instructions>");
    expect(built.prompt).toContain("Never suggest optional chaining.");
  });

  it("reports omitted and truncated files", () => {
    const built = buildUserPrompt({
      ...base,
      files: [diff, parseFilePatch("src/big.ts", diff.hunks[0]?.header + "\n" + " ".repeat(4_000), "modified")],
      omittedFiles: 3,
      maxDiffChars: 1_000,
    });
    expect(built.prompt).toContain("3 additional file(s) not reviewed");
    expect(built.truncated).toBe(true);
    expect(built.prompt).toContain("some diffs were truncated");
  });
});
