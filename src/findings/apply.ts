import type { GithubPort, ReviewThread } from "../github/client.js";
import { isMaomaoThread, threadRoot } from "../github/client.js";
import type { JobRow, JobStore } from "../jobs/store.js";
import { parseFindingMarker } from "./identity.js";
import type { ClassifiedFinding, FindingStatus, ReconciliationSnapshot } from "./types.js";

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

export function persistClassifications(store: JobStore, job: JobRow, items: ClassifiedFinding[]): void {
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
      lastJobId: job.id,
    });
  }
}

export function persistThreadsAsFindings(input: {
  store: JobStore;
  job: JobRow;
  threads: ReviewThread[];
  publishedFingerprints: string[];
}): void {
  const published = new Set(input.publishedFingerprints);
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
      currentPath: root?.path ?? thread.path ?? existing?.current_path,
      currentLine: root?.line ?? thread.line ?? existing?.current_line,
      summary: existing?.summary || (root?.body ?? marker.id).slice(0, 240),
      lastJobId: input.job.id,
    });
  }
}
