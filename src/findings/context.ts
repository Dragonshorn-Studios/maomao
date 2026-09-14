import { readFile } from "node:fs/promises";
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
  const safe = safeRepoPath(repoDir, filePath);
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

function safeRepoPath(repoDir: string, filePath: string): string | undefined {
  const full = resolve(repoDir, filePath);
  const rel = relative(repoDir, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return full;
}

function numberLines(lines: string[], start: number): string {
  return lines.map((line, index) => `${start + index}:${line}`).join("\n");
}
