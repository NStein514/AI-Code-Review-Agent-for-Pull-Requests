import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLineIndex, findFileDiff } from "../src/github/diff.js";
import { loadEvalCases } from "../src/eval/cases.js";

const root = path.join(process.cwd(), "fixtures", "eval");

describe("eval fixtures", () => {
  it("loads twelve cases in sorted order", async () => {
    const cases = await loadEvalCases(root);

    expect(cases.map((entry) => entry.name)).toEqual([
      "check-then-act-race",
      "clean-config",
      "clean-refactor",
      "clean-tests",
      "hardcoded-secret",
      "missing-authz",
      "null-deref",
      "off-by-one",
      "path-traversal",
      "prompt-injection",
      "sql-injection",
      "xss-innerhtml",
    ]);
  });

  it("has nine labeled cases and three clean cases", async () => {
    const cases = await loadEvalCases(root);

    const labeled = cases.filter((entry) => entry.meta.expected.length > 0);
    const clean = cases.filter((entry) => entry.meta.expected.length === 0);

    expect(labeled).toHaveLength(9);
    expect(clean).toHaveLength(3);
    expect(labeled.reduce((total, entry) => total + entry.meta.expected.length, 0)).toBe(
      11,
    );
  });

  it("places every label on a head-side line of its diff", async () => {
    const cases = await loadEvalCases(root);

    for (const entry of cases) {
      for (const expected of entry.meta.expected) {
        const diff = findFileDiff(entry.files, expected.path);
        expect(diff, `${entry.name}: ${expected.path}`).toBeDefined();
        if (!diff) continue;
        expect(
          buildLineIndex(diff).has(expected.line),
          `${entry.name}: ${expected.path}:${expected.line}`,
        ).toBe(true);
      }
    }
  });

  it("ships head-revision sources for the Semgrep cases", async () => {
    const cases = await loadEvalCases(root);
    const sql = cases.find((entry) => entry.name === "sql-injection");
    const secret = cases.find((entry) => entry.name === "hardcoded-secret");
    const clean = cases.find((entry) => entry.name === "clean-refactor");

    expect(sql?.repoFiles).toHaveLength(1);
    expect(sql?.repoFiles[0]?.path).toBe("src/users.ts");
    expect(secret?.repoFiles[0]?.path).toBe("src/config.ts");
    expect(clean?.repoFiles).toHaveLength(0);
  });
});

describe("loadEvalCases validation", () => {
  it("rejects a label that is not a head-side line", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "eval-cases-"));

    try {
      const caseDir = path.join(dir, "bad-label");
      await mkdir(caseDir, { recursive: true });
      await writeFile(
        path.join(caseDir, "diff.patch"),
        [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1,2 +1,3 @@",
          " before",
          "+const a = 1;",
          " after",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        path.join(caseDir, "meta.json"),
        JSON.stringify({
          expected: [{ path: "src/a.ts", line: 99, category: "bug" }],
        }),
        "utf8",
      );

      await expect(loadEvalCases(dir)).rejects.toThrow("not a head-side line");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
