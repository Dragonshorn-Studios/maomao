import { createHash } from "node:crypto";
import type { JobRow, JobStore, ReviewerRunRow, StackMemberRow } from "../jobs/store.js";
import { buildJobSummary, type JobSummaryOptions } from "../jobs/summary.js";
import {
  attr,
  compatDoubleAttr,
  exportTraces,
  nanoTime,
  SPAN_KIND_CLIENT,
  SPAN_KIND_INTERNAL,
  STATUS_CODE_ERROR,
  STATUS_CODE_OK,
  STATUS_CODE_UNSET,
  type OtlpAttribute,
  type OtlpSpan,
} from "./otlp.js";
import type { TelemetryChannelConfig, TelemetrySharedConfig } from "./settings.js";

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
  if (cost != null) {
    attrs.push(compatDoubleAttr("cost_usd", cost), attr("cost_usd_micros", Math.round(cost * 1e6)));
  }
  return attrs;
};

/**
 * OTel gen_ai semantic attributes — OpenObserve's AI observability reads
 * these server-side off any LLM-call span (model, provider, token usage,
 * cost, cache hits). Emitted alongside our own usage attrs; usage metadata
 * only, never prompt content.
 */
const genAiAttrs = (opts: {
  provider?: string | null;
  model?: string | null;
  /** Whether the stage actually got a model response back — controls response.model. */
  responded?: boolean;
  /** Session id grouping a job's model calls for OO AI Observability Sessions. */
  conversationId?: string | null;
  /** Session owner for the Sessions user column (the PR author). */
  userId?: string | null;
  /** Agent node identity for OO Agent Graph/Insights rollups. */
  agentName?: string | null;
  agentId?: string | null;
  promptName?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  cost?: number | null;
}): OtlpAttribute[] => {
  const attrs: OtlpAttribute[] = [attr("gen_ai.operation.name", "chat")];
  if (opts.provider) attrs.push(attr("gen_ai.provider.name", opts.provider));
  if (opts.conversationId) {
    attrs.push(
      attr("gen_ai.conversation.id", opts.conversationId),
      // OTel session.id is the first key OO's session-id extractor checks and
      // canonicalizes to gen_ai_conversation_id; emitting both covers builds
      // whose extractor predates the gen_ai key.
      attr("session.id", opts.conversationId),
    );
  }
  if (opts.userId) attrs.push(attr("user.id", opts.userId));
  if (opts.agentName) attrs.push(attr("gen_ai.agent.name", opts.agentName));
  if (opts.agentId) attrs.push(attr("gen_ai.agent.id", opts.agentId));
  if (opts.model) {
    attrs.push(attr("gen_ai.request.model", opts.model));
    // response.model is only honest when the call returned something.
    if (opts.responded !== false) attrs.push(attr("gen_ai.response.model", opts.model));
  }
  if (opts.promptName) attrs.push(attr("gen_ai.prompt.name", opts.promptName));
  if (opts.promptTokens != null) {
    attrs.push(
      attr("gen_ai.usage.prompt_tokens", opts.promptTokens),
      attr("gen_ai.usage.input_tokens", opts.promptTokens),
    );
  }
  if (opts.completionTokens != null) {
    attrs.push(
      attr("gen_ai.usage.completion_tokens", opts.completionTokens),
      attr("gen_ai.usage.output_tokens", opts.completionTokens),
    );
  }
  if (opts.totalTokens != null) attrs.push(attr("gen_ai.usage.total_tokens", opts.totalTokens));
  if (opts.cacheRead != null) attrs.push(attr("gen_ai.usage.cache_read_tokens", opts.cacheRead));
  if (opts.cacheWrite != null) attrs.push(attr("gen_ai.usage.cache_write_tokens", opts.cacheWrite));
  if (opts.cost != null) attrs.push(compatDoubleAttr("gen_ai.usage.cost", opts.cost));
  return attrs;
};

// `stale`/`cancelled` are retirement outcomes, not failures — UNSET keeps the
// span out of error rollups; anything else non-terminal is a real failure.
const statusFor = (state: string): { code: number; message?: string } =>
  state === "completed" || state === "done"
    ? { code: STATUS_CODE_OK }
    : state === "stale" || state === "cancelled"
      ? { code: STATUS_CODE_UNSET }
      : { code: STATUS_CODE_ERROR, message: state };

const exceptionEvent = (
  type: string,
  message: string | null | undefined,
  timeUnixNano: string,
): OtlpSpan["events"] => [
  {
    name: "exception",
    timeUnixNano,
    attributes: [
      attr("exception.type", type),
      ...(message ? [attr("exception.message", message.slice(0, 500))] : []),
    ],
  },
];

