/**
 * Repo-brief payload assembly (issue #88): turns the validated TOC into the
 * JSON stored on `jobs.brief_json` — each section gets a bounded fragment of
 * its file read at run time. Fragments must be persisted here: workspaces are
 * swept by retention, so anything not copied into the row is gone later.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { BriefResult, BriefSection } from "../schema.js";

export const BRIEF_SECTION_MIN = 5;
export const BRIEF_SECTION_MAX = 15;
export const BRIEF_FRAGMENT_MAX_LINES = 120;
export const BRIEF_FRAGMENT_MAX_BYTES = 16 * 1024;
/** Files larger than this are not slurped for a fragment. */
const BRIEF_FILE_MAX_BYTES = 512 * 1024;

export interface BriefSectionPayload {
  title: string;
  path: string;
  summary: string;
  startLine: number | null;
  endLine: number | null;
  fragment: string | null;
  /** Why no fragment is attached: "not found" | "binary" | "too large" | "outside repo". */
  fragmentNote: string | null;
}

export interface BriefPayload {
  schema_version: number;
  kind: "repo_brief";
  repo: string;
  sha: string;
  generated_at: string;
  summary: string;
  sections: BriefSectionPayload[];
}

export function parseBriefPayload(raw: string | null | undefined): BriefPayload | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as BriefPayload;
    if (parsed?.kind !== "repo_brief" || !Array.isArray(parsed.sections)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a model-supplied path to a real file inside the checkout. Anything
 * absolute, escaping via `..`, or reaching outside through a symlink returns
 * undefined — model paths are untrusted input. A path that stays inside the
 * repo lexically but does not exist resolves anyway so the caller can report
 * "not found" rather than mislabeling it an escape.
 */
async function resolveSectionPath(repoDir: string, sectionPath: string): Promise<string | undefined> {
  if (isAbsolute(sectionPath)) return undefined;
  const repoRoot = await realpath(repoDir);
  const resolved = resolve(repoRoot, sectionPath);
  if (resolved !== repoRoot && !resolved.startsWith(repoRoot + sep)) return undefined;
  const real = await realpath(resolved).catch(() => resolved);
  if (real !== repoRoot && !real.startsWith(repoRoot + sep)) return undefined;
  return real;
}

async function extractFragment(
  repoDir: string,
  section: BriefSection,
): Promise<Pick<BriefSectionPayload, "fragment" | "fragmentNote" | "startLine" | "endLine">> {
  const file = await resolveSectionPath(repoDir, section.path);
  if (!file) {
    return { fragment: null, fragmentNote: "outside repo", startLine: null, endLine: null };
  }
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) {
    return { fragment: null, fragmentNote: "not found", startLine: null, endLine: null };
  }
  if (info.size > BRIEF_FILE_MAX_BYTES) {
    return { fragment: null, fragmentNote: "too large", startLine: null, endLine: null };
  }
  const content = await readFile(file, "utf8").catch(() => undefined);
  if (content === undefined) {
    return { fragment: null, fragmentNote: "not found", startLine: null, endLine: null };
  }
  if (content.includes("\0")) {
    return { fragment: null, fragmentNote: "binary", startLine: null, endLine: null };
  }
  const lines = content.split("\n");
  const startLine = section.start_line ?? 1;
  const start = Math.min(Math.max(startLine - 1, 0), Math.max(lines.length - 1, 0));
  const span =
    section.end_line && section.start_line
      ? Math.max(section.end_line - section.start_line + 1, 1)
      : BRIEF_FRAGMENT_MAX_LINES;
  const take = Math.min(span, BRIEF_FRAGMENT_MAX_LINES);
  let fragment = lines.slice(start, start + take).join("\n");
  const endLine = startLine + take - 1;
  if (Buffer.byteLength(fragment, "utf8") > BRIEF_FRAGMENT_MAX_BYTES) {
    fragment = Buffer.from(fragment, "utf8").subarray(0, BRIEF_FRAGMENT_MAX_BYTES).toString("utf8");
  }
  return { fragment, fragmentNote: null, startLine, endLine };
}

export async function buildBriefPayload(
  repoDir: string,
  input: { repo: string; sha: string; brief: BriefResult },
): Promise<BriefPayload> {
  const sections: BriefSectionPayload[] = [];
  for (const section of input.brief.sections) {
    const fragment = await extractFragment(repoDir, section);
    sections.push({
      title: section.title,
      path: section.path,
      summary: section.summary,
      ...fragment,
    });
  }
  return {
    schema_version: 1,
    kind: "repo_brief",
    repo: input.repo,
    sha: input.sha,
    generated_at: new Date().toISOString(),
    summary: input.brief.summary,
    sections,
  };
}
