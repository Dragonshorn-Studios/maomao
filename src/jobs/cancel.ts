import { publish } from "../events.js";
import type { JobStore } from "./store.js";

/** Why a job reached the terminal `cancelled` state. Persisted on the job row. */
export type CancelReason = "pr_merged" | "manual_dequeue" | "manual_cancel";

export interface CancelInput {
  reason: CancelReason;
  /** Operator login for manual actions; null for webhook-driven cancellation. */
  actor?: string;
  /** Extra context for the audit log line (e.g. the webhook delivery id). */
  note?: string;
}

export interface CancelJobsForPullInput extends CancelInput {
  repoFullName: string;
  prNumber: number;
}

function logCancellation(store: JobStore, jobId: number, input: CancelInput): void {
  const parts = [`Cancelled (${input.reason})`];
  if (input.actor) parts.push(`by ${input.actor}`);
  if (input.note) parts.push(input.note);
  store.log(jobId, parts.join(" "));
}

/**
 * Cancels every non-terminal review job for one pull request (all head SHAs)
 * with the same reason. This is the single cancellation path shared by the
 * merge webhook and the manual UI actions. The state transition itself is one
 * atomic UPDATE (see JobStore.cancelJobs), so a worker claiming the job either
 * sees the cancelled state or the update wins the race. Callers must follow up
 * with `queue.abortMany(ids)` to drop pending jobs from the in-memory queue and
 * cooperatively abort running ones.
 */
export function cancelJobsForPull(
  store: JobStore,
  input: CancelJobsForPullInput,
): { cancelledJobIds: number[] } {
  const cancelledJobIds = store.cancelJobs(
    { repoFullName: input.repoFullName, prNumber: input.prNumber },
    input.reason,
    input.actor ?? null,
  );
  for (const id of cancelledJobIds) {
    logCancellation(store, id, input);
    publish({ type: "job", jobId: id });
  }
  if (cancelledJobIds.length > 0) publish({ type: "jobs" });
  return { cancelledJobIds };
}

export type CancelJobResult =
  | { ok: true; already: boolean }
  | { ok: false; error: string };

/**
 * Cancels one job through the same store path as pull-wide cancellation.
 * Idempotent: an already-cancelled job reports success without writing or
 * logging again, so repeated UI submissions are safe.
 */
export function cancelJob(store: JobStore, jobId: number, input: CancelInput): CancelJobResult {
  const job = store.getJob(jobId);
  if (!job) return { ok: false, error: "job not found" };
  if (job.state === "cancelled") return { ok: true, already: true };
  const cancelled = store.cancelJobs({ jobId }, input.reason, input.actor ?? null);
  if (cancelled.length === 0) {
    return { ok: false, error: `cannot cancel a ${job.state} job` };
  }
  logCancellation(store, jobId, input);
  publish({ type: "job", jobId });
  publish({ type: "jobs" });
  return { ok: true, already: false };
}
