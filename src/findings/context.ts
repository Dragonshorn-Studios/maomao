import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { normalizePath } from "./identity.js";

const MAX_FINDING_CHARS = 8_000;
const MAX_TOTAL_CHARS = 80_000;

export async function collectFindingContext(input: {
  repoDir: string;
  diff: string;
  path?: string;
  line?: number;
  summary: string;
}): Promise<string> {
  const parts = [`Summary: ${input.summary}`];
  if (input.path) {
    const snippet = await readSnippet(input.repoDir, input.path, input.line);
    parts.push(snippet ? `Current file ${input.path}:\n${snippet}` : `File missing at head SHA: ${input.path}`);
    const hunks = extractDiffHunks(input.diff, input.path);
    if (hunks) parts.push(`Diff hunks for ${input.path}:\n${hunks}`);
  }
  return parts.join("\n\n").slice(0, MAX_FINDING_CHARS);
}

export function boundContexts(contexts: string[]): string {
  let total = 0;
  const kept: string[] = [];
  for (const context of contexts) {
    if (total >= MAX_TOTAL_CHARS) break;
    const slice = context.slice(0, MAX_TOTAL_CHARS - total);
    kept.push(slice);
    total += slice.length;
  }
  return kept.join("\n\n---\n\n");
}

export async function readSnippet(
  repoDir: string,
  filePath: string,
  line?: number,
  radius = 40,
): Promise<string | undefined> {
  const safe = await resolveSafeRepoPath(repoDir, filePath);
  if (!safe) return undefined;
  try {
    const content = await readFile(safe, "utf8");
    const lines = content.split("\n");
    if (line == null || line < 1) {
      return numberLines(lines.slice(0, 80), 1);
    }
    const start = Math.max(0, line - 1 - radius);
    const end = Math.min(lines.length, line + radius);
    return numberLines(lines.slice(start, end), start + 1);
  } catch {
    return undefined;
  }
}

export function extractDiffHunks(diff: string, filePath: string, maxChars = 6_000): string {
  const normalized = normalizePath(filePath);
  if (!normalized || !diff) return "";
  const chunks: string[] = [];
  let inFile = false;
  let buf: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (inFile && buf.length) chunks.push(buf.join("\n"));
      buf = [line];
      inFile =
        line.includes(`a/${normalized}`) ||
        line.includes(`b/${normalized}`) ||
        line.endsWith(`/${normalized}`) ||
        line.endsWith(` ${normalized}`);
      continue;
    }
    if (inFile) buf.push(line);
  }
  if (inFile && buf.length) chunks.push(buf.join("\n"));
  const text = chunks.join("\n\n");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated]`;
}

export interface AnchoredHunk {
  lines: string[];
  oldStart: number | null;
  newStart: number | null;
  truncated: boolean;
}

export type AnchoredHunkResult =
  | { ok: true; hunk: AnchoredHunk }
  | { ok: false; reason: "file_unchanged" | "binary" | "outside_hunk" };

interface HunkLine {
  marker: "+" | "-" | " ";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Extracts a small unified hunk around `line` for `filePath` from the authoritative PR diff,
 * for display on finding cards. The model-reported line is only a hint: it must fall inside a
 * real hunk of the reviewed SHA's diff, otherwise nothing is shown (no silent remapping).
 */
export function anchoredDiffHunk(
  diff: string,
  filePath: string | null | undefined,
  line: number | null | undefined,
  contextLines = 4,
  maxChars = 1_600,
): AnchoredHunkResult {
  if (!diff || !filePath) return { ok: false, reason: "file_unchanged" };
  const normalized = normalizePath(filePath);
  const section: string[] = [];
  let inFile = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      if (inFile) break;
      inFile =
        raw.includes(`a/${normalized}`) ||
        raw.includes(`b/${normalized}`) ||
        raw.endsWith(`/${normalized}`) ||
        raw.endsWith(` ${normalized}`);
      continue;
    }
    if (inFile) section.push(raw);
  }
  if (!inFile) return { ok: false, reason: "file_unchanged" };
  if (section.some((l) => l.startsWith("GIT binary patch") || l.startsWith("Binary files"))) {
    return { ok: false, reason: "binary" };
  }

  const hunks: HunkLine[][] = [];
  let current: HunkLine[] | undefined;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of section) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      current = [];
      hunks.push(current);
      oldNo = Number(header[1]);
      newNo = Number(header[3]);
      continue;
    }
    if (!current) continue;
    const marker = raw[0];
    if (marker === "+") {
      current.push({ marker: "+", text: raw.slice(1), oldNo: null, newNo: newNo++ });
    } else if (marker === "-") {
      current.push({ marker: "-", text: raw.slice(1), oldNo: oldNo++, newNo: null });
    } else if (marker === " " || raw === "") {
      current.push({ marker: " ", text: marker === " " ? raw.slice(1) : "", oldNo: oldNo++, newNo: newNo++ });
    }
  }
  if (hunks.length === 0) return { ok: false, reason: "file_unchanged" };

  let target: { hunk: HunkLine[]; index: number } | undefined;
  if (line != null && line >= 1) {
    for (const hunk of hunks) {
      const index = hunk.findIndex((entry) => entry.newNo === line || entry.oldNo === line);
      if (index >= 0) {
        target = { hunk, index };
        break;
      }
    }
    if (!target) return { ok: false, reason: "outside_hunk" };
  } else {
    target = { hunk: hunks[0], index: 0 };
  }

  const start = Math.max(0, target.index - contextLines);
  const end = Math.min(target.hunk.length, target.index + contextLines + 1);
  const window = target.hunk.slice(start, end);
  const lines = window.map((entry) => `${entry.marker} ${entry.text}`);
  const first = window[0];
  let truncated = start > 0 || end < target.hunk.length;
  if (lines.join("\n").length > maxChars) {
    let total = 0;
    let keep = 0;
    for (const text of lines) {
      if (total + text.length > maxChars) break;
      total += text.length;
      keep += 1;
    }
    lines.length = Math.max(1, keep);
    truncated = true;
  }
  return {
    ok: true,
    hunk: {
      lines,
      oldStart: first.oldNo,
      newStart: first.newNo,
      truncated,
    },
  };
}

export async function resolveSafeRepoPath(repoDir: string, filePath: string): Promise<string | undefined> {
  const full = resolve(repoDir, filePath);
  const rel = relative(repoDir, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  try {
    const repoReal = await realpath(repoDir);
    const fileReal = await realpath(full);
    const inside = relative(repoReal, fileReal);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) return undefined;
    return fileReal;
  } catch {
    return undefined;
  }
}

function numberLines(lines: string[], start: number): string {
  return lines.map((line, index) => `${start + index}:${line}`).join("\n");
}
