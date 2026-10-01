import type { JobStore } from "./store.js";
import { abortJob } from "./pipeline.js";
import { exportQueueMetrics } from "../telemetry/metrics.js";

export class JobQueue {
  private readonly pending: number[] = [];
  private readonly active = new Set<number>();
  private started = false;

  constructor(
    private readonly store: JobStore,
    private readonly concurrency: number,
    private readonly run: (jobId: number) => Promise<void>,
  ) {}

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
    exportQueueMetrics(this.pending.length, this.active.size, this.concurrency);
    if (this.started) this.pump();
  }

  abort(jobId: number): void {
    const index = this.pending.indexOf(jobId);
    if (index >= 0) {
      this.pending.splice(index, 1);
      exportQueueMetrics(this.pending.length, this.active.size, this.concurrency);
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
    // no-op unless OPENOBSERVE_METRICS_URL is set.
    exportQueueMetrics(this.pending.length, this.active.size, this.concurrency);
  }
}
