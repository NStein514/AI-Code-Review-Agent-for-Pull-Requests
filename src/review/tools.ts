/**
 * Tool schema for Claude tool use. Forcing this tool gives a structured,
 * schema-validated payload instead of prose that has to be scraped.
 */
export const SUBMIT_FINDINGS_TOOL = {
  name: "submit_findings",
  description:
    "Submit the code review findings for this pull request. Return an empty findings array when no defects were found.",
  input_schema: {
    type: "object" as const,
    properties: {
      findings: {
        type: "array",
        description: "Defects found in the changed lines of this pull request.",
        items: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Repository-relative path exactly as shown in the diff header.",
            },
            line: {
              type: "integer",
              description: "Head-side (new file) line number for the comment.",
            },
            start_line: {
              type: "integer",
              description:
                "Optional head-side start line for a multi-line comment. Must be less than line.",
            },
            severity: {
              type: "string",
              enum: ["critical", "high", "medium", "low"],
            },
            category: {
              type: "string",
              enum: [
                "bug",
                "security",
                "performance",
                "style",
                "maintainability",
                "testing",
                "docs",
                "other",
              ],
            },
            title: {
              type: "string",
              description: "One short sentence naming the defect.",
            },
            body: {
              type: "string",
              description:
                "Markdown explanation: impact, when it triggers, and how to fix it. No praise.",
            },
            suggestion: {
              type: "string",
              description:
                "Complete replacement code for the target line or range only. No markdown fences. Omit if an exact replacement is not possible.",
            },
            confidence: {
              type: "number",
              description:
                "0..1 confidence that this is a real defect the author should act on.",
            },
            evidence: {
              type: "string",
              description:
                "Exact copy of the target line's source text from the diff, without the marker or line number.",
            },
          },
          required: [
            "path",
            "line",
            "severity",
            "category",
            "title",
            "body",
            "confidence",
            "evidence",
          ],
        },
      },
      summary: {
        type: "string",
        description: "Optional one-sentence summary of the overall change risk.",
      },
    },
    required: ["findings"],
  },
};

export type SubmitFindingsTool = typeof SUBMIT_FINDINGS_TOOL;
