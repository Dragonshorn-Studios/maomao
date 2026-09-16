import type { GithubPort, ReviewThread } from "../github/client.js";
import { findingComment, isMaomaoThread, parseThreadFindingMarker } from "../github/client.js";
import { describeGithubError, isMissingGithubNodeError } from "../github/errors.js";
import type { JobRow, JobStore } from "../jobs/store.js";
import { anchoredDiffHunk } from "./context.js";
import { scanIssueMarkerBase, stripHtmlComments } from "./identity.js";
import { summarizeComment } from "./reconcile.js";
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

export interface ThreadCloseSkip {
  fingerprint: string;
  reason: string;
  /** True when we intended to close a GitHub conversation and could not. */
  wantedClose: boolean;
}

export async function applyReconciliationThreads(input: {
  github: GithubPort;
  job: JobRow;
  snapshot: ReconciliationSnapshot;
  postedFingerprints?: Iterable<string>;
}): Promise<{ resolved: string[]; skipped: ThreadCloseSkip[]; failed: Array<{ fingerprint: string; reason: string }> }> {
  const posted = new Set(input.postedFingerprints ?? []);
  const resolved: string[] = [];
  const skipped: ThreadCloseSkip[] = [];
  const failed: Array<{ fingerprint: string; reason: string }> = [];
  for (const item of input.snapshot.items) {
    if (item.githubAlreadyResolved) {
      skipped.push({
        fingerprint: item.fingerprint,
        reason: item.reason || "GitHub thread already resolved",
        wantedClose: false,
      });
      continue;
    }
    if (!item.threadId) {
      const wantedClose = item.status === "resolved" || item.status === "dismissed" || item.status === "moved";
      skipped.push({
        fingerprint: item.fingerprint,
        reason: wantedClose
          ? `classified ${item.status} but no GitHub thread id; cannot close the review conversation`
          : item.reason || `classified ${item.status}; no GitHub thread to update`,
        wantedClose,
      });
      continue;
    }
    if (item.status === "moved" && !posted.has(item.fingerprint)) {
      skipped.push({
        fingerprint: item.fingerprint,
        reason: "moved, but no replacement comment was posted; leaving the original thread open",
        wantedClose: true,
      });
      continue;
    }
    if (item.status === "resolved" || item.status === "dismissed" || item.status === "moved") {
      // Isolate failures: one bad thread id must not leave the other threads open.
      try {
        await input.github.resolveReviewThread(input.job.installation_id, item.threadId);
        resolved.push(item.fingerprint);
      } catch (error) {
        if (isMissingGithubNodeError(error)) {
          skipped.push({
            fingerprint: item.fingerprint,
            reason: `GitHub thread ${item.threadId} no longer exists; nothing left to resolve`,
            wantedClose: true,
          });
          continue;
        }
        failed.push({
          fingerprint: item.fingerprint,
          reason: describeGithubError(error),
        });
      }
    } else {
      skipped.push({
        fingerprint: item.fingerprint,
        reason: item.reason || `classified ${item.status}; leaving the thread open`,
        wantedClose: false,
      });
    }
  }
  return { resolved, skipped, failed };
}

