import type { JobState } from "../config.js";
import { tokenTotalFromRow } from "../opencode/parse.js";
import { resolveChannelUrl, type TelemetryChannelConfig, type TelemetrySharedConfig } from "../telemetry/settings.js";
import {
  flushIngestPosts,
  ingestHeaders,
  postIngestLine,
  warnInsecureIngest,
} from "../telemetry/ingest.js";
import type { JobRow, JobStore, ReviewerRunRow } from "./store.js";

/**
 * Terminal job summary for external log ingest (issue #139): one structured
 * JSON line on stdout when a job reaches a terminal state, plus an optional
 * HTTP POST to an OpenObserve stream when OPENOBSERVE_LOGS_URL is set.
 * The payload is usage metadata only — never secrets, webhook URLs, diffs,
 * review bodies, or the ingest credentials themselves.
 */

export interface JobSpend {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** null when no stage reported a cost — distinguishes "free" from "unmeasured". */
  costUsd: number | null;
}

/** Recorded model spend of one job: routing, specialists, aggregation, escalations. */
export function jobSpend(job: JobRow | undefined | null, runs: ReviewerRunRow[]): JobSpend {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let costUsd: number | null = null;
  const addCost = (cost: number | null | undefined) => {
    if (cost != null) costUsd = (costUsd ?? 0) + cost;
  };
  if (job) {
    promptTokens +=
      (job.routing_prompt_tokens ?? 0) +
      (job.aggregator_prompt_tokens ?? 0) +
      (job.internal_escalation_prompt_tokens ?? 0);
    completionTokens +=
      (job.routing_completion_tokens ?? 0) +
      (job.aggregator_completion_tokens ?? 0) +
      (job.internal_escalation_completion_tokens ?? 0);
    totalTokens +=
      tokenTotalFromRow({
        total_tokens: job.routing_total_tokens,
        prompt_tokens: job.routing_prompt_tokens,
        completion_tokens: job.routing_completion_tokens,
      }) +
      tokenTotalFromRow({
        total_tokens: job.aggregator_total_tokens,
        prompt_tokens: job.aggregator_prompt_tokens,
        completion_tokens: job.aggregator_completion_tokens,
        reasoning_tokens: job.aggregator_reasoning_tokens,
        cache_read_tokens: job.aggregator_cache_read_tokens,
        cache_write_tokens: job.aggregator_cache_write_tokens,
      }) +
      tokenTotalFromRow({
        total_tokens: job.internal_escalation_total_tokens,
        prompt_tokens: job.internal_escalation_prompt_tokens,
        completion_tokens: job.internal_escalation_completion_tokens,
      });
    addCost(job.routing_cost);
    addCost(job.aggregator_cost);
    addCost(job.internal_escalation_cost);
  }
  for (const run of runs) {
    promptTokens += run.prompt_tokens ?? 0;
    completionTokens += run.completion_tokens ?? 0;
    totalTokens += tokenTotalFromRow(run);
    addCost(run.cost);
  }
  return { promptTokens, completionTokens, totalTokens, costUsd };
}

export interface JobSummaryPayload {
  event: "maomao.job_summary";
  job_id: number;
  job_type: JobRow["job_type"];
  repo: string;
  /** Pull request number; null for jobs without one (health scans, repo briefs). */
  pr: number | null;
  provider: string;
  provider_instance: string;
  state: JobState;
  /**
   * Wall time measured from started_at (creation-to-finish when started_at
   * was never stamped); null when either timestamp is missing. Raw-UPDATE
   * terminal paths — cancels and stale sweeps — leave started_at NULL, so
   * a still-queued job cancelled/swept measures from created_at. The
   * setJobState path instead stamps started_at at the transition itself,
   * so a queued job failed through it reports ~0 — "never claimed" only
   * covers the raw-UPDATE paths. Same for a retried job terminating while
   * still queued: created_at-span on the raw-UPDATE paths (the retry nulled
   * started_at and nothing re-stamps it), ~0 through setJobState — so a
   * whole-lifetime duration is only guaranteed on the cancel/sweep lines.
   */
  duration_ms: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  head_sha: string;
  finished_at: string | null;
  /** Telemetry channels with no resolvable endpoint at emit time, if any. */
  telemetry_unconfigured?: string[];
  /**
   * Same convention as the UI's usage completeness: false when the line is a
   * floor — either a reported stage flagged its usage incomplete, or the job
   * was staled/cancelled while still running and the run may not have unwound
   * its usage yet. Consumers should treat false as "minimum, not total".
   */
  usage_complete: boolean;
  /**
   * 1 for the first run; incremented per retryFailedReviewers. A retried job
   * legitimately emits one line per attempt — dedup on (job_id, attempt), not
   * job_id alone, or retries look like double-counted spend.
   */
  attempt: number;
}

