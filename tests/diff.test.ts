import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAddedLines,
  buildLineIndex,
  nearestReviewableLine,
  parseFilePatch,
  parseUnifiedDiff,
  renderDiffForPrompt,
} from "../src/github/diff.js";

const PATCH = [
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
].join("\n");

describe("parseFilePatch", () => {
  const diff = parseFilePatch("src/example.ts", PATCH, "modified");

  it("maps head-side line numbers and counts changes", () => {
    expect(diff.hunks).toHaveLength(1);
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(1);

    const lines = diff.hunks[0]?.lines ?? [];
    expect(lines.map((line) => line.kind)).toEqual([
      "context",
      "del",
      "add",
      "add",
      "context",
    ]);
    expect(lines.map((line) => line.newLine)).toEqual([1, null, 2, 3, 4]);
    expect(lines.map((line) => line.oldLine)).toEqual([1, 2, null, null, 3]);
  });

  it("indexes every line visible on the head side", () => {
    const index = buildLineIndex(diff);
    expect([...index.keys()]).toEqual([1, 2, 3, 4]);
    expect(index.get(3)).toBe("const c = 4;");
  });

  it("identifies only added lines", () => {
    expect([...buildAddedLines(diff)]).toEqual([2, 3]);
  });

  it("snaps a nearby line to the closest reviewable line", () => {
    expect(nearestReviewableLine(diff, 6, 3)).toBe(4);
    expect(nearestReviewableLine(diff, 20, 3)).toBeNull();
  });

  it("ignores trailing newlines beyond the hunk's line counts", () => {
    const withTrailing = `${PATCH}\n`;
    expect(parseFilePatch("src/example.ts", withTrailing, "modified").hunks[0]?.lines).toHaveLength(5);
  });
});

describe("renderDiffForPrompt", () => {
  it("annotates lines with head-side numbers", () => {
    const diff = parseFilePatch("src/example.ts", PATCH, "modified");
    const rendered = renderDiffForPrompt(diff, 10_000);
    expect(rendered.text).toContain("### File: src/example.ts [modified]");
    expect(rendered.text).toContain("+    3 | const c = 4;");
    expect(rendered.text).toContain("-    2 | const b = 2;");
    expect(rendered.truncated).toBe(false);
  });

  it("truncates very small budgets", () => {
    const diff = parseFilePatch("src/example.ts", PATCH, "modified");
    const rendered = renderDiffForPrompt(diff, 40);
    expect(rendered.truncated).toBe(true);
    expect(rendered.text).toContain("diff truncated");
  });
});

describe("parseUnifiedDiff", () => {
  it("parses the repository fixture and finds the SQL line", () => {
    const text = readFileSync(
      path.join(process.cwd(), "fixtures", "sql-injection.diff"),
      "utf8",
    );
    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("src/users.ts");

    const sqlLine = files[0]?.hunks[0]?.lines.find((line) => line.newLine === 11);
    expect(sqlLine?.text).toContain("SELECT id, email, password_hash");
    expect(sqlLine?.kind).toBe("add");
  });

  it("splits multiple file sections and reads rename/delete metadata", () => {
    const text = [
      "diff --git a/src/one.ts b/src/one.ts",
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/two.ts b/src/renamed.ts",
      "similarity index 90%",
      "rename from src/two.ts",
      "rename to src/renamed.ts",
      "--- a/src/two.ts",
      "+++ b/src/renamed.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/docs/gone.md b/docs/gone.md",
      "deleted file mode 100644",
      "--- a/docs/gone.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n");

    const files = parseUnifiedDiff(text);
    expect(files.map((file) => file.path)).toEqual([
      "src/one.ts",
      "src/renamed.ts",
      "docs/gone.md",
    ]);
    expect(files[1]?.previousPath).toBe("src/two.ts");
    expect(files[1]?.status).toBe("renamed");
    expect(files[2]?.status).toBe("removed");
  });
});
