import type { GithubPort, ReviewThread } from "../github/client.js";
import { isMaomaoThread, threadRoot } from "../github/client.js";
import type { JobRow, JobStore } from "../jobs/store.js";
import { anchoredDiffHunk } from "./context.js";
import { parseFindingMarker } from "./identity.js";
import type { ClassifiedFinding, FindingDiffNote, FindingStatus, ReconciliationSnapshot } from "./types.js";

export function findingDiffContext(
  diff: string | undefined,
  path: string | null | undefined,
  line: number | null | undefined,
): { diffHunk: string | null; diffNote: FindingDiffNote | null } {
  if (!diff) return { diffHunk: null, diffNote: null };
  const result = anchoredDiffHunk(diff, path, line);
  if (result.ok) {
    const header =
      result.hunk.oldStart != null && result.hunk.newStart != null
        ? `@@ -${result.hunk.oldStart} +${result.hunk.newStart} @@\n`
        : "";
    return {
      diffHunk: header + result.hunk.lines.join("\n"),
      diffNote: result.hunk.truncated ? "truncated" : null,
    };
  }
  if (result.reason === "missing_location") {
    // No usable location hint: fall back to the file's first hunk, but say so on the card.
    const fallback = anchoredDiffHunk(diff, path, null);
    if (fallback.ok) {
      return { diffHunk: `@@ first hunk (no line recorded)\n${fallback.hunk.lines.join("\n")}`, diffNote: "no_line" };
    }
    return { diffHunk: null, diffNote: result.reason };
  }
  return { diffHunk: null, diffNote: result.reason };
}

export async function applyReconciliationThreads(input: {
  github: GithubPort;
  job: JobRow;
  snapshot: ReconciliationSnapshot;
  postedFingerprints?: Iterable<string>;
}): Promise<{ resolved: string[]; skipped: string[] }> {
  const posted = new Set(input.postedFingerprints ?? []);
  const resolved: string[] = [];
  const skipped: string[] = [];
  for (const item of input.snapshot.items) {
    if (!item.threadId) {
      skipped.push(item.fingerprint);
      continue;
    }
    if (item.status === "moved" && !posted.has(item.fingerprint)) {
      skipped.push(item.fingerprint);
      continue;
    }
    if (item.status === "resolved" || item.status === "dismissed" || item.status === "moved") {
      await input.github.resolveReviewThread(input.job.installation_id, item.threadId);
      resolved.push(item.fingerprint);
    } else {
      skipped.push(item.fingerprint);
    }
  }
  return { resolved, skipped };
}

export function persistClassifications(
  store: JobStore,
  job: JobRow,
  items: ClassifiedFinding[],
  diff?: string,
): void {
  for (const item of items) {
    const status: FindingStatus =
      item.status === "dismissed"
        ? "dismissed"
        : item.status === "resolved"
          ? "resolved"
          : item.status === "moved"
            ? "moved"
            : item.status === "still_valid"
              ? "still_valid"
              : item.status === "uncertain"
                ? "uncertain"
                : "open";
    if (status === "dismissed") {
      const existing = store.getFinding(job.repo_full_name, job.pr_number, item.fingerprint);
      if (existing?.status === "dismissed") continue;
    }
    const path = item.currentPath ?? item.originalPath;
    const line = item.currentLine ?? item.originalLine;
    const context = findingDiffContext(diff, path, line);
    store.upsertFinding({
      repoFullName: job.repo_full_name,
      prNumber: job.pr_number,
      fingerprint: item.fingerprint,
      status,
      reviewedSha: job.head_sha,
      currentSha: job.head_sha,
      githubThreadId: item.threadId,
      githubCommentId: item.commentId,
      originalPath: item.originalPath,
      originalLine: item.originalLine,
      currentPath: item.currentPath ?? item.originalPath,
      currentLine: item.currentLine ?? item.originalLine,
      category: item.category,
      summary: item.summary,
      body: item.body,
      severity: item.severity,
      confidence: item.confidence,
      reconciliationConfidence: item.confidence,
      reconciliationReason: item.reason,
      diffHunk: context.diffHunk,
      diffNote: context.diffNote,
      lastJobId: job.id,
    });
  }
}

export function persistThreadsAsFindings(input: {
  store: JobStore;
  job: JobRow;
  threads: ReviewThread[];
  postedFingerprints: string[];
  diff?: string;
}): void {
  const published = new Set(input.postedFingerprints);
  for (const thread of input.threads) {
    if (!isMaomaoThread(thread)) continue;
    const root = threadRoot(thread);
    const marker = root ? parseFindingMarker(root.body) : undefined;
    if (!marker) continue;
    const existing = input.store.getFinding(input.job.repo_full_name, input.job.pr_number, marker.id);
    if (existing?.status === "dismissed" || existing?.status === "resolved") {
      if (published.has(marker.id) && existing.status === "resolved") {
        // A moved finding was republished; attach the new thread.
      } else if (existing.status === "dismissed") {
        continue;
      } else if (existing.status === "resolved" && !published.has(marker.id)) {
        continue;
      }
    }
    const status = existing?.status === "moved" && published.has(marker.id) ? "moved" : existing?.status === "still_valid" ? "still_valid" : existing?.status === "uncertain" ? "uncertain" : published.has(marker.id) ? "open" : (existing?.status ?? "open");
    const threadPath = root?.path ?? thread.path ?? existing?.current_path;
    const threadLine = root?.line ?? thread.line ?? existing?.current_line;
    const context = findingDiffContext(input.diff, threadPath, threadLine);
    input.store.upsertFinding({
      repoFullName: input.job.repo_full_name,
      prNumber: input.job.pr_number,
      fingerprint: marker.id,
      status,
      reviewedSha: marker.sha || input.job.head_sha,
      currentSha: input.job.head_sha,
      githubThreadId: thread.id,
      githubCommentId: root?.databaseId != null ? String(root.databaseId) : existing?.github_comment_id,
      originalPath: existing?.original_path ?? root?.path ?? thread.path,
      originalLine: existing?.original_line ?? root?.line ?? thread.line,
      currentPath: threadPath,
      currentLine: threadLine,
      summary: existing?.summary || (root?.body ?? marker.id).slice(0, 240),
      diffHunk: context.diffHunk,
      diffNote: context.diffNote,
      lastJobId: input.job.id,
    });
  }
}
