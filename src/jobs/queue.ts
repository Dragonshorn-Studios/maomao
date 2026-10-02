import type { JobStore } from "./store.js";
import { abortJob } from "./pipeline.js";
import { exportQueueMetrics } from "../telemetry/metrics.js";
import { emitAppLog } from "../telemetry/app-log.js";
import type { TelemetrySettingsStore } from "../telemetry/settings.js";

export class JobQueue {
  private readonly pending: number[] = [];
  private readonly active = new Set<number>();
  private started = false;

  constructor(
    private readonly store: JobStore,
    private readonly concurrency: number,
    private readonly run: (jobId: number) => Promise<void>,
    private readonly telemetry?: TelemetrySettingsStore,
    /** Same gate as job summaries — JOB_SUMMARIES=false silences app logs too. */
    private readonly emitAppLogs = true,
  ) {}

  private metricsConfig() {
    return this.telemetry?.get("metrics");
  }

  private metricsShared() {
    return this.telemetry?.shared();
  }

  private logsConfig() {
    return this.telemetry?.get("logs");
  }

  private exportMetrics() {
    exportQueueMetrics(
      this.pending.length,
      this.active.size,
      this.concurrency,
      process.env,
      this.metricsConfig(),
      this.metricsShared(),
      this.logsConfig(),
    );
  }

  private logJobStarted(jobId: number): void {
    if (!this.emitAppLogs) return;
    const job = this.store.getJob(jobId);
    if (!job) return;
    emitAppLog(
      "job_started",
      {
        job_id: job.id,
        job_type: job.job_type,
        repo: job.repo_full_name,
        pr: job.pr_number > 0 ? job.pr_number : null,
        provider: job.provider,
        provider_instance: job.provider_instance,
        head_sha: job.head_sha,
        attempt: (job.retry_count ?? 0) + 1,
        queue_depth: this.pending.length,
        slots_in_use: this.active.size,
      },
      process.env,
      this.logsConfig(),
      this.metricsShared(),
    );
  }

  start(): void {
    this.started = true;
    for (const job of this.store.listInterruptedJobs()) {
      this.store.resetInterrupted(job.id);
      this.store.log(job.id, "Re-queued after process start");
      this.enqueue(job.id);
    }
    this.pump();
  }

  enqueue(jobId: number): void {
    if (this.pending.includes(jobId) || this.active.has(jobId)) return;
    this.pending.push(jobId);
    // Gauge on change: depth grows even when no slot is free for pump to act.
    this.exportMetrics();
    if (this.started) this.pump();
  }

  abort(jobId: number): void {
    const index = this.pending.indexOf(jobId);
    if (index >= 0) {
      this.pending.splice(index, 1);
      this.exportMetrics();
    }
    abortJob(jobId);
  }

  abortMany(jobIds: number[]): void {
    for (const id of jobIds) this.abort(id);
  }

  private pump(): void {
    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const jobId = this.pending.shift();
      if (jobId == null) return;
      this.active.add(jobId);
      this.logJobStarted(jobId);
      void this.run(jobId)
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.store.log(jobId, `Queue runner error: ${message}`, "error");
        })
        .finally(() => {
          this.active.delete(jobId);
          this.pump();
        });
    }
    // Gauge on change: claims, releases (via the finally's re-pump), and the
    // startup drain all settle depth/slot numbers here. Best-effort OTLP —
    // no-op unless a metrics URL is configured (env or stored).
    this.exportMetrics();
  }
}
