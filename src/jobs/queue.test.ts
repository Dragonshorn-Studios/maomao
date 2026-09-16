import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
import { JobStore } from "./store.js";
import { JobQueue } from "./queue.js";

function makeStore() {
  return new JobStore(openDb(":memory:"));
}

function seedJob(store: JobStore, prNumber = 4, headSha = "cafebabe") {
  return store.enqueue({
    repoFullName: "acme/widgets",
    repoOwner: "acme",
    repoName: "widgets",
    installationId: 9,
    prNumber,
    prTitle: "t",
    prBody: "",
    prHtmlUrl: "",
    prAuthor: "dev",
    baseSha: "base",
    headSha,
    baseRef: "main",
    headRef: "feat",
    reviewers: [{ role: "correctness", title: "Correctness" }],
  }).job.id;
}

describe("JobQueue cancellation", () => {
  it("never runs a cancelled job that was still pending", async () => {
    const store = makeStore();
    const first = seedJob(store, 4, "aaa");
    const second = seedJob(store, 5, "bbb");
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const ran: number[] = [];
    const queue = new JobQueue(store, 1, async (jobId) => {
      ran.push(jobId);
      if (jobId === first) await firstGate;
    });
    queue.start();
    await vi.waitFor(() => {
      expect(ran).toEqual([first]);
    });
    // The second job is pending; mirroring the server wiring, cancellation
    // persists first, then abortMany drops it from the queue before a worker
    // can claim it.
    expect(store.cancelJobs({ jobId: second }, "pr_merged", null)).toEqual([second]);
    queue.abortMany([second]);
    releaseFirst?.();
    // The first job's slot frees; the queue must have nothing left to run.
    await vi.waitFor(() => {
      expect(store.getJob(second)?.state).toBe("cancelled");
    });
    expect(ran).toEqual([first]);
  });

  it("restart recovery re-queues interrupted jobs but never a cancelled one", async () => {
    const store = makeStore();
    const cancelledJob = seedJob(store, 4, "aaa");
    store.setJobState(cancelledJob, "reviewing");
    store.cancelJobs({ jobId: cancelledJob }, "pr_merged", null);
    const interruptedJob = seedJob(store, 5, "bbb");
    store.setJobState(interruptedJob, "reviewing");

    const ran: number[] = [];
    const queue = new JobQueue(store, 1, async (jobId) => {
      ran.push(jobId);
    });
    queue.start();
    await vi.waitFor(() => {
      expect(ran).toEqual([interruptedJob]);
    });

    const cancelled = store.getJob(cancelledJob);
    expect(cancelled?.state).toBe("cancelled");
    expect(cancelled?.cancelled_reason).toBe("pr_merged");
    expect(store.listLogs(cancelledJob).some((line) => line.message.includes("Re-queued"))).toBe(false);
    // The interrupted control job was reset, re-enqueued, and ran.
    expect(store.getJob(interruptedJob)?.state).toBe("queued");
  });
});
