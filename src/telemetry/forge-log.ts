import type { JobStore } from "../jobs/store.js";

/**
 * One structured record per forge message write — reviews, issue comments,
 * replies, stack markers — plus a `maomao.forge.writes` counter point keyed
 * by op and outcome, so "is GitHub rejecting our posts?" is answerable from
 * OpenObserve without grepping job logs. Fields are usage metadata only:
 * ids, targets, and outcome — never bodies, diffs, or credentials. Callers
 * outside a job (webhook replies) pass no jobId.
 *
 * `demoted` marks a review that landed body-only after the forge rejected
 * its inline comment locations.
 */
export function logForgeWrite(
  store: Pick<JobStore, "appLog" | "appCounter">,
  input: {
    op: "review" | "comment" | "escalation_comment" | "stack_comment" | "reply";
    outcome: "posted" | "demoted" | "failed";
    provider?: string;
    repo: string;
    pr: number | null;
    jobId?: number | null;
    id?: string | null;
    url?: string | null;
    error?: string | null;
  },
): void {
  const failed = input.outcome === "failed";
  store.appLog(failed ? "forge_message_failed" : "forge_message_posted", {
    level: failed ? "error" : "info",
    provider: input.provider ?? "github",
    op: input.op,
    outcome: input.outcome,
    repo: input.repo,
    pr: input.pr,
    job_id: input.jobId ?? null,
    ...(input.id ? { id: input.id } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.error ? { error: input.error } : {}),
  });
  store.appCounter("maomao.forge.writes", { op: input.op, outcome: input.outcome });
}
