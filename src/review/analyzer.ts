import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "pino";
import type { FileDiff } from "../github/diff.js";
import type { TokenUsage } from "../types.js";
import { parseLlmToolInput, type LlmFinding } from "./findings.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";
import type { SemgrepFinding } from "./semgrep.js";
import { SUBMIT_FINDINGS_TOOL } from "./tools.js";

export interface ModelRequest {
  system: string;
  user: string;
  maxTokens: number;
}

/**
 * Minimal, dependency-free view of one model call. Keeping this seam narrow
 * makes truncation handling and failure paths testable without the SDK.
 */
export interface ModelCallResult {
  stopReason: string | null;
  toolCalled: boolean;
  toolInput?: unknown;
  usage: TokenUsage;
}

export type ModelCaller = (request: ModelRequest) => Promise<ModelCallResult>;

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
  /** Top-level batches whose first attempt hit the output token limit. */
  truncatedBatches: number;
}

export interface AnalyzerLike {
  analyze(input: AnalyzeInput): Promise<AnalyzeResult>;
}

export interface AnalyzerOptions {
  apiKey: string;
  model: string;
  maxTokens: number;
  maxDiffChars: number;
  logger?: Logger;
  /** Injected for tests; defaults to the Anthropic Messages API. */
  callModel?: ModelCaller;
}

/** Upper bound for a single retry after a truncated response. */
const MAX_RETRY_OUTPUT_TOKENS = 64_000;
const MAX_SPLIT_DEPTH = 3;

interface BatchOutcome {
  findings: LlmFinding[];
  summaries: string[];
  errors: string[];
  usage: TokenUsage;
  failed: boolean;
  truncated: boolean;
}

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

function addUsage(...usages: TokenUsage[]): TokenUsage {
  return usages.reduce(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
    }),
    emptyUsage(),
  );
}

function createDefaultCaller(options: AnalyzerOptions): ModelCaller {
  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: 2,
    timeout: 180_000,
  });

  return async ({ system, user, maxTokens }) => {
    const response = await client.messages.create({
      model: options.model,
      max_tokens: maxTokens,
      system,
      tools: [SUBMIT_FINDINGS_TOOL],
      tool_choice: { type: "tool", name: SUBMIT_FINDINGS_TOOL.name },
      messages: [{ role: "user", content: user }],
    });

    const block = response.content.find((content) => content.type === "tool_use");

    return {
      stopReason: response.stop_reason ?? null,
      toolCalled: block !== undefined,
      ...(block?.type === "tool_use" ? { toolInput: block.input } : {}),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  };
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
  private readonly callModel: ModelCaller;
  private readonly maxOutputTokens: number;

  constructor(private readonly options: AnalyzerOptions) {
    this.callModel = options.callModel ?? createDefaultCaller(options);
    this.maxOutputTokens = Math.min(
      MAX_RETRY_OUTPUT_TOKENS,
      Math.max(32_000, options.maxTokens * 2),
    );
  }

  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    const batches = batchFiles(input.files, this.options.maxDiffChars);
    const findings: LlmFinding[] = [];
    const summaries: string[] = [];
    const errors: string[] = [];
    const usage = emptyUsage();
    let failedBatches = 0;
    let truncatedBatches = 0;

    for (const [index, batch] of batches.entries()) {
      const outcome = await this.reviewBatch(
        input,
        batch,
        this.options.maxTokens,
        0,
        index + 1,
      );

      findings.push(...outcome.findings);
      summaries.push(...outcome.summaries);
      errors.push(
        ...outcome.errors.map((error) => `batch ${index + 1}: ${error}`),
      );

      usage.inputTokens += outcome.usage.inputTokens;
      usage.outputTokens += outcome.usage.outputTokens;
      if (outcome.failed) failedBatches += 1;
      if (outcome.truncated) truncatedBatches += 1;
    }

    return {
      findings,
      summaries,
      errors,
      usage,
      batches: batches.length,
      failedBatches,
      truncatedBatches,
    };
  }

  /**
   * One model call plus recovery. A truncated tool payload is discarded rather
   * than partially trusted: multi-file batches are split in half, and a single
   * file is retried once with a larger output budget.
   */
  private async reviewBatch(
    input: AnalyzeInput,
    files: FileDiff[],
    maxTokens: number,
    depth: number,
    batchNumber: number,
  ): Promise<BatchOutcome> {
    if (files.length === 0) {
      return {
        findings: [],
        summaries: [],
        errors: [],
        usage: emptyUsage(),
        failed: false,
        truncated: false,
      };
    }

    const built = buildUserPrompt({
      ...input,
      files,
      maxDiffChars: this.options.maxDiffChars,
    });

    this.options.logger?.debug(
      {
        batch: batchNumber,
        depth,
        files: files.length,
        maxTokens,
        promptChars: built.prompt.length,
        truncated: built.truncated,
      },
      "sending review batch",
    );

    let response: ModelCallResult;
    try {
      response = await this.callModel({
        system: SYSTEM_PROMPT,
        user: built.prompt,
        maxTokens,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger?.error(
        { err: error, batch: batchNumber, depth },
        "review batch failed",
      );
      return {
        findings: [],
        summaries: [],
        errors: [`model request failed: ${message}`],
        usage: emptyUsage(),
        failed: true,
        truncated: false,
      };
    }

    if (response.stopReason === "max_tokens") {
      this.options.logger?.warn(
        { batch: batchNumber, depth, files: files.length, maxTokens },
        "model hit the output token limit; discarding partial result",
      );

      if (files.length > 1 && depth < MAX_SPLIT_DEPTH) {
        const midpoint = Math.ceil(files.length / 2);
        const [left, right] = await Promise.all([
          this.reviewBatch(input, files.slice(0, midpoint), this.options.maxTokens, depth + 1, batchNumber),
          this.reviewBatch(input, files.slice(midpoint), this.options.maxTokens, depth + 1, batchNumber),
        ]);

        return {
          findings: [...left.findings, ...right.findings],
          summaries: [...left.summaries, ...right.summaries],
          errors: [...left.errors, ...right.errors],
          usage: addUsage(response.usage, left.usage, right.usage),
          failed: left.failed && right.failed,
          truncated: true,
        };
      }

      const grown = Math.min(this.maxOutputTokens, maxTokens * 2);
      if (grown > maxTokens && depth < MAX_SPLIT_DEPTH + 1) {
        const retry = await this.reviewBatch(
          input,
          files,
          grown,
          depth + 1,
          batchNumber,
        );
        return {
          ...retry,
          usage: addUsage(response.usage, retry.usage),
          truncated: true,
        };
      }

      return {
        findings: [],
        summaries: [],
        errors: [
          `model output was truncated at ${maxTokens} tokens and could not be recovered`,
        ],
        usage: response.usage,
        failed: true,
        truncated: true,
      };
    }

    if (!response.toolCalled) {
      return {
        findings: [],
        summaries: [],
        errors: ["model did not call submit_findings"],
        usage: response.usage,
        failed: true,
        truncated: false,
      };
    }

    const parsed = parseLlmToolInput(response.toolInput);
    return {
      findings: parsed.findings,
      summaries: parsed.summary ? [parsed.summary] : [],
      errors: parsed.issues,
      usage: response.usage,
      failed: false,
      truncated: false,
    };
  }
}