/** Spawn → first OpenCode stdout event marker (cold start + TTFT). */
const firstOutputEvent = (
  firstOutputMs: number | null,
  startMs: number,
): OtlpSpan["events"] =>
  firstOutputMs == null
    ? undefined
    : [
        {
          name: "opencode.first_output",
          timeUnixNano: nanoTime(startMs + firstOutputMs),
          attributes: [attr("elapsed_ms", firstOutputMs)],
        },
      ];

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
  // The job is the session: every LLM-call span in this trace shares it so
  // OpenObserve Sessions/Insights group a job's model calls as one conversation.
  const conversationId = `maomao-job-${job.id}`;

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
    // The whole trace is the session — tag the root too, not just LLM spans.
    attr("session.id", conversationId),
    attr("gen_ai.conversation.id", conversationId),
    // Same falsy gate as genAiAttrs' userId — no empty-string user.id.
    ...(job.pr_author ? [attr("user.id", job.pr_author)] : []),
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
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: nanoTime(startMs),
      endTimeUnixNano: nanoTime(Math.max(endMs, startMs)),
      attributes: rootAttrs,
      status: statusFor(job.state),
      events:
        job.state === "failed"
          ? exceptionEvent("failed", job.failure_reason, nanoTime(Math.max(endMs, startMs)))
          : undefined,
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
      kind: SPAN_KIND_CLIENT,
      attributes: [
        attr("state", job.routing_state ?? "done"),
        ...usageAttrs(job.routing_model, job.routing_total_tokens, job.routing_cost),
        ...genAiAttrs({
          provider: job.routing_provider,
          model: job.routing_model,
          // "fallback" means the router call failed and diagnosis decided.
          responded: job.routing_source !== "fallback",
          conversationId,
          userId: job.pr_author,
          agentName: "maomao-router",
          agentId: "maomao-router",
          totalTokens: job.routing_total_tokens,
          cost: job.routing_cost,
        }),
        ...(job.routing_profile ? [attr("profile", job.routing_profile)] : []),
        ...(job.routing_mode ? [attr("mode", job.routing_mode)] : []),
      ],
      status:
        job.routing_source === "fallback"
          ? { code: STATUS_CODE_ERROR, message: "router model call failed" }
          : { code: STATUS_CODE_OK },
      events:
        job.routing_source === "fallback"
          ? exceptionEvent("model_call_failed", "router model call failed", nanoTime(cursor + job.routing_duration_ms))
          : firstOutputEvent(job.routing_first_output_ms, cursor),
    });
    cursor = Math.max(cursor, cursor + job.routing_duration_ms);
  }

  runs.forEach((run) => {
    // A run row that never left 'queued' has no timing to span over.
    if (run.started_at == null && run.finished_at == null && run.duration_ms == null) return;
    const runStart = msOf(run.started_at) ?? cursor;
    const runEnd = msOf(run.finished_at) ?? (run.duration_ms != null ? runStart + run.duration_ms : runStart);
    // started_at is stamped when the model call begins; budget-skipped runs
    // get only state=failed + finished_at (model is seeded at enqueue, so it
    // can't discriminate). Same gate as aggregation: no call, no CLIENT/chat.
    const ranLlm = run.started_at != null || run.total_tokens != null || run.cost != null;
    spans.push({
      traceId,
      spanId: spanIdForStage(job.id, `reviewer-${run.id}`),
      parentSpanId: rootId,
      name: "maomao.stage.reviewer",
      kind: ranLlm ? SPAN_KIND_CLIENT : SPAN_KIND_INTERNAL,
      startTimeUnixNano: nanoTime(runStart),
      endTimeUnixNano: nanoTime(Math.max(runEnd, runStart)),
      attributes: [
        attr("reviewer_role", run.role),
        attr("state", run.state),
        attr("attempt", run.attempt),
        ...usageAttrs(run.model, run.total_tokens, run.cost),
        ...(ranLlm
          ? genAiAttrs({
              provider: run.provider,
              model: run.model,
              responded: run.state === "done",
              conversationId,
              userId: job.pr_author,
              agentName: run.role,
              agentId: `reviewer.${run.role}`,
              promptName: run.role,
              promptTokens: run.prompt_tokens,
              completionTokens: run.completion_tokens,
              totalTokens: run.total_tokens,
              cacheRead: run.cache_read_tokens,
              cacheWrite: run.cache_write_tokens,
              cost: run.cost,
            })
          : []),
        ...(run.state === "failed" ? [attr("error.type", run.state)] : []),
      ],
      status: statusFor(run.state),
      events:
        run.state === "failed"
          ? exceptionEvent("failed", run.validation_error, nanoTime(Math.max(runEnd, runStart)))
          : firstOutputEvent(run.first_output_ms, runStart),
    });
    cursor = Math.max(cursor, runEnd);
  });

  const aggStart = msOf(job.aggregator_started_at) ?? null;
  const aggEnd = msOf(job.aggregator_finished_at) ?? null;
  if (aggStart != null || job.aggregator_duration_ms != null) {
    const start = aggStart ?? cursor;
    const end = aggEnd ?? start + (job.aggregator_duration_ms ?? 0);
    // Budget-degraded aggregations null the model — they never called an LLM,
    // so they stay INTERNAL and carry no gen_ai attrs; a model that was
    // attempted (fallback on failure) keeps CLIENT + gen_ai.
    const ranLlm =
      job.aggregator_model != null ||
      job.aggregator_total_tokens != null ||
      job.aggregator_cost != null;
    spans.push({
      traceId,
      spanId: spanIdForStage(job.id, "aggregation"),
      parentSpanId: rootId,
      name: "maomao.stage.aggregation",
      kind: ranLlm ? SPAN_KIND_CLIENT : SPAN_KIND_INTERNAL,
      startTimeUnixNano: nanoTime(start),
      endTimeUnixNano: nanoTime(Math.max(end, start)),
      attributes: [
        attr("state", job.aggregator_state),
        ...(job.aggregator_fallback ? [attr("fallback", true)] : []),
        ...usageAttrs(job.aggregator_model, job.aggregator_total_tokens, job.aggregator_cost),
        ...(ranLlm
          ? genAiAttrs({
              provider: job.aggregator_provider,
              model: job.aggregator_model,
              // Model-failure fallback and a job that died mid-aggregation
              // both left no model response; only "done" + no fallback did.
              responded: job.aggregator_state === "done" && job.aggregator_fallback !== 1,
              conversationId,
              userId: job.pr_author,
              agentName: "maomao-aggregator",
              agentId: "maomao-aggregator",
              totalTokens: job.aggregator_total_tokens,
              cost: job.aggregator_cost,
            })
          : []),
      ],
      // Model-failure fallback or a failed/mid-aggregation-abort row = an
      // attempted LLM call that failed; budget degradation is a successful
      // deterministic result, not an error.
      status:
        ranLlm && (job.aggregator_fallback === 1 || job.aggregator_state !== "done")
          ? { code: STATUS_CODE_ERROR, message: "aggregator model call failed" }
          : { code: STATUS_CODE_OK },
      events:
        ranLlm && (job.aggregator_fallback === 1 || job.aggregator_state !== "done")
          ? exceptionEvent("model_call_failed", "aggregator model call failed", nanoTime(Math.max(end, start)))
          : firstOutputEvent(job.aggregator_first_output_ms, start),
    });
    cursor = Math.max(cursor, end);
  }

  if (job.internal_escalation_duration_ms != null) {
    spans.push({
      traceId,
      spanId: spanIdForStage(job.id, "internal-escalation"),
      parentSpanId: rootId,
      name: "maomao.stage.internal_escalation",
      kind: SPAN_KIND_CLIENT,
      startTimeUnixNano: nanoTime(cursor),
      endTimeUnixNano: nanoTime(cursor + job.internal_escalation_duration_ms),
      attributes: [
        attr("state", job.internal_escalation_state ?? "done"),
        ...(job.internal_escalation_alert_cleared != null
          ? [attr("alert_cleared", job.internal_escalation_alert_cleared === 1)]
          : []),
        ...usageAttrs(job.internal_escalation_model, job.internal_escalation_total_tokens, job.internal_escalation_cost),
        ...genAiAttrs({
          provider: job.internal_escalation_provider,
          model: job.internal_escalation_model,
          responded: job.internal_escalation_state === "done",
          conversationId,
          userId: job.pr_author,
          agentName: "maomao-internal-escalation",
          agentId: "maomao-internal-escalation",
          totalTokens: job.internal_escalation_total_tokens,
          cost: job.internal_escalation_cost,
        }),
      ],
      status: statusFor(job.internal_escalation_state ?? "done"),
      events:
        job.internal_escalation_state != null && job.internal_escalation_state !== "done"
          ? exceptionEvent(
              job.internal_escalation_state,
              "internal escalation model call failed",
              nanoTime(cursor + job.internal_escalation_duration_ms),
            )
          : firstOutputEvent(job.internal_escalation_first_output_ms, cursor),
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
  stored?: TelemetryChannelConfig,
  shared?: TelemetrySharedConfig,
  logsStored?: TelemetryChannelConfig,
  appLogs = true,
): void {
  try {
    const job = opts?.job ?? store.getJob(jobId);
    if (!job) return;
    const membership = store.stackMembershipForJobs([job.id]).get(job.id) ?? null;
    const members = job.job_type === "stack_review" ? store.listStackMembers(job.id) : [];
    exportTraces(
      jobTrace(job, opts?.runs ?? store.listReviewerRuns(job.id), opts, membership, members),
      env,
      stored,
      shared,
      logsStored,
      appLogs,
    );
  } catch (error) {
    console.error(
      `otlp: terminal trace failed for job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
