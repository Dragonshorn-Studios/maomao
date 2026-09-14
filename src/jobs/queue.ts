import type { JobStore } from "./store.js";
import { abortJob } from "./pipeline.js";

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
    if (this.started) this.pump();
  }

  abort(jobId: number): void {
    const index = this.pending.indexOf(jobId);
    if (index >= 0) this.pending.splice(index, 1);
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
  }
}
