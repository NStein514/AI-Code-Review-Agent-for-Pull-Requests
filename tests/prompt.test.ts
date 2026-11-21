import { describe, expect, it } from "vitest";
import { parseFilePatch } from "../src/github/diff.js";
import {
  buildUserPrompt,
  contextWindows,
  SYSTEM_PROMPT,
} from "../src/review/prompt.js";

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
    expect(SYSTEM_PROMPT).toContain("<file_context>");
    expect(SYSTEM_PROMPT).toContain("<changed_files>");
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

describe("repo context", () => {
  const contextDiff = parseFilePatch(
    "src/users.ts",
    [
      "@@ -4,3 +4,4 @@",
      " const keepA = 1;",
      "-const value = 0;",
      "+const value = 1;",
      "+const extra = 2;",
      " const keepB = 3;",
    ].join("\n"),
    "modified",
  );
  const source = {
    path: "src/users.ts",
    content:
      [
        "const beforeOne = 0;",
        "const beforeTwo = 1;",
        "const beforeThree = 2;",
        "const keepA = 1;",
        "const value = 1;",
        "const extra = 2;",
        "const keepB = 3;",
        "const afterOne = 4;",
        "const afterTwo = 5;",
        "const afterThree = 6;",
      ].join("\n") + "\n",
  };

  it("adds verification-only context without duplicating diff lines", () => {
    const built = buildUserPrompt({
      ...base,
      files: [contextDiff],
      sources: [source],
      contextLines: 2,
      maxContextChars: 2_000,
    });
    const context = built.prompt.split("<file_context>")[1] ?? "";

    expect(built.prompt).toContain("<file_context>");
    expect(built.prompt).toContain("Verification-only context");
    expect(context).toContain("2 | const beforeTwo = 1;");
    expect(context).toContain("9 | const afterTwo = 5;");
    expect(context).not.toContain("4 | const keepA = 1;");
    expect(context).not.toContain("5 | const value = 1;");
    expect(built.prompt).toContain(
      "Never report a finding on a line that appears only here",
    );
    expect(built.contextFiles).toBe(1);
  });

  it("omits context when disabled", () => {
    const built = buildUserPrompt({
      ...base,
      files: [contextDiff],
      sources: [source],
      contextLines: 0,
      maxContextChars: 2_000,
    });

    expect(built.prompt).not.toContain("<file_context>");
    expect(built.contextFiles).toBe(0);
  });

  it("merges overlapping hunk windows and clamps them to the file", () => {
    const multi = parseFilePatch(
      "src/multi.ts",
      [
        "@@ -10,1 +10,1 @@",
        "-old",
        "+new",
        "@@ -20,1 +20,1 @@",
        "-old",
        "+new",
      ].join("\n"),
      "modified",
    );

    expect(contextWindows(multi, 30, 5)).toEqual([{ start: 5, end: 25 }]);
    expect(contextWindows(multi, 12, 5)).toEqual([{ start: 5, end: 12 }]);
  });

  it("splits the context budget fairly across files", () => {
    const makeDiff = (filePath: string) =>
      parseFilePatch(
        filePath,
        [
          "@@ -50,1 +50,2 @@",
          "-const old = 1;",
          "+const value = 2;",
          "+const extra = 3;",
        ].join("\n"),
        "modified",
      );
    const makeSource = () => {
      const lines = Array.from(
        { length: 100 },
        (_, index) => `const line${index + 1} = ${index + 1};`,
      );
      lines[49] = "const value = 2;";
      lines[50] = "const extra = 3;";
      return lines.join("\n") + "\n";
    };

    const built = buildUserPrompt({
      ...base,
      files: [makeDiff("src/aa.ts"), makeDiff("src/bb.ts")],
      sources: [
        { path: "src/aa.ts", content: makeSource() },
        { path: "src/bb.ts", content: makeSource() },
      ],
      contextLines: 30,
      maxContextChars: 1_000,
      maxDiffChars: 20_000,
    });

    const prompt = built.prompt;
    const aStart = prompt.indexOf("### Context: src/aa.ts");
    const bStart = prompt.indexOf("### Context: src/bb.ts");
    expect(aStart).toBeGreaterThan(-1);
    expect(bStart).toBeGreaterThan(aStart);

    const aBlock = prompt.slice(aStart, bStart);
    const bBlock = prompt.slice(bStart, prompt.indexOf("</file_context>"));
    const countContextLines = (text: string) =>
      text.split("\n").filter((line) => /^\s*\d+ \| /.test(line)).length;

    expect(countContextLines(aBlock)).toBeGreaterThan(5);
    expect(countContextLines(bBlock)).toBeGreaterThan(5);
    expect(
      Math.abs(countContextLines(aBlock) - countContextLines(bBlock)),
    ).toBeLessThanOrEqual(2);
  });
});
