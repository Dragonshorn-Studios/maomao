import type { CancelReason } from "../config.js";
import { publish } from "../events.js";
import type { JobStore } from "./store.js";

export interface CancelInput {
  reason: CancelReason;
  /** Operator login for manual actions; omitted for webhook-driven cancellation (persisted as null). */
  actor?: string;
  /** Extra context for the audit log line (e.g. the webhook delivery id). */
  note?: string;
  /**
   * Invoked with the cancelled ids immediately after the atomic UPDATE, before
   * audit logging — wire it to `queue.abortMany` so the in-memory abort does
   * not depend on logging or the HTTP response surviving. The cancellation
   * itself does not: pending jobs re-check persisted state when claimed, and
   * running jobs stop at the next pipeline checkpoint. Must be idempotent;
   * a throw here is logged and does not prevent the audit trail.
   */
  onCancelled?: (jobIds: number[]) => void;
}

export interface CancelJobsForPullInput extends CancelInput {
  repoFullName: string;
  prNumber: number;
}

/** Must be idempotent and must not throw; see CancelInput.onCancelled. */
export type AbortJobs = (jobIds: number[]) => void;

function logCancellation(store: JobStore, jobId: number, input: CancelInput): void {
  const parts = [`Cancelled (${input.reason})`];
  if (input.actor) parts.push(`by ${input.actor}`);
  if (input.note) parts.push(input.note);
  store.log(jobId, parts.join(" "));
}

function abortJobsSafely(input: CancelInput, jobIds: number[]): void {
  if (!input.onCancelled) return;
  try {
    input.onCancelled(jobIds);
  } catch (error) {
    // The cancellation is already durable; a failed in-memory abort must not
    // prevent the audit trail (workers still re-check persisted state).
    console.error(
      `cancel: queue abort hook failed after cancelling ${jobIds.length} job(s): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Cancels every non-terminal review job for one pull request (all head SHAs)
 * with the same reason. Currently the merge webhook's path; the manual UI
 * cancel actions planned in #49 are expected to go through cancelJob in this
 * same service. The state transition is one atomic UPDATE (see
 * JobStore.cancelJobs), so a worker claiming the job either sees the cancelled
 * state or the update wins the race (single-process design: synchronous
 * SQLite, one queue in memory).
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
  abortJobsSafely(input, cancelledJobIds);
  for (const id of cancelledJobIds) {
    try {
      logCancellation(store, id, input);
    } catch (error) {
      // The cancellation is already durable; a failed audit line must not hide
      // the ids from the remaining loop iterations or the caller.
      console.error(`cancel: could not write audit log for job ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    // Re-read so the error names the state that actually won the race.
    const current = store.getJob(jobId);
    return { ok: false, error: `cannot cancel a ${current?.state ?? job.state} job` };
  }
  abortJobsSafely(input, cancelled);
  try {
    logCancellation(store, jobId, input);
  } catch (error) {
    console.error(`cancel: could not write audit log for job ${jobId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  publish({ type: "job", jobId });
  publish({ type: "jobs" });
  return { ok: true, already: false };
}
