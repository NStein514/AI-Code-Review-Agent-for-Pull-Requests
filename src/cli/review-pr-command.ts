import process from "node:process";
import type { Logger } from "pino";
import { ConfigError, loadLlmConfig } from "../config.js";
import { tokenClient } from "../github/app.js";
import { logger as defaultLogger } from "../logger.js";
import {
  reviewPullRequest,
  type ReviewJob,
  type ReviewRuntimeConfig,
} from "../review/reviewer.js";
import type { PullRequestOutcome } from "../types.js";

export interface ReviewPrOptions {
  repo?: string;
  pullRequest?: string;
  threshold?: number;
  model?: string;
  semgrep: boolean;
  json: boolean;
  help: boolean;
}

export interface ReviewTarget {
  owner: string;
  repo: string;
  pullNumber: number;
}

export interface ReviewPrDependencies {
  review?: typeof reviewPullRequest;
  createClient?: typeof tokenClient;
  loadConfig?: typeof loadLlmConfig;
  logger?: Logger;
}

export const USAGE = `Usage: npm run review:pr -- [options]

Reviews one pull request with a GitHub token. No webhook or GitHub App is
required. Set GITHUB_TOKEN (or GH_TOKEN) and ANTHROPIC_API_KEY.

Options:
  --repo <owner/name>  Repository (default: GITHUB_REPOSITORY)
  --pr <number|url>    Pull request number or URL (default: PULL_REQUEST_NUMBER)
  --threshold <0..1>   Confidence cutoff (default: REVIEW_CONFIDENCE_THRESHOLD)
  --model <id>         Override ANTHROPIC_MODEL
  --no-semgrep         Skip the static-analysis baseline
  --json               Print the result as JSON
  --help               Show this help
`;

function parsePullRequest(value: string): { repo?: string; pullNumber: number } {
  const trimmed = value.trim();
  const url =
    /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/i.exec(trimmed);
  if (url) {
    return { repo: `${url[1]}/${url[2]}`, pullNumber: Number(url[3]) };
  }

  if (/^\d+$/.test(trimmed)) {
    const pullNumber = Number(trimmed);
    if (pullNumber > 0) return { pullNumber };
  }

  throw new Error("--pr must be a pull request number or URL");
}

export function parseArgs(argv: string[]): ReviewPrOptions {
  const options: ReviewPrOptions = {
    semgrep: true,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--repo":
        if (!next) throw new Error("--repo requires owner/name");
        options.repo = next;
        index += 1;
        break;
      case "--pr":
        if (!next) throw new Error("--pr requires a number or URL");
        options.pullRequest = next;
        index += 1;
        break;
      case "--threshold": {
        const parsed = Number(next);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          throw new Error("--threshold must be between 0 and 1");
        }
        options.threshold = parsed;
        index += 1;
        break;
      }
      case "--model":
        if (!next) throw new Error("--model requires an id");
        options.model = next;
        index += 1;
        break;
      case "--no-semgrep":
        options.semgrep = false;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (arg?.startsWith("--repo=")) {
          options.repo = arg.slice("--repo=".length);
        } else if (arg?.startsWith("--pr=")) {
          options.pullRequest = arg.slice("--pr=".length);
        } else if (arg?.startsWith("--threshold=")) {
          const parsed = Number(arg.slice("--threshold=".length));
          if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
            throw new Error("--threshold must be between 0 and 1");
          }
          options.threshold = parsed;
        } else if (arg?.startsWith("--model=")) {
          options.model = arg.slice("--model=".length);
        } else {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }
  }

  if (options.pullRequest) {
    const parsed = parsePullRequest(options.pullRequest);
    if (parsed.repo) {
      if (options.repo && options.repo !== parsed.repo) {
        throw new Error("--repo does not match the pull request URL");
      }
      options.repo = parsed.repo;
    }
  }

  return options;
}

export function resolveTarget(
  options: ReviewPrOptions,
  env: NodeJS.ProcessEnv,
): ReviewTarget {
  const repo = options.repo ?? env.GITHUB_REPOSITORY;
  const pullRequest = options.pullRequest ?? env.PULL_REQUEST_NUMBER;

  if (!repo) throw new Error("Set --repo or GITHUB_REPOSITORY");
  if (!pullRequest) throw new Error("Set --pr or PULL_REQUEST_NUMBER");

  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name || rest.length > 0) {
    throw new Error("--repo must be in owner/name form");
  }

  const parsed = parsePullRequest(pullRequest);
  if (parsed.repo && parsed.repo !== repo) {
    throw new Error("The pull request URL does not match --repo");
  }

  return { owner, repo: name, pullNumber: parsed.pullNumber };
}

export async function runReviewPr(
  options: ReviewPrOptions,
  env: NodeJS.ProcessEnv,
  deps: ReviewPrDependencies = {},
): Promise<{ outcome: PullRequestOutcome; target: ReviewTarget }> {
  const target = resolveTarget(options, env);
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (!token || token.trim().length === 0) {
    throw new Error("Set GITHUB_TOKEN or GH_TOKEN");
  }

  const shell = (deps.loadConfig ?? loadLlmConfig)(env);
  const config: ReviewRuntimeConfig = {
    ...shell,
    anthropic: {
      ...shell.anthropic,
      ...(options.model ? { model: options.model } : {}),
    },
    review: {
      ...shell.review,
      ...(options.threshold !== undefined
        ? { confidenceThreshold: options.threshold }
        : {}),
    },
    semgrep: {
      ...shell.semgrep,
      enabled: shell.semgrep.enabled && options.semgrep,
    },
  };

  const log = deps.logger ?? defaultLogger;
  const octokit = (deps.createClient ?? tokenClient)(token, {
    logger: log,
    ...(env.GITHUB_API_URL ? { baseUrl: env.GITHUB_API_URL } : {}),
  });

  const job: ReviewJob = {
    owner: target.owner,
    repo: target.repo,
    pullNumber: target.pullNumber,
    headSha: "",
    action: "manual",
  };

  const outcome = await (deps.review ?? reviewPullRequest)(config, job, log, {
    octokit,
  });

  return { outcome, target };
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let options: ReviewPrOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    console.error(USAGE);
    return 2;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  try {
    const { outcome, target } = await runReviewPr(options, env);
    if (options.json) {
      console.log(JSON.stringify({ target, outcome }, null, 2));
    } else {
      const reason = outcome.reason ? ` (${outcome.reason})` : "";
      console.log(
        `${target.owner}/${target.repo}#${target.pullNumber}: ` +
          `${outcome.status}${reason}; ${outcome.posted} posted, ` +
          `${outcome.withheld} withheld, ${outcome.filesReviewed} file(s) ` +
          `in ${(outcome.durationMs / 1000).toFixed(1)}s`,
      );
    }
    return outcome.status === "failed" ? 1 : 0;
  } catch (error) {
    console.error(
      error instanceof ConfigError
        ? error.message
        : error instanceof Error
          ? error.stack ?? error.message
          : String(error),
    );
    return 1;
  }
}
