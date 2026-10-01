import { createHash } from "node:crypto";
import type { JobRow, JobStore, ReviewerRunRow, StackMemberRow } from "../jobs/store.js";
import { buildJobSummary, type JobSummaryOptions } from "../jobs/summary.js";
import { attr, exportTraces, nanoTime, type OtlpAttribute, type OtlpSpan } from "./otlp.js";

/**
 * OpenObserve traces slice (issue #142, meta #138): one OTLP/HTTP trace per
 * terminal job run on the #143 exporter. Spans are reconstructed at terminal
 * time from the same persisted timings the job-summary snapshot reads —
 * routing/aggregator columns on the job row, `reviewer_runs` rows — so the
 * trace always agrees with the stdout line and the #141 metrics, and no
 * tracing context has to thread through the pipeline.
 *
 *   maomao.job.<job_type>            root; job/repo/pr/state/attempt attrs
 *     maomao.stage.routing           routing_duration_ms from job start
 *     maomao.stage.reviewer          one per reviewer_runs row
 *     maomao.stage.aggregation       aggregator_started_at → finished_at
 *     maomao.stage.internal_escalation   duration_ms after aggregation
 *
 * Stack linkage: a member pr_review job emits into the stack_review job's
 * trace — traceId/spanId are deterministic hashes of the job id, so a member
 * job can parent its root span to the stack root without any shared state or
 * in-flight context propagation (the "parent" option the issue offers). A
 * member's stage spans ride the same trace. For stack members that never got
 * a member job (skipped), the stack job emits a zero-duration
 * `maomao.stack.member` marker so the trace still shows them.
 *
 * Usage metadata only (hard rule from #139): ids, states, durations, token
 * counts — no PII, secrets, diff text, or review bodies.
 */

/** Deterministic ids let a member job join its stack's trace without storage. */
const hexId = (seed: string, len: number): string => createHash("sha256").update(seed).digest("hex").slice(0, len);
export const traceIdForJob = (jobId: number): string => hexId(`maomao-job-${jobId}`, 32);
const spanIdForJob = (jobId: number): string => hexId(`maomao-job-${jobId}-root`, 16);
const spanIdForStage = (jobId: number, tag: string): string => hexId(`maomao-job-${jobId}-stage-${tag}`, 16);

