import type { Config } from "../config.js";
import type { ForgeRegistry } from "../forge/registry.js";
import { forgeTargetOf } from "../forge/types.js";
import { cancelJobsForPull } from "../jobs/cancel.js";
import { dispatchEnqueue, enqueuePullJob } from "../jobs/enqueue.js";
import type { JobQueue } from "../jobs/queue.js";
import type { JobRow, JobStore } from "../jobs/store.js";
import { repoRateLimitActive, type RepoRateLimiter } from "../github/rate-limit.js";

export type MergeReconcileOutcome = "merged" | "requeued" | "unchanged";

export interface MergeReconciliationReport {
  scanned: number;
  merged: number;
  requeued: number;
  errors: number;
}

const EMPTY_REPORT: MergeReconciliationReport = { scanned: 0, merged: 0, requeued: 0, errors: 0 };

/**
 * Read-only missed-event safety net for Forgejo pull state. Webhooks remain
 * the primary path; this worker only reads the forge, records authoritative
 * merged state, and enqueues the normal review path when the head moved. It
 * never calls Forgejo merge endpoints or creates a custom merge scheduler.
 */
export class ForgejoMergeReconciler {
  private timer?: NodeJS.Timeout;
  private beforeId: number | undefined;
  private running = false;

  constructor(
    private readonly deps: {
      config: Config;
      store: JobStore;
      queue: JobQueue;
      forge: Pick<ForgeRegistry, "forJob">;
      rateLimiter: RepoRateLimiter;
    },
    private readonly options: { intervalMs?: number; batchSize?: number } = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.reconcileNow().catch((error) => {
        console.error(`merge reconcile: batch failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.options.intervalMs ?? 5 * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async reconcileNow(): Promise<MergeReconciliationReport> {
    if (this.running) return { ...EMPTY_REPORT };
    this.running = true;
    const report: MergeReconciliationReport = { ...EMPTY_REPORT };
    try {
      const page = this.deps.store.listLatestPullReviewJobsPage({
        ...(this.beforeId ? { beforeId: this.beforeId } : {}),
        limit: this.options.batchSize ?? 10,
        provider: "forgejo",
      });
      if (page.jobs.length === 0) {
        this.beforeId = undefined;
        return report;
      }
      this.beforeId = page.hasMore ? page.jobs[page.jobs.length - 1]!.id : undefined;
      for (const job of page.jobs) {
        report.scanned += 1;
        try {
          const outcome = await this.reconcileJob(job);
          if (outcome === "merged") report.merged += 1;
          if (outcome === "requeued") report.requeued += 1;
        } catch (error) {
          report.errors += 1;
          console.warn(
            `merge reconcile: ${job.repo_full_name}#${job.pr_number} could not be read: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return report;
    } finally {
      this.running = false;
    }
  }

  private async reconcileJob(job: JobRow): Promise<MergeReconcileOutcome> {
    if (job.job_type !== "pr_review" || job.provider !== "forgejo") return "unchanged";
    const scope = { provider: job.provider, instance: job.provider_instance };
    if (this.deps.store.hasMergedPull(job.repo_full_name, job.pr_number, scope)) return "unchanged";
    const change = await this.deps.forge.forJob(job).getChange(forgeTargetOf(job));
    if (change.merged === true) {
      this.deps.store.markPullMerged(job.repo_full_name, job.pr_number, null, scope, change.headSha);
      cancelJobsForPull(this.deps.store, {
        repoFullName: job.repo_full_name,
        prNumber: job.pr_number,
        scope,
        reason: "pr_merged",
        note: "periodic Forgejo reconciliation",
        onCancelled: (jobIds) => this.deps.queue.abortMany(jobIds),
      });
      return "merged";
    }
    if (change.closed === true || !change.headSha || change.headSha === job.head_sha) return "unchanged";
    if (this.deps.store.getGlobalPause() || this.deps.store.getActivePause(job.repo_full_name, job.provider, job.provider_instance)) return "unchanged";
    if (change.draft && !this.deps.config.reviewDrafts) return "unchanged";
    const rateOn = repoRateLimitActive(this.deps.config.repoRateLimitPerWindow, this.deps.config.repoRateWindowMs);
    const rateKey = `forgejo:${job.provider_instance}:${job.installation_id || job.repo_full_name}`;
    if (rateOn && !this.deps.rateLimiter.wouldAllowKey(rateKey, this.deps.config.repoRateLimitPerWindow, this.deps.config.repoRateWindowMs)) return "unchanged";

    const enqueue = enqueuePullJob(this.deps.store, this.deps.config, {
      repoFullName: job.repo_full_name,
      repoOwner: job.repo_owner,
      repoName: job.repo_name,
      installationId: job.installation_id,
      provider: job.provider,
      providerInstance: job.provider_instance,
      forgeConnectionId: job.forge_connection_id,
      prNumber: job.pr_number,
      prTitle: change.title,
      prBody: change.body,
      prHtmlUrl: change.htmlUrl,
      prAuthor: change.author,
      baseSha: change.baseSha,
      headSha: change.headSha,
      baseRef: change.baseRef,
      headRef: change.headRef,
      webhookEvent: "forgejo.periodic_reconcile",
    });
    if (enqueue.created && rateOn) {
      this.deps.rateLimiter.recordKey(rateKey, this.deps.config.repoRateLimitPerWindow, this.deps.config.repoRateWindowMs);
    }
    dispatchEnqueue(this.deps.queue, enqueue);
    return enqueue.created ? "requeued" : "unchanged";
  }
}
