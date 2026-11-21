import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "pino";
import type { FileDiff } from "../github/diff.js";
import type { TokenUsage } from "../types.js";
import { parseLlmToolInput, type LlmFinding } from "./findings.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";
import type { SemgrepFinding } from "./semgrep.js";
import { SUBMIT_FINDINGS_TOOL } from "./tools.js";

export interface AnalyzeInput {
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  prBody: string | null;
  author: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  files: FileDiff[];
  omittedFiles: number;
  semgrepFindings: SemgrepFinding[];
  customInstructions?: string;
}

export interface AnalyzeResult {
  findings: LlmFinding[];
  summaries: string[];
  errors: string[];
  usage: TokenUsage;
  batches: number;
  failedBatches: number;
}

export interface AnalyzerOptions {
  apiKey: string;
  model: string;
  maxTokens: number;
  maxDiffChars: number;
  logger?: Logger;
}

/**
 * Splits files so each model call stays inside the diff budget. A single huge
 * file is still sent; its diff is truncated while rendering.
 */
export function batchFiles(files: FileDiff[], maxChars: number): FileDiff[][] {
  const batches: FileDiff[][] = [];
  let current: FileDiff[] = [];
  let currentSize = 0;

  for (const file of files) {
    const estimate = file.patchChars + 250;
    if (current.length > 0 && currentSize + estimate > maxChars) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(file);
    currentSize += estimate;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

export class ReviewerAnalyzer {
  private readonly client: Anthropic;

  constructor(private readonly options: AnalyzerOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      maxRetries: 2,
      timeout: 180_000,
    });
  }

  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    const batches = batchFiles(input.files, this.options.maxDiffChars);
    const findings: LlmFinding[] = [];
    const summaries: string[] = [];
    const errors: string[] = [];
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let failedBatches = 0;

    for (const [index, batch] of batches.entries()) {
      const built = buildUserPrompt({
        ...input,
        files: batch,
        maxDiffChars: this.options.maxDiffChars,
      });

      this.options.logger?.debug(
        {
          batch: index + 1,
          batches: batches.length,
          files: batch.length,
          promptChars: built.prompt.length,
          truncated: built.truncated,
        },
        "sending review batch",
      );

      try {
        const response = await this.client.messages.create({
          model: this.options.model,
          max_tokens: this.options.maxTokens,
          system: SYSTEM_PROMPT,
          tools: [SUBMIT_FINDINGS_TOOL],
          tool_choice: { type: "tool", name: SUBMIT_FINDINGS_TOOL.name },
          messages: [{ role: "user", content: built.prompt }],
        });

        usage.inputTokens += response.usage.input_tokens;
        usage.outputTokens += response.usage.output_tokens;

        const block = response.content.find((content) => content.type === "tool_use");
        if (!block || block.type !== "tool_use") {
          failedBatches += 1;
          errors.push(`batch ${index + 1}: model did not call submit_findings`);
          continue;
        }

        const parsed = parseLlmToolInput(block.input);
        findings.push(...parsed.findings);
        if (parsed.summary) summaries.push(parsed.summary);
        if (parsed.issues.length > 0) {
          errors.push(...parsed.issues.map((issue) => `batch ${index + 1}: ${issue}`));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failedBatches += 1;
        errors.push(`batch ${index + 1}: ${message}`);
        this.options.logger?.error({ err: error, batch: index + 1 }, "review batch failed");
      }
    }

    return {
      findings,
      summaries,
      errors,
      usage,
      batches: batches.length,
      failedBatches,
    };
  }
}