export interface JobSummaryOptions {
  /**
   * Post-write row snapshot captured inside the transition transaction.
   * Skips the post-commit getJob re-read so the emitted line reflects the
   * exact transition that fired it even if the row changes after commit.
   */
  job?: JobRow;
  /**
   * Reviewer-run snapshot captured inside the same transition transaction
   * as `job` — skips the post-commit re-read so a retry landing between
   * commit and emission can't pair the terminal row with already-reset
   * attempt usage.
   */
  runs?: ReviewerRunRow[];
  /** The job was claimed-and-running when it went terminal — usage fields are a snapshot, not a final tally. */
  partialUsage?: boolean;
  /**
   * Telemetry channels whose endpoint resolved to nothing at emit time —
   * their exports silently no-op'd for this job. Present only on partially
   * configured deployments; absent when everything or nothing is wired.
   */
  telemetryUnconfigured?: string[];
}

export function buildJobSummary(job: JobRow, runs: ReviewerRunRow[], opts?: JobSummaryOptions): JobSummaryPayload {
  const spend = jobSpend(job, runs);
  const started = Date.parse(job.started_at ?? job.created_at);
  const finished = Date.parse(job.finished_at ?? "");
  const reported = [
    job.aggregator_usage_complete,
    job.routing_usage_complete,
    job.internal_escalation_usage_complete,
    ...runs.map((run) => run.usage_complete),
  ];
  return {
    event: "maomao.job_summary",
    job_id: job.id,
    job_type: job.job_type,
    repo: job.repo_full_name,
    pr: job.pr_number > 0 ? job.pr_number : null,
    provider: job.provider,
    provider_instance: job.provider_instance,
    state: job.state,
    duration_ms:
      Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : null,
    prompt_tokens: spend.promptTokens,
    completion_tokens: spend.completionTokens,
    total_tokens: spend.totalTokens,
    cost_usd: spend.costUsd,
    head_sha: job.head_sha,
    finished_at: job.finished_at,
    // Optional: only when some (not all) telemetry channels have an endpoint.
    ...(opts?.telemetryUnconfigured?.length
      ? { telemetry_unconfigured: opts.telemetryUnconfigured }
      : {}),
    usage_complete: opts?.partialUsage === true ? false : reported.every((v) => v == null || v === 1),
    attempt: (job.retry_count ?? 0) + 1,
  };
}

let stdoutSink: (line: string) => void = (line) => process.stdout.write(`${line}\n`);

/** Test hook: swap the stdout sink; returns the previous one for restoration. */
export function setJobSummarySink(sink: (line: string) => void): (line: string) => void {
  const previous = stdoutSink;
  stdoutSink = sink;
  return previous;
}

/** Test hook: resolves once every queued ingest POST has settled. */
export function flushJobSummaryPosts(): Promise<void> {
  return flushIngestPosts();
}

/**
 * Emit the terminal summary for one job: the JSON line always, the
 * OpenObserve ingest POST only when OPENOBSERVE_LOGS_URL is configured.
 * Never throws and never logs credentials — a broken ingest endpoint must
 * not break job bookkeeping.
 */
export function emitJobSummary(
  store: Pick<JobStore, "getJob" | "listReviewerRuns">,
  jobId: number,
  env: NodeJS.ProcessEnv = process.env,
  opts?: JobSummaryOptions,
  stored?: TelemetryChannelConfig,
  shared?: TelemetrySharedConfig,
): void {
  try {
    const job = opts?.job ?? store.getJob(jobId);
    if (!job) return;
    const line = JSON.stringify(buildJobSummary(job, opts?.runs ?? store.listReviewerRuns(jobId), opts));
    // The two channels are independent: a broken stdout sink must not
    // suppress a configured ingest POST (and vice versa via the queue).
    try {
      stdoutSink(line);
    } catch (error) {
      console.error(
        `job-summary: stdout write failed for job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const url = resolveChannelUrl("logs", env, stored, shared);
    if (!url) return;
    const headers = ingestHeaders(env, stored, shared);
    warnInsecureIngest(url, headers);
    postIngestLine(url, headers, line, `job ${jobId}`, "job-summary");
  } catch (error) {
    console.error(
      `job-summary: emission failed for job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
