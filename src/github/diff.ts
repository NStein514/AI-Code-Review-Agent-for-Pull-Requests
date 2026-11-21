export type DiffLineKind = "add" | "del" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Line number in the base revision, or null for added lines. */
  oldLine: number | null;
  /** Line number in the head revision, or null for deleted lines. */
  newLine: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  patchChars: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses a per-file unified diff (the `patch` field GitHub returns for a
 * changed file) and records head-side line numbers for every line.
 */
export function parseFilePatch(
  path: string,
  patch: string,
  status: string,
  previousPath?: string,
): FileDiff {
  const hunks: DiffHunk[] = [];
  const lines = patch.split("\n");

  let oldLine = 0;
  let newLine = 0;
  let current: DiffHunk | null = null;
  let remaining = 0;
  let additions = 0;
  let deletions = 0;

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const header = HUNK_HEADER.exec(line);

    if (header) {
      oldLine = Number(header[1]);
      const oldCount = header[2] === undefined ? 1 : Number(header[2]);
      newLine = Number(header[3]);
      const newCount = header[4] === undefined ? 1 : Number(header[4]);

      current = { header: line, oldStart: oldLine, newStart: newLine, lines: [] };
      hunks.push(current);
      remaining = oldCount + newCount;
      continue;
    }

    if (!current) continue;
    if (remaining <= 0) {
      current = null;
      continue;
    }
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"

    if (line.startsWith("+")) {
      current.lines.push({
        kind: "add",
        text: line.slice(1),
        oldLine: null,
        newLine,
      });
      newLine += 1;
      additions += 1;
      remaining -= 1;
    } else if (line.startsWith("-")) {
      current.lines.push({
        kind: "del",
        text: line.slice(1),
        oldLine,
        newLine: null,
      });
      oldLine += 1;
      deletions += 1;
      remaining -= 1;
    } else if (line.startsWith(" ") || line === "") {
      const text = line === "" ? "" : line.slice(1);
      current.lines.push({
        kind: "context",
        text,
        oldLine,
        newLine,
      });
      oldLine += 1;
      newLine += 1;
      // A context line counts toward both the old and new hunk line counts.
      remaining -= 2;
    }
  }

  return {
    path,
    ...(previousPath ? { previousPath } : {}),
    status,
    additions,
    deletions,
    hunks,
    patchChars: patch.length,
  };
}

/** Head-side line number to line text, for every line visible in the diff. */
export function buildLineIndex(diff: FileDiff): Map<number, string> {
  const index = new Map<number, string>();
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.newLine !== null) index.set(line.newLine, line.text);
    }
  }
  return index;
}

export function buildAddedLines(diff: FileDiff): Set<number> {
  const added = new Set<number>();
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add" && line.newLine !== null) added.add(line.newLine);
    }
  }
  return added;
}

/**
 * GitHub only accepts inline comments on lines that appear in the diff. When a
 * model reports a line a few rows away, snap it to the closest visible line.
 */
export function nearestReviewableLine(
  diff: FileDiff,
  line: number,
  maxDistance = 3,
): number | null {
  let best: { line: number; distance: number; added: boolean } | null = null;

  for (const hunk of diff.hunks) {
    for (const candidate of hunk.lines) {
      if (candidate.newLine === null) continue;
      const distance = Math.abs(candidate.newLine - line);
      if (distance > maxDistance) continue;
      const added = candidate.kind === "add";
      if (
        !best ||
        distance < best.distance ||
        (distance === best.distance && added && !best.added)
      ) {
        best = { line: candidate.newLine, distance, added };
      }
    }
  }

  return best?.line ?? null;
}

export function linesInRange(
  index: Map<number, string>,
  startLine: number,
  endLine: number,
): string[] | null {
  const lines: string[] = [];
  for (let line = startLine; line <= endLine; line += 1) {
    const text = index.get(line);
    if (text === undefined) return null;
    lines.push(text);
  }
  return lines;
}

export function findFileDiff(files: FileDiff[], path: string): FileDiff | undefined {
  const normalized = normalizePath(path);
  return (
    files.find((file) => file.path === normalized) ??
    files.find((file) => file.previousPath === normalized)
  );
}

export function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Renders a diff for the model with head-side line numbers so reported
 * locations can be validated against the actual patch.
 */
export function renderDiffForPrompt(
  diff: FileDiff,
  maxChars: number,
): { text: string; truncated: boolean } {
  const header = `### File: ${diff.path}${
    diff.previousPath ? ` (renamed from ${diff.previousPath})` : ""
  } [${diff.status}]`;
  const output: string[] = [header];
  let used = header.length;
  let truncated = false;

  for (const hunk of diff.hunks) {
    const block: string[] = [hunk.header];
    let blockSize = hunk.header.length;

    for (const line of hunk.lines) {
      const number = line.kind === "del" ? line.oldLine : line.newLine;
      const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
      const rendered = `${marker}${String(number ?? 0).padStart(5, " ")} | ${line.text}`;
      block.push(rendered);
      blockSize += rendered.length + 1;
    }

    if (used + blockSize > maxChars) {
      truncated = true;
      break;
    }

    output.push(...block);
    used += blockSize + 1;
  }

  if (truncated) {
    output.push("... (diff truncated to fit the review budget)");
  }

  return { text: output.join("\n"), truncated };
}

/**
 * Parses a full unified diff (as produced by `git diff` or a saved .diff file)
 * into per-file hunks. Used by the local dry-run CLI.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const allLines = text.split(/\r?\n/);
  const starts: number[] = [];
  allLines.forEach((line, index) => {
    if (line.startsWith("diff --git ")) starts.push(index);
  });

  const segments: string[][] =
    starts.length > 0
      ? starts.map((start, index) => allLines.slice(start, starts[index + 1] ?? allLines.length))
      : [allLines];

  const files: FileDiff[] = [];

  for (const segment of segments) {
    if (segment.length === 0) continue;

    const plusLine = segment.find(
      (line) => line.startsWith("+++ ") && !line.startsWith("+++ /dev/null"),
    );
    const minusLine = segment.find((line) => line.startsWith("--- "));
    const plusPath = plusLine ? parseGitPath(plusLine.slice(4)) : undefined;
    const minusPath = minusLine ? parseGitPath(minusLine.slice(4)) : undefined;
    const path = plusPath ?? minusPath;
    if (!path) continue;

    const hunkStart = segment.findIndex((line) => line.startsWith("@@"));
    if (hunkStart === -1) continue;

    const isNew = segment.some((line) => line.startsWith("new file mode"));
    const isDeleted = segment.some((line) => line.startsWith("deleted file mode"));
    const renameLine = segment.find((line) => line.startsWith("rename from "));
    const status = isNew ? "added" : isDeleted ? "removed" : renameLine ? "renamed" : "modified";

    const file = parseFilePatch(
      path,
      segment.slice(hunkStart).join("\n"),
      status,
      renameLine ? renameLine.slice("rename from ".length).trim() : undefined,
    );
    if (file.hunks.length > 0) files.push(file);
  }

  return files;
}

function parseGitPath(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/^"|"$/g, "");
  if (trimmed === "/dev/null") return undefined;
  const withoutPrefix = trimmed.replace(/^[ab]\//, "");
  return withoutPrefix.length > 0 ? withoutPrefix : undefined;
}
