import type { CheckPublicationRow, JobRow } from "../jobs/store.js";

export const MERGE_READINESS_NAME = "maomao/merge-readiness";

export type MergeLifecycleState =
  | "reviewing"
  | "waiting_checks"
  | "ready"
  | "scheduled_auto_merge"
  | "github_queued"
  | "merge_group_testing"
  | "blocked"
  | "stale"
  | "merged"
  | "failed";

export interface MergeLifecycle {
  state: MergeLifecycleState;
  detail: string;
  readiness?: CheckPublicationRow;
  nativeUrl?: string;
}

/** Derives the operator-visible lifecycle from durable exact-SHA state. */
export function mergeLifecycleFor(job: JobRow, readiness: CheckPublicationRow | undefined, merged: boolean, nativeMergeScheduled = false): MergeLifecycle {
  if (merged) return { state: "merged", detail: "The forge confirmed this pull request merged.", readiness, nativeUrl: readiness?.native_url ?? undefined };
  if (job.state === "stale" || job.state === "cancelled") {
    return { state: "stale", detail: `This exact head is ${job.state}; a newer or cancelled evaluation cannot authorize a merge.`, readiness };
  }
  if (job.state === "failed") return { state: "failed", detail: job.failure_reason || "The review/check pipeline failed before readiness could be established.", readiness };
  if (!readiness) {
    return {
      state: job.state === "completed" ? "failed" : "reviewing",
      detail: "No durable merge-readiness publication exists for this exact head SHA.",
    };
  }
  if (readiness.status !== "completed") {
    const evaluating = readiness.status === "in_progress" || job.state === "publishing" || job.state === "completed";
    return { state: evaluating ? "waiting_checks" : "reviewing", detail: `Merge readiness is ${readiness.status} for this exact head SHA.`, readiness };
  }
  if (readiness.publish_error) {
    return { state: "failed", detail: `Merge readiness was computed but could not be published natively: ${readiness.publish_error}`, readiness };
  }
  if (!readiness.published_at) {
    return { state: "failed", detail: "Merge readiness was computed but native publication never completed; treat this exact head as unevaluated until publication is retried.", readiness };
  }
  if (readiness.conclusion === "success") {
    if (nativeMergeScheduled) {
      return { state: "scheduled_auto_merge", detail: "The forge-native merge-when-checks-succeed schedule was created after the latest observed head push; the forge still performs final branch-protection validation.", readiness, nativeUrl: readiness.native_url ?? undefined };
    }
    return { state: "ready", detail: "Policy-required review and deterministic checks passed for this exact head SHA.", readiness, nativeUrl: readiness.native_url ?? undefined };
  }
  if (readiness.conclusion === "failure") {
    return { state: "blocked", detail: readiness.title || "Merge readiness policy failed for this exact head SHA.", readiness };
  }
  return { state: "failed", detail: readiness.title || "Merge readiness is unavailable or requires action for this exact head SHA.", readiness };
}