/** Fill missing snapshot thread ids from SQLite after persistThreadsAsFindings. */
export function attachStoredThreadIds(
  store: JobStore,
  job: JobRow,
  snapshot: ReconciliationSnapshot,
): ReconciliationSnapshot {
  return {
    ...snapshot,
    items: snapshot.items.map((item) => {
      if (item.threadId) return item;
      const row = store.getFinding(job.repo_full_name, job.pr_number, item.fingerprint);
      if (!row?.github_thread_id) return item;
      return {
        ...item,
        threadId: row.github_thread_id,
        commentId: item.commentId ?? row.github_comment_id ?? undefined,
      };
    }),
  };
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
      // Thread-derived bodies carry the hidden comment marker; store clean text.
      body: item.body ? stripHtmlComments(item.body) || null : null,
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
    const comment = findingComment(thread);
    const marker = parseThreadFindingMarker(thread);
    if (!marker || !comment) continue;
    const existing = input.store.getFinding(input.job.repo_full_name, input.job.pr_number, marker.id);
    if (existing?.status === "dismissed") continue;
    // Republished fingerprint: ignore the already-resolved conversation so the
    // new open thread can attach. The obsolete thread stays resolved on GitHub.
    if (thread.isResolved && published.has(marker.id)) continue;

    let status: FindingStatus;
    let reconciliationReason: string | undefined;
    if (thread.isResolved) {
      status = "resolved";
      if (existing?.status !== "resolved") reconciliationReason = "GitHub thread already resolved";
    } else if (existing?.status === "moved" && published.has(marker.id)) {
      status = "moved";
    } else if (existing?.status === "still_valid") {
      status = "still_valid";
    } else if (existing?.status === "uncertain") {
      status = "uncertain";
    } else if (existing?.status === "resolved" && !published.has(marker.id)) {
      status = "resolved";
    } else if (published.has(marker.id)) {
      status = "open";
    } else {
      status = existing?.status ?? "open";
    }
    const threadPath = comment.path ?? thread.path ?? existing?.current_path;
    const threadLine = comment.line ?? thread.line ?? existing?.current_line;
    const context = findingDiffContext(input.diff, threadPath, threadLine);
    input.store.upsertFinding({
      repoFullName: input.job.repo_full_name,
      prNumber: input.job.pr_number,
      fingerprint: marker.id,
      status,
      reviewedSha: marker.sha || input.job.head_sha,
      currentSha: input.job.head_sha,
      githubThreadId: thread.id,
      githubCommentId: comment.databaseId != null ? String(comment.databaseId) : existing?.github_comment_id,
      originalPath: existing?.original_path ?? comment.path ?? thread.path,
      originalLine: existing?.original_line ?? comment.line ?? thread.line,
      currentPath: threadPath,
      currentLine: threadLine,
      summary: existing?.summary || summarizeComment(comment.body),
      reconciliationReason,
      diffHunk: context.diffHunk,
      diffNote: context.diffNote,
      lastJobId: input.job.id,
    });
  }
}

export async function closeResolvedScanIssues(input: {
  github: GithubPort;
  store: JobStore;
  job: JobRow;
  items: ClassifiedFinding[];
}): Promise<{
  closed: string[];
  skipped: ThreadCloseSkip[];
  failed: Array<{ fingerprint: string; reason: string }>;
}> {
  const closed: string[] = [];
  const skipped: ThreadCloseSkip[] = [];
  const failed: Array<{ fingerprint: string; reason: string }> = [];
  for (const item of input.items) {
    if (item.status !== "resolved") {
      skipped.push({
        fingerprint: item.fingerprint,
        reason: item.reason || `classified ${item.status}`,
        wantedClose: false,
      });
      continue;
    }
    const record = input.store.getScanIssue(input.job.repo_full_name, item.fingerprint);
    if (!record || record.issue_number <= 0) {
      skipped.push({
        fingerprint: item.fingerprint,
        reason: "no Maomao GitHub issue linked to this finding",
        wantedClose: false,
      });
      continue;
    }
    if (!input.github.getIssue || !input.github.closeIssue) {
      skipped.push({
        fingerprint: item.fingerprint,
        reason: "GitHub client cannot close issues",
        wantedClose: true,
      });
      continue;
    }
    try {
      const issue = await input.github.getIssue(
        input.job.installation_id,
        input.job.repo_owner,
        input.job.repo_name,
        record.issue_number,
      );
      if (!issue) {
        skipped.push({
          fingerprint: item.fingerprint,
          reason: `GitHub issue #${record.issue_number} was not found`,
          wantedClose: true,
        });
        continue;
      }
      if (issue.isPullRequest) {
        skipped.push({
          fingerprint: item.fingerprint,
          reason: `refusing to close pull request #${record.issue_number}`,
          wantedClose: true,
        });
        continue;
      }
      if (issue.state === "closed") {
        skipped.push({
          fingerprint: item.fingerprint,
          reason: `issue #${record.issue_number} is already closed`,
          wantedClose: false,
        });
        continue;
      }
      const marker = scanIssueMarkerBase(item.fingerprint);
      if (!issue.body.includes(marker)) {
        skipped.push({
          fingerprint: item.fingerprint,
          reason: `issue #${record.issue_number} is missing the Maomao scan marker; leaving it untouched`,
          wantedClose: true,
        });
        continue;
      }
      await input.github.closeIssue(
        input.job.installation_id,
        input.job.repo_owner,
        input.job.repo_name,
        record.issue_number,
      );
      closed.push(item.fingerprint);
    } catch (error) {
      failed.push({
        fingerprint: item.fingerprint,
        reason: describeGithubError(error),
      });
    }
  }
  return { closed, skipped, failed };
}
