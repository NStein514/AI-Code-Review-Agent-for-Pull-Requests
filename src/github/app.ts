import { createAppAuth } from "@octokit/auth-app";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import type { Logger } from "pino";
import type { GitHubConfig } from "../config.js";

/**
 * GitHub secondary rate limits are common when several PRs are reviewed at
 * once. The throttling plugin spaces requests and retries primary/secondary
 * limits after the reset window; the retry plugin covers transient 5xx and
 * network failures.
 */
const AppOctokit = Octokit.plugin(retry, throttling);

const installationClients = new Map<number, Octokit>();

export function installationClient(
  credentials: Pick<GitHubConfig, "appId" | "privateKey">,
  installationId: number,
  logger?: Logger,
): Octokit {
  const cached = installationClients.get(installationId);
  if (cached) return cached;

  const client = new AppOctokit({
    authStrategy: createAppAuth,
    auth: {
      appId: Number(credentials.appId),
      privateKey: credentials.privateKey,
      installationId,
    },
    userAgent: "ai-code-review-agent/0.1",
    request: { timeout: 30_000 },
    retry: { retries: 3 },
    throttle: {
      onRateLimit: (retryAfter, options, _octokit, retryCount) => {
        logger?.warn(
          {
            method: options.method,
            url: options.url,
            retryAfterSeconds: retryAfter,
            retryCount,
          },
          "GitHub primary rate limit reached",
        );
        return retryCount < 2;
      },
      onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
        logger?.warn(
          {
            method: options.method,
            url: options.url,
            retryAfterSeconds: retryAfter,
            retryCount,
          },
          "GitHub secondary rate limit reached",
        );
        return retryCount < 2;
      },
    },
  });

  installationClients.set(installationId, client);
  return client;
}

export interface TokenClientOptions {
  logger?: Logger;
  /** GitHub Enterprise Server API base, e.g. https://ghe.example/api/v3. */
  baseUrl?: string;
}

/**
 * A token-authenticated client for CI jobs and local runs. It uses the same
 * retry/throttling behavior as installation clients but does not require a
 * GitHub App id, private key, or installation.
 */
export function tokenClient(
  token: string,
  options: TokenClientOptions = {},
): Octokit {
  const value = token.trim();
  if (value.length === 0) {
    throw new Error("A GitHub token is required for token mode");
  }

  return new AppOctokit({
    auth: value,
    userAgent: "ai-code-review-agent/0.1",
    ...(options.baseUrl
      ? { baseUrl: options.baseUrl.replace(/\/+$/, "") }
      : {}),
    request: { timeout: 30_000 },
    retry: { retries: 3 },
    throttle: {
      onRateLimit: (retryAfter, requestOptions, _octokit, retryCount) => {
        options.logger?.warn(
          {
            method: requestOptions.method,
            url: requestOptions.url,
            retryAfterSeconds: retryAfter,
            retryCount,
          },
          "GitHub primary rate limit reached",
        );
        return retryCount < 2;
      },
      onSecondaryRateLimit: (retryAfter, requestOptions, _octokit, retryCount) => {
        options.logger?.warn(
          {
            method: requestOptions.method,
            url: requestOptions.url,
            retryAfterSeconds: retryAfter,
            retryCount,
          },
          "GitHub secondary rate limit reached",
        );
        return retryCount < 2;
      },
    },
  });
}

export function resetInstallationClients(): void {
  installationClients.clear();
}
