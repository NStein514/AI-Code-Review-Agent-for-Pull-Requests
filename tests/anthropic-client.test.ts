import { describe, expect, it, vi } from "vitest";
import { parseFilePatch } from "../src/github/diff.js";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create };
  },
}));

const { ReviewerAnalyzer } = await import("../src/review/analyzer.js");

const diff = parseFilePatch(
  "src/a.ts",
  ["@@ -1,2 +1,3 @@", " before", "+const a = 1;", " after"].join("\n"),
  "modified",
);

describe("default Anthropic caller", () => {
  it("sends a forced submit_findings request and maps tool output and usage", async () => {
    create.mockResolvedValue({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "submit_findings",
          input: {
            findings: [
              {
                path: "src/a.ts",
                line: 2,
                severity: "medium",
                category: "bug",
                title: "Suspicious value",
                body: "The value looks wrong for callers of this function.",
                confidence: 0.7,
                evidence: "const a = 1;",
              },
            ],
          },
        },
      ],
      usage: { input_tokens: 11, output_tokens: 7 },
    });

    const analyzer = new ReviewerAnalyzer({
      apiKey: "test-key",
      model: "claude-test-model",
      maxTokens: 4096,
      maxDiffChars: 10_000,
    });

    const result = await analyzer.analyze({
      repoFullName: "acme/api",
      prNumber: 1,
      prTitle: "change",
      prBody: null,
      author: "dev",
      baseRef: "main",
      headRef: "feature",
      headSha: "a".repeat(40),
      files: [diff],
      omittedFiles: 0,
      semgrepFindings: [],
    });

    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0]?.[0] as {
      model: string;
      max_tokens: number;
      system: string;
      /** Forced tool choice must resolve to the findings schema. */
      tool_choice: { type: string; name: string };
      tools: Array<{
        name: string;
        input_schema: {
          required: string[];
          properties: { findings: { items: { required: string[] } } };
        };
      }>;
      messages: Array<{ role: string; content: string }>;
    };

    expect(params.model).toBe("claude-test-model");
    expect(params.max_tokens).toBe(4096);
    expect(params.tool_choice).toEqual({ type: "tool", name: "submit_findings" });
    expect(params.tools[0]?.name).toBe("submit_findings");
    expect(params.tools[0]?.input_schema.required).toEqual(["findings"]);
    expect(
      params.tools[0]?.input_schema.properties.findings.items.required,
    ).toContain("evidence");
    expect(params.system).toContain("senior software engineer");
    expect(params.messages[0]?.role).toBe("user");
    expect(params.messages[0]?.content).toContain("### File: src/a.ts");

    expect(result.findings.map((entry) => entry.title)).toEqual([
      "Suspicious value",
    ]);
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(result.failedBatches).toBe(0);
  });
});
