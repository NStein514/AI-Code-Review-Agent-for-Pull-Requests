import { describe, expect, it } from "vitest";
import { mapSemgrepSeverity, parseSemgrepOutput } from "../src/review/semgrep.js";

describe("mapSemgrepSeverity", () => {
  it("maps Semgrep severities to review severities", () => {
    expect(mapSemgrepSeverity("ERROR")).toBe("high");
    expect(mapSemgrepSeverity("WARNING")).toBe("medium");
    expect(mapSemgrepSeverity("INFO")).toBe("low");
    expect(mapSemgrepSeverity(undefined)).toBe("medium");
  });
});

describe("parseSemgrepOutput", () => {
  const output = JSON.stringify({
    results: [
      {
        check_id: "ai-review-js-sql-concat",
        path: "./src/users.ts",
        start: { line: 11 },
        end: { line: 11 },
        extra: {
          message: "SQL statement built with string concatenation.",
          severity: "ERROR",
          lines: '  "SELECT ... WHERE name = \'" + name + "\'"',
          metadata: { category: "security" },
        },
      },
      {
        check_id: "missing-line",
        path: "src/users.ts",
        extra: { message: "no line" },
      },
    ],
    errors: [{ message: "one rule failed" }],
  });

  it("parses results, normalizes paths and counts errors", () => {
    const parsed = parseSemgrepOutput(output);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({
      ruleId: "ai-review-js-sql-concat",
      path: "src/users.ts",
      line: 11,
      severity: "high",
      category: "security",
    });
    expect(parsed.findings[0]?.snippet).toContain("SELECT");
    expect(parsed.errorCount).toBe(1);
  });

  it("handles a warning printed before the JSON payload", () => {
    const parsed = parseSemgrepOutput(`[warn] something\n${output}`);
    expect(parsed.findings).toHaveLength(1);
  });

  it("returns an error count for unparseable output", () => {
    const parsed = parseSemgrepOutput("not json at all");
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.errorCount).toBe(1);
  });

  it("falls back to the security category for unknown metadata", () => {
    const parsed = parseSemgrepOutput(
      JSON.stringify({
        results: [
          {
            check_id: "x",
            path: "a.py",
            start: { line: 2 },
            extra: { message: "m", severity: "INFO", metadata: { category: "weird" } },
          },
        ],
      }),
    );
    expect(parsed.findings[0]?.category).toBe("security");
    expect(parsed.findings[0]?.severity).toBe("low");
  });
});
