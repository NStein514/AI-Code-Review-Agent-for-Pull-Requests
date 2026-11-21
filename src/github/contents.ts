import type { Octokit } from "@octokit/rest";

export interface SourceFile {
  path: string;
  content: string;
}

export interface FileFetchResult {
  files: SourceFile[];
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Fetches head-revision file contents for the changed files. Semgrep needs
 * real file contents, not just patches.
 */
export async function fetchSourceFiles(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    ref: string;
    paths: string[];
    maxFileBytes: number;
  },
): Promise<FileFetchResult> {
  const files: SourceFile[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const path of params.paths) {
    try {
      const response = await octokit.rest.repos.getContent({
        owner: params.owner,
        repo: params.repo,
        path,
        ref: params.ref,
      });
      const data = response.data;

      if (Array.isArray(data) || data.type !== "file") {
        skipped.push({ path, reason: "not a regular file" });
        continue;
      }
      if (typeof data.size === "number" && data.size > params.maxFileBytes) {
        skipped.push({ path, reason: "file too large for static analysis" });
        continue;
      }
      if (!data.content || data.encoding !== "base64") {
        skipped.push({ path, reason: "content not available" });
        continue;
      }

      const content = Buffer.from(data.content, "base64").toString("utf8");
      if (content.includes("\u0000")) {
        skipped.push({ path, reason: "binary file" });
        continue;
      }

      files.push({ path, content });
    } catch (error) {
      skipped.push({
        path,
        reason: error instanceof Error ? error.message : "fetch failed",
      });
    }
  }

  return { files, skipped };
}
