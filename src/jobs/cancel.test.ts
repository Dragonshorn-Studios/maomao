import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { JobStore } from "./store.js";
import { cancelJob, cancelJobsForPull } from "./cancel.js";

function seedStore() {
  const db = openDb(":memory:");
  const store = new JobStore(db);
  const base = {
    repoFullName: "acme/widgets",
    repoOwner: "acme",
    repoName: "widgets",
    installationId: 1,
    prNumber: 7,
    prTitle: "t",
    prBody: "",
    prHtmlUrl: "https://github.com/acme/widgets/pull/7",
    prAuthor: "a",
    baseSha: "b",
    baseRef: "main",
    headRef: "f",
    reviewers: [{ role: "correctness", title: "Correctness" }],
  };
  /** Enqueue's stale-sweep normally guarantees one active job per PR, but the
   * schema permits more (a missed synchronize delivery never sweeps), so tests
   * force the multi-SHA state directly to cover the cancellation SQL. */
  const activate = (jobId: number) =>
    db.prepare(`UPDATE jobs SET state = 'reviewing' WHERE id = ?`).run(jobId);
  return { store, base, activate };
}

describe("cancellation service", () => {
  it("cancels every non-terminal job for a pull across head SHAs in one call", () => {
    const { store, base, activate } = seedStore();
    const older = store.enqueue({ ...base, headSha: "aaa" });
    const newer = store.enqueue({ ...base, headSha: "bbb" });
    activate(older.job.id);
    activate(newer.job.id);
    const otherPull = store.enqueue({ ...base, headSha: "ccc", prNumber: 9 });
    activate(otherPull.job.id);

    const result = cancelJobsForPull(store, {
      repoFullName: base.repoFullName,
      prNumber: base.prNumber,
      reason: "pr_merged",
      note: "webhook delivery d-1",
    });

    expect(result.cancelledJobIds.sort()).toEqual([older.job.id, newer.job.id].sort());
    const cancelledRows = [store.getJob(older.job.id), store.getJob(newer.job.id)];
    for (const job of cancelledRows) {
      expect(job?.state).toBe("cancelled");
      expect(job?.cancelled_reason).toBe("pr_merged");
      expect(job?.cancelled_by).toBeNull();
      expect(job?.finished_at).toBeTruthy();
    }
    // Reviewed SHAs and prior progress are preserved, not wiped.
    expect(cancelledRows.map((job) => job?.head_sha).sort()).toEqual(["aaa", "bbb"]);
    expect(store.getJob(otherPull.job.id)?.state).toBe("reviewing");
    expect(
      store.listLogs(newer.job.id).some((line) => line.message.includes("Cancelled (pr_merged)") && line.message.includes("webhook delivery d-1")),
    ).toBe(true);
  });

  it("is idempotent: terminal and already-cancelled jobs are untouched", () => {
    const { store, base, activate } = seedStore();
    const queued = store.enqueue({ ...base, headSha: "aaa" });
    const running = store.enqueue({ ...base, headSha: "bbb" });
    activate(queued.job.id);
    activate(running.job.id);
    const completed = store.enqueue({ ...base, headSha: "ccc", prNumber: 9 });
    store.setJobState(completed.job.id, "completed");
    const failed = store.enqueue({ ...base, headSha: "ddd", prNumber: 10 });
    store.setJobState(failed.job.id, "failed", { failure_reason: "boom" });

    const first = cancelJobsForPull(store, {
      repoFullName: base.repoFullName,
      prNumber: base.prNumber,
      reason: "pr_merged",
    });
    expect(first.cancelledJobIds.sort()).toEqual([queued.job.id, running.job.id].sort());

    const second = cancelJobsForPull(store, {
      repoFullName: base.repoFullName,
      prNumber: base.prNumber,
      reason: "pr_merged",
    });
    expect(second.cancelledJobIds).toEqual([]);
    expect(store.getJob(completed.job.id)?.state).toBe("completed");
    expect(store.getJob(failed.job.id)?.failure_reason).toBe("boom");
    // No duplicate audit log lines from the second (no-op) delivery.
    expect(store.listLogs(queued.job.id).filter((line) => line.message.includes("Cancelled"))).toHaveLength(1);
  });

  it("cancels a job from every active state, including publishing", () => {
    const { store, base } = seedStore();
    const activeStates = [
      "queued",
      "preparing",
      "reconciling",
      "routing",
      "reviewing",
      "aggregating",
      "sniffing",
      "publishing",
    ] as const;
    for (const [index, state] of activeStates.entries()) {
      const job = store.enqueue({ ...base, headSha: `sha-${state}`, prNumber: 100 + index });
      if (state !== "queued") store.setJobState(job.job.id, state);
      expect(store.cancelJobs({ jobId: job.job.id }, "pr_merged", null)).toEqual([job.job.id]);
      expect(store.getJob(job.job.id)?.state).toBe("cancelled");
    }
  });

  it("records the actor for manual cancellation", () => {
    const { store, base } = seedStore();
    const job = store.enqueue({ ...base, headSha: "aaa" });
    cancelJobsForPull(store, {
      repoFullName: base.repoFullName,
      prNumber: base.prNumber,
      reason: "manual_dequeue",
      actor: "octocat",
    });
    const row = store.getJob(job.job.id);
    expect(row?.state).toBe("cancelled");
    expect(row?.cancelled_by).toBe("octocat");
    expect(store.listLogs(job.job.id).some((line) => line.message.includes("by octocat"))).toBe(true);
  });

  it("setJobState cannot resurrect or relabel a cancelled job", () => {
    const { store, base } = seedStore();
    const job = store.enqueue({ ...base, headSha: "aaa" });
    cancelJob(store, job.job.id, { reason: "manual_dequeue", actor: "octocat" });

    store.setJobState(job.job.id, "failed", { failure_reason: "late failure" });
    store.setJobState(job.job.id, "queued");
    const row = store.getJob(job.job.id);
    expect(row?.state).toBe("cancelled");
    expect(row?.failure_reason).toBeNull();
    expect(row?.cancelled_reason).toBe("manual_dequeue");
  });

  it("cancelJob is idempotent for an already-cancelled job and refuses terminal states", () => {
    const { store, base } = seedStore();
    const queued = store.enqueue({ ...base, headSha: "aaa" });
    const completed = store.enqueue({ ...base, headSha: "bbb", prNumber: 9 });
    store.setJobState(completed.job.id, "completed");

    expect(cancelJob(store, queued.job.id, { reason: "manual_dequeue", actor: "op" })).toEqual({
      ok: true,
      already: false,
    });
    expect(cancelJob(store, queued.job.id, { reason: "manual_dequeue", actor: "op" })).toEqual({
      ok: true,
      already: true,
    });
    expect(cancelJob(store, completed.job.id, { reason: "manual_dequeue", actor: "op" })).toEqual({
      ok: false,
      error: "cannot cancel a completed job",
    });
    expect(cancelJob(store, 4242, { reason: "manual_dequeue" })).toEqual({ ok: false, error: "job not found" });
  });
});
