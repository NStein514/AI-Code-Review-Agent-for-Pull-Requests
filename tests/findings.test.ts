import { describe, expect, it } from "vitest";
import { parseFilePatch } from "../src/github/diff.js";
import {
  capFindings,
  dedupeFindings,
  filterByConfidence,
  mergeSemgrepWithLlm,
  normalizeLlmFindings,
  normalizeSemgrepFindings,
  parseLlmToolInput,
  type LlmFinding,
} from "../src/review/findings.js";

const PATCH = [
  "@@ -1,3 +1,5 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
].join("\n");

const diff = parseFilePatch("src/example.ts", PATCH, "modified");
const files = [diff];

const validFinding: LlmFinding = {
  path: "src/example.ts",
  line: 3,
  severity: "high",
  category: "bug",
  title: "Wrong value assigned",
  body: "The value is incorrect and will break callers that rely on it.",
  confidence: 0.9,
  evidence: "const c = 4;",
  suggestion: "const c = 5;",
};

describe("parseLlmToolInput", () => {
  it("accepts a valid payload", () => {
    const parsed = parseLlmToolInput({ findings: [validFinding] });
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.issues).toHaveLength(0);
  });

  it("keeps valid findings when one entry is malformed", () => {
    const parsed = parseLlmToolInput({
      findings: [validFinding, { ...validFinding, line: "three", confidence: 4 }],
      summary: "Risky change.",
    });
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]).toContain("finding[1]");
    expect(parsed.summary).toBe("Risky change.");
  });

  it("reports a payload without findings", () => {
    const parsed = parseLlmToolInput({ summary: "nothing" });
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.issues).toHaveLength(1);
  });
});

describe("normalizeLlmFindings", () => {
  it("keeps a verified finding on an added line", () => {
    const result = normalizeLlmFindings([validFinding], files);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({
      path: "src/example.ts",
      line: 3,
      source: "llm",
      suggestion: "const c = 5;",
      confidence: 0.9,
    });
    expect(result.rejected).toHaveLength(0);
  });

  it("drops the suggestion and lowers confidence when evidence does not match", () => {
    const result = normalizeLlmFindings(
      [{ ...validFinding, evidence: "const z = 99;" }],
      files,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.suggestion).toBeUndefined();
    expect(result.accepted[0]?.confidence).toBeCloseTo(0.77, 2);
  });

  it("snaps nearby lines to a line visible in the diff", () => {
    const result = normalizeLlmFindings(
      [{ ...validFinding, line: 6, evidence: "const d = 5;" }],
      files,
    );
    expect(result.accepted[0]?.line).toBe(4);
  });

  it("rejects locations that are not in the diff", () => {
    const result = normalizeLlmFindings([{ ...validFinding, line: 40 }], files);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain("outside the diff");
  });

  it("rejects unknown paths", () => {
    const result = normalizeLlmFindings(
      [{ ...validFinding, path: "src/other.ts" }],
      files,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain("not part of the reviewed diff");
  });

  it("keeps multi-line ranges and removes fenced suggestions", () => {
    const result = normalizeLlmFindings(
      [
        {
          ...validFinding,
          start_line: 2,
          evidence: "const b = 3;",
          suggestion: "```ts\nconst b = 4;\n```",
        },
      ],
      files,
    );
    expect(result.accepted[0]?.startLine).toBe(2);
    expect(result.accepted[0]?.suggestion).toBeUndefined();
  });
});

describe("semgrep normalization and merging", () => {
  const staticWrapped = normalizeSemgrepFindings(
    [
      {
        ruleId: "ai-review-js-eval",
        path: "src/example.ts",
        line: 4,
        severity: "high",
        category: "security",
        message: "eval() executes arbitrary code.",
        snippet: "const d = 5;",
      },
    ],
    files,
  );

  it("accepts a static finding on a diff line", () => {
    expect(staticWrapped.accepted).toHaveLength(1);
    expect(staticWrapped.accepted[0]).toMatchObject({
      source: "semgrep",
      confidence: 0.92,
      ruleId: "ai-review-js-eval",
    });
  });

  it("raises confidence when both sources agree", () => {
    const llm = normalizeLlmFindings(
      [{ ...validFinding, category: "security", line: 3 }],
      files,
    ).accepted;
    const merged = mergeSemgrepWithLlm(llm, staticWrapped.accepted);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe("both");
    expect(merged[0]?.confidence).toBeGreaterThanOrEqual(0.95);
    expect(merged[0]?.body).toContain("ai-review-js-eval");
  });

  it("keeps a static finding that the model missed", () => {
    const merged = mergeSemgrepWithLlm([], staticWrapped.accepted);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe("semgrep");
  });
});

describe("dedupe and thresholds", () => {
  it("dedupes by location and category, keeping the more severe finding", () => {
    const result = dedupeFindings([
      {
        path: "src/a.ts",
        line: 1,
        severity: "low",
        category: "bug",
        title: "low",
        body: "low severity body text",
        confidence: 0.9,
        source: "llm",
      },
      {
        path: "src/a.ts",
        line: 1,
        severity: "critical",
        category: "bug",
        title: "critical",
        body: "critical severity body text",
        confidence: 0.6,
        source: "llm",
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe("critical");
  });

  it("splits findings at the confidence threshold", () => {
    const base = {
      path: "src/a.ts",
      line: 1,
      severity: "medium" as const,
      category: "bug" as const,
      title: "t",
      body: "body text",
      source: "llm" as const,
    };
    const result = filterByConfidence(
      [
        { ...base, confidence: 0.8 },
        { ...base, line: 2, confidence: 0.4 },
      ],
      0.6,
    );
    expect(result.posted).toHaveLength(1);
    expect(result.withheld).toHaveLength(1);
  });

  it("caps findings by severity then confidence", () => {
    const base = {
      path: "src/a.ts",
      category: "bug" as const,
      title: "t",
      body: "body text",
      source: "llm" as const,
    };
    const result = capFindings(
      [
        { ...base, line: 1, severity: "low", confidence: 0.99 },
        { ...base, line: 2, severity: "critical", confidence: 0.7 },
        { ...base, line: 3, severity: "high", confidence: 0.8 },
      ],
      2,
    );
    expect(result.kept.map((finding) => finding.severity)).toEqual([
      "critical",
      "high",
    ]);
    expect(result.dropped).toHaveLength(1);
  });
});
