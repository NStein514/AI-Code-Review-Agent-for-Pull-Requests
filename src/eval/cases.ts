import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SourceFile } from "../github/contents.js";
import {
  buildLineIndex,
  findFileDiff,
  parseUnifiedDiff,
  type FileDiff,
} from "../github/diff.js";
import { CATEGORIES, SEVERITIES } from "../review/findings.js";
import type { EvalLabel } from "./metrics.js";

const labelSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  category: z.enum(CATEGORIES),
  minSeverity: z.enum(SEVERITIES).optional(),
  note: z.string().max(500).optional(),
});

const metaSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(2_000).optional(),
  expected: z.array(labelSchema).default([]),
});

export type EvalCaseMeta = z.infer<typeof metaSchema>;

export interface EvalCase {
  name: string;
  meta: EvalCaseMeta;
  files: FileDiff[];
  /** Head-revision sources for cases that include a `repo/` tree. */
  repoFiles: SourceFile[];
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Each case directory contains `diff.patch`, `meta.json`, and optionally a
 * `repo/` tree with head-revision sources for the Semgrep baseline.
 */
export async function loadEvalCases(root: string): Promise<EvalCase[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const cases: EvalCase[] = [];

  for (const name of directories) {
    const dir = path.join(root, name);
    const diffText = await readOptional(path.join(dir, "diff.patch"));
    if (diffText === null) {
      throw new Error(`Eval case "${name}" is missing diff.patch`);
    }

    const files = parseUnifiedDiff(diffText);
    if (files.length === 0) {
      throw new Error(`Eval case "${name}" has no parseable file diffs`);
    }

    const metaText = await readOptional(path.join(dir, "meta.json"));
    if (metaText === null) {
      throw new Error(`Eval case "${name}" is missing meta.json`);
    }

    let meta: EvalCaseMeta;
    try {
      meta = metaSchema.parse(JSON.parse(metaText));
    } catch (error) {
      throw new Error(
        `Eval case "${name}" has invalid meta.json: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    for (const label of meta.expected) {
      const diff = findFileDiff(files, label.path);
      if (!diff) {
        throw new Error(
          `Eval case "${name}" labels ${label.path}:${label.line}, but that path is not in diff.patch`,
        );
      }
      if (!buildLineIndex(diff).has(label.line)) {
        throw new Error(
          `Eval case "${name}" labels ${label.path}:${label.line}, which is not a head-side line in the diff`,
        );
      }
    }

    const repoFiles: SourceFile[] = [];
    for (const file of files) {
      const content = await readOptional(
        path.join(dir, "repo", ...file.path.split("/")),
      );
      if (content !== null) repoFiles.push({ path: file.path, content });
    }

    cases.push({ name, meta, files, repoFiles });
  }

  if (cases.length === 0) {
    throw new Error(`No eval cases found in ${root}`);
  }

  return cases;
}

export function labelsForCase(meta: EvalCaseMeta): EvalLabel[] {
  return meta.expected.map((label) => ({
    path: label.path,
    line: label.line,
    category: label.category,
    ...(label.minSeverity ? { minSeverity: label.minSeverity } : {}),
    ...(label.note ? { note: label.note } : {}),
  }));
}
