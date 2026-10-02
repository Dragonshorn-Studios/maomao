import type { JobRow, JobStore, ReviewerRunRow } from "../jobs/store.js";
import { buildJobSummary, type JobSummaryOptions } from "../jobs/summary.js";
import { attr, exportMetrics, nanoTime, type OtlpAttribute, type OtlpMetric } from "./otlp.js";
import type { TelemetryChannelConfig, TelemetrySharedConfig } from "./settings.js";

/**
 * OpenObserve metrics slice (issue #141, meta #138): a small OTLP/HTTP metric
 * set on the #143 exporter. Usage metadata only — same hard rule as the
 * job-summary stream: ids, states, durations, token counts, never secrets,
 * diffs, webhook URLs, or review bodies.
 *
 * Two emission seams:
 * - `exportQueueMetrics` — gauges for the in-memory JobQueue: pending depth,
 *   concurrency slots in use, and configured slots. Emitted by queue.ts on
 *   every depth/slot mutation; gauges report on change, not on a timer.
 * - `exportTerminalJobMetrics` — per terminal job transition, built from the
 *   same `buildJobSummary` snapshot the stdout line uses so the two channels
 *   always agree: a `maomao.jobs` +1 counter, a `maomao.job.duration_ms`
 *   histogram observation, and delta token/cost counters.
 *
 * Counter points use DELTA aggregation temporality (each export carries the
 * terminal event's contribution). A retried job emits again with a higher
 * `attempt` attribute — same caveat as the summary stream: routing and
 * internal-escalation spend carries across attempts, so summing every point
 * re-counts those stages. `usage_complete=false` marks snapshots taken
 * mid-flight (stale/cancel of a running job) — treat as a floor.
 */

function jobAttrs(job: JobRow, usageComplete: boolean, attempt: number): OtlpAttribute[] {
  return [
    attr("job_type", job.job_type),
    attr("repo", job.repo_full_name),
    attr("provider_instance", job.provider_instance),
    attr("attempt", attempt),
    attr("usage_complete", usageComplete),
  ];
}

/** The three queue gauges for one mutation point, sharing one timestamp. */
export function queueMetrics(pending: number, active: number, slots: number, now: string = nanoTime()): OtlpMetric[] {
  const point = (value: number) => ({ timeUnixNano: now, asInt: String(value) });
  return [
    {
      name: "maomao.queue.depth",
      unit: "{jobs}",
      description: "Jobs waiting in the in-memory queue for a free runner slot",
      gauge: { dataPoints: [point(pending)] },
    },
    {
      name: "maomao.queue.slots_in_use",
      unit: "{slots}",
      description: "Runner concurrency slots currently occupied",
      gauge: { dataPoints: [point(active)] },
    },
    {
      name: "maomao.queue.slots",
      unit: "{slots}",
      description: "Configured JOB_CONCURRENCY runner slots",
      gauge: { dataPoints: [point(slots)] },
    },
  ];
}

/** Fire-and-forget the queue gauges; no-op unless a metrics URL is configured (env or stored). */
export function exportQueueMetrics(
  pending: number,
  active: number,
  slots: number,
  env: NodeJS.ProcessEnv = process.env,
  stored?: TelemetryChannelConfig,
  shared?: TelemetrySharedConfig,
  logsStored?: TelemetryChannelConfig,
  appLogs = true,
): void {
  exportMetrics(queueMetrics(pending, active, slots), env, stored, shared, logsStored, appLogs);
}

/** Metrics for one terminal job transition, from the same snapshot the summary line uses. */
export function terminalJobMetrics(
  job: JobRow,
  runs: ReviewerRunRow[],
  opts?: JobSummaryOptions,
  now: string = nanoTime(),
): OtlpMetric[] {
  const summary = buildJobSummary(job, runs, opts);
  const base = jobAttrs(job, summary.usage_complete, summary.attempt);
  const metrics: OtlpMetric[] = [
    {
      name: "maomao.jobs",
      unit: "{jobs}",
      description: "Jobs reaching a terminal state",
      sum: {
        aggregationTemporality: 1,
        isMonotonic: true,
        dataPoints: [
          {
            timeUnixNano: now,
            asInt: "1",
            attributes: [...base, attr("state", summary.state)],
          },
        ],
      },
    },
    {
      name: "maomao.job.tokens",
      unit: "{tokens}",
      description: "Model tokens spent by terminal jobs (delta; re-counts carried stages across retry attempts)",
      sum: {
        aggregationTemporality: 1,
        isMonotonic: true,
        dataPoints: [
          { timeUnixNano: now, asInt: String(summary.prompt_tokens), attributes: [...base, attr("kind", "prompt")] },
          { timeUnixNano: now, asInt: String(summary.completion_tokens), attributes: [...base, attr("kind", "completion")] },
          { timeUnixNano: now, asInt: String(summary.total_tokens), attributes: [...base, attr("kind", "total")] },
        ],
      },
    },
  ];
  if (summary.duration_ms != null) {
    metrics.push({
      name: "maomao.job.duration_ms",
      unit: "ms",
      description: "Terminal job wall time",
      histogram: {
        aggregationTemporality: 1,
        dataPoints: [
          {
            timeUnixNano: now,
            attributes: [...base, attr("state", summary.state)],
            count: "1",
            sum: summary.duration_ms,
            bucketCounts: ["1"],
            explicitBounds: [],
          },
        ],
      },
    });
  }
  if (summary.cost_usd != null) {
    metrics.push({
      name: "maomao.job.cost_usd",
      unit: "USD",
      description: "Reported model cost of terminal jobs (delta; see attempt caveat on maomao.job.tokens)",
      sum: {
        aggregationTemporality: 1,
        isMonotonic: true,
        dataPoints: [{ timeUnixNano: now, asDouble: summary.cost_usd, attributes: base }],
      },
    });
  }
  return metrics;
}

/**
 * Emit terminal-transition metrics for one job. Same call site and snapshot
 * options as `emitJobSummary`; never throws and no-ops unless
 * OPENOBSERVE_METRICS_URL is configured.
 */
export function exportTerminalJobMetrics(
  store: Pick<JobStore, "getJob" | "listReviewerRuns">,
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
    exportMetrics(terminalJobMetrics(job, opts?.runs ?? store.listReviewerRuns(jobId), opts), env, stored, shared, logsStored, appLogs);
  } catch (error) {
    console.error(
      `otlp: terminal metrics failed for job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
