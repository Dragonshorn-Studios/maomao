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

function seedStackJob(store: JobStore, stackId: string, vector = "deadbeef0001", headSha = "cafebabe") {
  return store.enqueue({
    repoFullName: "acme/widgets",
    repoOwner: "acme",
    repoName: "widgets",
    installationId: 9,
    prNumber: 43,
    prTitle: "t",
    prBody: "",
    prHtmlUrl: "",
    prAuthor: "dev",
    baseSha: "base",
    headSha,
    baseRef: "main",
    headRef: "feat",
    reviewers: [{ role: "stack_cumulative", title: "Stack cumulative" }],
    jobType: "stack_review",
    dedupKey: `stack:${stackId}@${vector}`,
  }).job.id;
}

describe("stack job helpers", () => {
  it("staleOpenStackJobs stales open same-stack rows only, and hasStackReview tracks resolution", () => {
    const store = makeStore();
    const queued = seedStackJob(store, "u1", "aaa111bbb222");
    const rerun = seedStackJob(store, "u1", "ccc333ddd444", "other1");
    const otherStack = seedStackJob(store, "u2", "aaa111bbb222", "other2");
    const lookalike = seedStackJob(store, "aXb", "aaa111bbb222", "other3");
    // A same-stack run already in flight is superseded too — the caller
    // aborts the returned ids so it stops publishing pre-push reviews.
    store.setJobState(rerun, "reviewing");

    expect(store.hasStackReview("acme/widgets", "u1")).toBe(true);
    expect(store.hasStackReview("acme/widgets", "never-ran")).toBe(false);

    const staled = store.staleOpenStackJobs("acme/widgets", "u1", "stack:u1@newvector99");
    expect(staled.sort((a, b) => a - b)).toEqual([queued, rerun].sort((a, b) => a - b));
    expect(store.getJob(queued)?.state).toBe("stale");
    expect(store.getJob(queued)?.finished_at).toBeTruthy();
    expect(store.getJob(rerun)?.state).toBe("stale");
    expect(store.getJob(otherStack)?.state).toBe("queued");
    // Their specialist runs retired with them — nothing stays queued.
    expect(store.listReviewerRuns(queued).map((run) => run.state)).toEqual(["stale"]);
    expect(store.listReviewerRuns(rerun).map((run) => run.state)).toEqual(["stale"]);

    // LIKE metacharacters in the id must not over-match: 'a_b' != 'aXb'.
    expect(store.staleOpenStackJobs("acme/widgets", "a_b", "stack:a_b@zzz")).toEqual([]);
    expect(store.getJob(lookalike)?.state).toBe("queued");
  });

  it("staleOpenStackJobs also stales legacy 'stack:<id>' keys across the deploy boundary", () => {
    const store = makeStore();
    const legacy = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 1,
      prNumber: 9,
      prTitle: "t",
      prBody: "",
      prHtmlUrl: "u",
      prAuthor: "dev",
      baseSha: "base",
      headSha: "old",
      baseRef: "main",
      headRef: "feat",
      reviewers: [{ role: "stack_cumulative", title: "Stack cumulative" }],
      jobType: "stack_review",
      dedupKey: "stack:u1",
    }).job.id;

    expect(store.hasStackReview("acme/widgets", "u1")).toBe(true);
    const staled = store.staleOpenStackJobs("acme/widgets", "u1", "stack:u1@newvector1");
    expect(staled).toEqual([legacy]);
    expect(store.getJob(legacy)?.state).toBe("stale");
  });
});

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
