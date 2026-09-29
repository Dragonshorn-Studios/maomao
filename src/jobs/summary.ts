import type { JobState } from "../config.js";
import { tokenTotalFromRow } from "../opencode/parse.js";
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
  duration_ms: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  head_sha: string;
  finished_at: string | null;
  /**
   * Same convention as the UI's usage completeness: false when the line is a
   * floor — either a reported stage flagged its usage incomplete, or the job
   * was staled/cancelled while still running and the run may not have unwound
   * its usage yet. Consumers should treat false as "minimum, not total".
   */
  usage_complete: boolean;
}

export interface JobSummaryOptions {
  /** The job was claimed-and-running when it went terminal — usage fields are a snapshot, not a final tally. */
  partialUsage?: boolean;
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
    usage_complete: opts?.partialUsage === true ? false : reported.every((v) => v == null || v === 1),
  };
}

let stdoutSink: (line: string) => void = (line) => process.stdout.write(`${line}\n`);

/** Test hook: swap the stdout sink; returns the previous one for restoration. */
export function setJobSummarySink(sink: (line: string) => void): (line: string) => void {
  const previous = stdoutSink;
  stdoutSink = sink;
  return previous;
}

// Ingest POSTs are serialized so a bulk terminal sweep (e.g. the global-pause
// cancel flipping hundreds of jobs at once) cannot fan out one unbounded
// socket per job — at most one request is in flight at a time.
let postChain: Promise<void> = Promise.resolve();

function queueIngestPost(url: string, headers: Record<string, string>, line: string, jobId: number): void {
  postChain = postChain.then(async () => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: line,
        // Bounded so a hung ingest endpoint cannot linger forever; there is no
        // retry — the stdout line above remains the durable copy.
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        console.error(`job-summary: OpenObserve POST for job ${jobId} returned ${response.status}`);
      }
    } catch (error) {
      // URL parse/construction errors echo the request URL verbatim — strip it
      // so credentials embedded in OPENOBSERVE_LOGS_URL never reach stderr.
      const raw = error instanceof Error ? error.message : String(error);
      const safe = raw.split(url).join("<openobserve-url>");
      console.error(`job-summary: OpenObserve POST failed for job ${jobId}: ${safe}`);
    }
  });
}

function ingestHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = env.OPENOBSERVE_LOGS_TOKEN?.trim();
  const user = env.OPENOBSERVE_LOGS_USER?.trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  } else if (user) {
    headers.authorization = `Basic ${Buffer.from(`${user}:${env.OPENOBSERVE_LOGS_PASSWORD ?? ""}`).toString("base64")}`;
  }
  return headers;
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
): void {
  try {
    const job = store.getJob(jobId);
    if (!job) return;
    const line = JSON.stringify(buildJobSummary(job, store.listReviewerRuns(jobId), opts));
    stdoutSink(line);
    const url = env.OPENOBSERVE_LOGS_URL?.trim();
    if (!url) return;
    queueIngestPost(url, ingestHeaders(env), line, jobId);
  } catch (error) {
    console.error(
      `job-summary: emission failed for job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
