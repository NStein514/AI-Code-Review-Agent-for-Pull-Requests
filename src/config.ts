import { readFileSync } from "node:fs";
import { z } from "zod";

export class ConfigError extends Error {
  public override readonly name = "ConfigError";
}

type Env = Record<string, string | undefined>;

const boolFlag = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((raw) =>
      raw === undefined ? fallback : /^(1|true|yes|on)$/i.test(raw.trim()),
    );

const csvList = (fallback: string[]) =>
  z
    .string()
    .optional()
    .transform((raw) =>
      raw === undefined
        ? fallback
        : raw
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
    );

const commonSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  LOG_PRETTY: boolFlag(true),
  REVIEW_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
});

const anthropicSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().int().min(512).max(64000).default(8192),
});

const reviewSchema = z.object({
  REVIEW_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  REVIEW_MAX_FILES: z.coerce.number().int().min(1).max(200).default(20),
  REVIEW_MAX_DIFF_CHARS: z.coerce.number().int().min(2_000).max(400_000).default(60_000),
  REVIEW_MAX_FILE_PATCH_CHARS: z.coerce.number().int().min(1_000).max(400_000).default(24_000),
  REVIEW_MAX_CONTEXT_CHARS: z.coerce.number().int().min(0).max(100_000).default(12_000),
  REVIEW_CONTEXT_LINES: z.coerce.number().int().min(0).max(200).default(30),
  REVIEW_MAX_FINDINGS: z.coerce.number().int().min(1).max(100).default(25),
  REVIEW_SKIP_DRAFTS: boolFlag(true),
  REVIEW_REVIEW_FORKS: boolFlag(false),
  REVIEW_SUMMARY_ON_CLEAN: boolFlag(true),
  REVIEW_TRIGGER_ACTIONS: csvList([
    "opened",
    "reopened",
    "synchronize",
    "ready_for_review",
  ]),
  REVIEW_CUSTOM_INSTRUCTIONS: z.string().max(4_000).optional(),
});

const semgrepSchema = z.object({
  SEMGREP_ENABLED: boolFlag(true),
  SEMGREP_CONFIG: z.string().min(1).default("./semgrep/rules.yml"),
  SEMGREP_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(120_000),
  SEMGREP_MAX_FILE_BYTES: z.coerce.number().int().min(1_000).max(5_000_000).default(200_000),
});

const githubSchema = z.object({
  GITHUB_APP_ID: z
    .string()
    .regex(/^\d+$/, "GITHUB_APP_ID must be the numeric app id"),
  GITHUB_WEBHOOK_SECRET: z
    .string()
    .min(16, "GITHUB_WEBHOOK_SECRET must be at least 16 characters"),
  GITHUB_PRIVATE_KEY: z.string().optional(),
  GITHUB_PRIVATE_KEY_PATH: z.string().optional(),
});

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
}

export interface ReviewConfig {
  confidenceThreshold: number;
  maxFiles: number;
  maxDiffChars: number;
  maxFilePatchChars: number;
  maxContextChars: number;
  contextLines: number;
  maxFindings: number;
  skipDrafts: boolean;
  reviewForks: boolean;
  summaryOnClean: boolean;
  triggerActions: string[];
  customInstructions?: string;
}

export interface SemgrepConfig {
  enabled: boolean;
  config: string;
  timeoutMs: number;
  maxFileBytes: number;
}

export interface GitHubConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
}

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  logLevel: string;
  logPretty: boolean;
  reviewMaxConcurrency: number;
  github: GitHubConfig;
  anthropic: AnthropicConfig;
  review: ReviewConfig;
  semgrep: SemgrepConfig;
}

export interface LlmShellConfig {
  anthropic: AnthropicConfig;
  review: ReviewConfig;
  semgrep: SemgrepConfig;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".") || "(root)";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
}

function parse<T extends z.ZodType>(schema: T, env: Env, label: string): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(`Invalid ${label} configuration:\n${formatIssues(result.error)}`);
  }
  return result.data;
}

function resolvePrivateKey(
  inline: string | undefined,
  keyPath: string | undefined,
): string {
  if (inline && inline.trim().length > 0) {
    let value = inline.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Secrets stored in CI systems often keep escaped newlines.
    return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
  }

  if (keyPath && keyPath.trim().length > 0) {
    try {
      return readFileSync(keyPath, "utf8");
    } catch (error) {
      throw new ConfigError(
        `Could not read GITHUB_PRIVATE_KEY_PATH (${keyPath}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  throw new ConfigError(
    "Set GITHUB_PRIVATE_KEY (PEM contents) or GITHUB_PRIVATE_KEY_PATH.",
  );
}

export function loadLlmConfig(env: Env = process.env): LlmShellConfig {
  const anthropicEnv = parse(anthropicSchema, env, "Anthropic");
  const reviewEnv = parse(reviewSchema, env, "review");
  const semgrepEnv = parse(semgrepSchema, env, "Semgrep");

  return {
    anthropic: {
      apiKey: anthropicEnv.ANTHROPIC_API_KEY,
      model: anthropicEnv.ANTHROPIC_MODEL,
      maxTokens: anthropicEnv.ANTHROPIC_MAX_TOKENS,
    },
    review: {
      confidenceThreshold: reviewEnv.REVIEW_CONFIDENCE_THRESHOLD,
      maxFiles: reviewEnv.REVIEW_MAX_FILES,
      maxDiffChars: reviewEnv.REVIEW_MAX_DIFF_CHARS,
      maxFilePatchChars: reviewEnv.REVIEW_MAX_FILE_PATCH_CHARS,
      maxContextChars: reviewEnv.REVIEW_MAX_CONTEXT_CHARS,
      contextLines: reviewEnv.REVIEW_CONTEXT_LINES,
      maxFindings: reviewEnv.REVIEW_MAX_FINDINGS,
      skipDrafts: reviewEnv.REVIEW_SKIP_DRAFTS,
      reviewForks: reviewEnv.REVIEW_REVIEW_FORKS,
      summaryOnClean: reviewEnv.REVIEW_SUMMARY_ON_CLEAN,
      triggerActions: reviewEnv.REVIEW_TRIGGER_ACTIONS,
      ...(reviewEnv.REVIEW_CUSTOM_INSTRUCTIONS
        ? { customInstructions: reviewEnv.REVIEW_CUSTOM_INSTRUCTIONS }
        : {}),
    },
    semgrep: {
      enabled: semgrepEnv.SEMGREP_ENABLED,
      config: semgrepEnv.SEMGREP_CONFIG,
      timeoutMs: semgrepEnv.SEMGREP_TIMEOUT_MS,
      maxFileBytes: semgrepEnv.SEMGREP_MAX_FILE_BYTES,
    },
  };
}

export function loadConfig(env: Env = process.env): AppConfig {
  const common = parse(commonSchema, env, "application");
  const githubEnv = parse(githubSchema, env, "GitHub App");
  const { anthropic, review, semgrep } = loadLlmConfig(env);

  return {
    nodeEnv: common.NODE_ENV,
    port: common.PORT,
    logLevel: common.LOG_LEVEL,
    logPretty: common.LOG_PRETTY,
    reviewMaxConcurrency: common.REVIEW_MAX_CONCURRENCY,
    github: {
      appId: githubEnv.GITHUB_APP_ID,
      privateKey: resolvePrivateKey(
        githubEnv.GITHUB_PRIVATE_KEY,
        githubEnv.GITHUB_PRIVATE_KEY_PATH,
      ),
      webhookSecret: githubEnv.GITHUB_WEBHOOK_SECRET,
    },
    anthropic,
    review,
    semgrep,
  };
}
