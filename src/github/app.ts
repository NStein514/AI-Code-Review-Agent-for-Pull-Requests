import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { GitHubConfig } from "../config.js";

const installationClients = new Map<number, Octokit>();

/**
 * Returns a cached Octokit client authenticated as a specific installation.
 * Installation tokens are cached and refreshed by @octokit/auth-app.
 */
export function installationClient(
  credentials: Pick<GitHubConfig, "appId" | "privateKey">,
  installationId: number,
): Octokit {
  const cached = installationClients.get(installationId);
  if (cached) return cached;

  const client = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: Number(credentials.appId),
      privateKey: credentials.privateKey,
      installationId,
    },
    userAgent: "ai-code-review-agent/0.1",
    request: { timeout: 30_000 },
  });

  installationClients.set(installationId, client);
  return client;
}

export function resetInstallationClients(): void {
  installationClients.clear();
}
