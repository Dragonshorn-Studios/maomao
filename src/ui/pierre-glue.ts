/**
 * Pure helpers for embedding Maomao's finding mini-hunks into @pierre/diffs.
 *
 * Persisted hunks are synthetic: a count-less `@@ -a +b @@` header (or the
 * numberless "first hunk" variant) with no `diff --git` file header. The
 * library's parser needs a full single-file patch with consistent counts, so
 * the glue synthesizes one from the finding's path and the actual line types.
 * No DOM, no library imports — safe to unit-test directly.
 */

export interface PatchAnnotation {
  /** Which diff side the annotated line lives on. */
  side: "additions" | "deletions";
  /** Line number in that side's numbering. */
  lineNumber: number;
}

/** Classifies one hunk body line (the `@@` header and file markers excluded). */
function lineType(line: string): "add" | "del" | "ctx" {
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

/**
 * Rewrites the hunk header with counts derived from the actual body lines
 * (the persisted header is count-less, and mismatched counts make the
 * library's parser warn and drop rows).
 */
function withCorrectedCounts(rawHunk: string): string {
  const lines = rawHunk.split("\n");
  const header = lines[0] ?? "";
  const body = lines.slice(1);
  if (!header.startsWith("@@")) return rawHunk;
  let oldCount = 0;
  let newCount = 0;
  for (const line of body) {
    const type = lineType(line);
    if (type !== "add") oldCount += 1;
    if (type !== "del") newCount += 1;
  }
  // Preserve any trailing function-context after the second @@ (rare in
  // persisted hunks, but part of the unified format). Counts are always
  // explicit so the library's parser never has to guess.
  const context = header.match(/^@@ [^@]+@@\s*(.*)$/);
  const suffix = context?.[1] ? ` ${context[1]}` : "";
  return [`@@ -${oldCount},${oldCount} +${newCount},${newCount} @@${suffix}`, ...body].join("\n");
}

/**
 * Builds a complete single-file patch around a persisted mini-hunk so
 * `@pierre/diffs`' parser sees a well-formed diff (it derives the file name
 * and syntax language from the `diff --git` header).
 */
export function synthesisePatch(rawHunk: string, path: string): string {
  const safePath = path.trim() === "" ? "unknown" : path;
  return [
    `diff --git a/${safePath} b/${safePath}`,
    `--- a/${safePath}`,
    `+++ b/${safePath}`,
    withCorrectedCounts(rawHunk),
  ].join("\n");
}

/**
 * Resolves the persisted finding line (new-file numbering, from
 * `current_line ?? original_line`) to a diff line annotation. Returns
 * undefined when the line cannot be mapped onto the hunk (e.g. moved outside
 * the ±4-line window) — the card then simply renders without an inline marker
 * rather than a misleading one.
 */
export function annotationForLine(
  rawHunk: string,
  targetLine: number | null | undefined,
): PatchAnnotation | undefined {
  if (targetLine == null || !Number.isSafeInteger(targetLine) || targetLine <= 0) return undefined;
  const lines = rawHunk.split("\n");
  const header = lines[0] ?? "";
  const startMatch = header.match(/^@@ -(?:\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!startMatch) return undefined;
  let newLine = Number.parseInt(startMatch[1], 10);
  for (const line of lines.slice(1)) {
    const type = lineType(line);
    // Deletion rows have no new-file number, so they can never match a
    // persisted (new-file-numbered) finding line; ctx and add rows advance it.
    if (type === "add" || type === "ctx") {
      if (newLine === targetLine) return { side: "additions", lineNumber: targetLine };
      newLine += 1;
    }
  }
  return undefined;
}