const msOf = (iso: string | null): number | null => {
  if (iso == null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};

const usageAttrs = (model: string | null, totalTokens: number | null, cost: number | null): OtlpAttribute[] => {
  const attrs: OtlpAttribute[] = [];
  if (model) attrs.push(attr("model", model));
  if (totalTokens != null) attrs.push(attr("total_tokens", totalTokens));
  if (cost != null) attrs.push(attr("cost_usd", cost));
  return attrs;
};

const statusFor = (state: string): { code: number; message?: string } =>
  state === "completed" || state === "done" ? { code: 1 } : { code: 2, message: state };

/**
 * All spans for one terminal job run. `membership` is the stack run this job
 * is a member of (null for standalone jobs); `members` is the stack member
 * rows when this job IS the stack_review (for skipped-member markers).
 */
export function jobTrace(
  job: JobRow,
  runs: ReviewerRunRow[],
  opts?: JobSummaryOptions,
  membership: { stackJobId: number; position: number } | null = null,
  members: Pick<StackMemberRow, "position" | "pr_number" | "member_job_id" | "state">[] = [],
): OtlpSpan[] {
  const summary = buildJobSummary(job, runs, opts);
  const startMs = msOf(job.started_at) ?? msOf(job.created_at) ?? Date.now();
  const endMs = msOf(job.finished_at) ?? Date.now();
  const traceId = traceIdForJob(membership ? membership.stackJobId : job.id);
  const rootId = spanIdForJob(job.id);

  const rootAttrs: OtlpAttribute[] = [
    attr("job_id", job.id),
    attr("job_type", job.job_type),
    attr("repo", job.repo_full_name),
    attr("provider_instance", job.provider_instance),
    attr("pr_number", job.pr_number),
    attr("state", summary.state),
    attr("attempt", summary.attempt),
    attr("usage_complete", summary.usage_complete),
    attr("head_sha", job.head_sha),
  ];
  const createdMs = msOf(job.created_at);
  if (createdMs != null && msOf(job.started_at) != null) {
    rootAttrs.push(attr("queued_ms", Math.max(0, startMs - createdMs)));
  }
  if (membership) {
    rootAttrs.push(attr("stack_job_id", membership.stackJobId), attr("stack_position", membership.position));
  }

  const spans: OtlpSpan[] = [
    {
      traceId,
      spanId: rootId,
      ...(membership ? { parentSpanId: spanIdForJob(membership.stackJobId) } : {}),
      name: `maomao.job.${job.job_type}`,
      kind: 1,
      startTimeUnixNano: nanoTime(startMs),
      endTimeUnixNano: nanoTime(Math.max(endMs, startMs)),
      attributes: rootAttrs,
      status: statusFor(job.state),
    },
  ];

  // Stage spans walk a cursor: routing and internal escalation only record
  // duration_ms, so they hang off the surrounding timestamps.
  let cursor = startMs;

  if (job.routing_duration_ms != null) {
    spans.push({
      traceId,
      spanId: spanIdForStage(job.id, "routing"),
      parentSpanId: rootId,
      name: "maomao.stage.routing",
      startTimeUnixNano: nanoTime(cursor),
      endTimeUnixNano: nanoTime(cursor + job.routing_duration_ms),
      attributes: [
        attr("state", job.routing_state ?? "done"),
        ...usageAttrs(job.routing_model, job.routing_total_tokens, job.routing_cost),
        ...(job.routing_profile ? [attr("profile", job.routing_profile)] : []),
        ...(job.routing_mode ? [attr("mode", job.routing_mode)] : []),
      ],
    });
    cursor = Math.max(cursor, cursor + job.routing_duration_ms);
  }

  runs.forEach((run) => {
    // A run row that never left 'queued' has no timing to span over.
    if (run.started_at == null && run.finished_at == null && run.duration_ms == null) return;
    const runStart = msOf(run.started_at) ?? cursor;
    const runEnd = msOf(run.finished_at) ?? (run.duration_ms != null ? runStart + run.duration_ms : runStart);
    spans.push({
      traceId,
      spanId: spanIdForStage(job.id, `reviewer-${run.id}`),
      parentSpanId: rootId,
      name: "maomao.stage.reviewer",
      startTimeUnixNano: nanoTime(runStart),
      endTimeUnixNano: nanoTime(Math.max(runEnd, runStart)),
      attributes: [
        attr("reviewer_role", run.role),
        attr("state", run.state),
        attr("attempt", run.attempt),
        ...usageAttrs(run.model, run.total_tokens, run.cost),
      ],
      status: statusFor(run.state),
    });
    cursor = Math.max(cursor, runEnd);
  });

  const aggStart = msOf(job.aggregator_started_at) ?? null;
  const aggEnd = msOf(job.aggregator_finished_at) ?? null;
  if (aggStart != null || job.aggregator_duration_ms != null) {
    const start = aggStart ?? cursor;
    const end = aggEnd ?? start + (job.aggregator_duration_ms ?? 0);
    spans.push({
      traceId,
      spanId: spanIdForStage(job.id, "aggregation"),
      parentSpanId: rootId,
      name: "maomao.stage.aggregation",
      startTimeUnixNano: nanoTime(start),
      endTimeUnixNano: nanoTime(Math.max(end, start)),
      attributes: [
        attr("state", job.aggregator_state),
        ...(job.aggregator_fallback ? [attr("fallback", true)] : []),
        ...usageAttrs(job.aggregator_model, job.aggregator_total_tokens, job.aggregator_cost),
      ],
    });
    cursor = Math.max(cursor, end);
  }

  if (job.internal_escalation_duration_ms != null) {
    spans.push({
      traceId,
      spanId: spanIdForStage(job.id, "internal-escalation"),
      parentSpanId: rootId,
      name: "maomao.stage.internal_escalation",
      startTimeUnixNano: nanoTime(cursor),
      endTimeUnixNano: nanoTime(cursor + job.internal_escalation_duration_ms),
      attributes: [
        attr("state", job.internal_escalation_state ?? "done"),
        ...(job.internal_escalation_alert_cleared != null
          ? [attr("alert_cleared", job.internal_escalation_alert_cleared === 1)]
          : []),
        ...usageAttrs(job.internal_escalation_model, job.internal_escalation_total_tokens, job.internal_escalation_cost),
      ],
    });
  }

  // Skipped stack members (never got a member job) still show in the trace.
  for (const member of members) {
    if (member.member_job_id != null) continue;
    spans.push({
      traceId,
      spanId: spanIdForStage(job.id, `member-${member.position}`),
      parentSpanId: rootId,
      name: "maomao.stack.member",
      startTimeUnixNano: nanoTime(endMs),
      endTimeUnixNano: nanoTime(endMs),
      attributes: [
        attr("pr_number", member.pr_number),
        attr("position", member.position),
        attr("state", member.state),
      ],
    });
  }

  return spans;
}

/**
 * Emit the terminal-run trace for one job. Same call site and snapshot
 * options as `emitJobSummary`/`exportTerminalJobMetrics`; never throws and
 * no-ops unless OPENOBSERVE_TRACES_URL is configured.
 */
export function exportTerminalJobTraces(
  store: Pick<JobStore, "getJob" | "listReviewerRuns" | "listStackMembers" | "stackMembershipForJobs">,
  jobId: number,
  env: NodeJS.ProcessEnv = process.env,
  opts?: JobSummaryOptions,
): void {
  try {
    const job = opts?.job ?? store.getJob(jobId);
    if (!job) return;
    const membership = store.stackMembershipForJobs([job.id]).get(job.id) ?? null;
    const members = job.job_type === "stack_review" ? store.listStackMembers(job.id) : [];
    exportTraces(
      jobTrace(job, opts?.runs ?? store.listReviewerRuns(job.id), opts, membership, members),
      env,
    );
  } catch (error) {
    console.error(
      `otlp: terminal trace failed for job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
