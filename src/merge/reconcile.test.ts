import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { openDb } from "../db.js";
import type { ForgeChange } from "../forge/types.js";
import type { JobQueue } from "../jobs/queue.js";
import { JobStore } from "../jobs/store.js";
import { RepoRateLimiter } from "../github/rate-limit.js";
import { ForgejoMergeReconciler } from "./reconcile.js";

function config() {
  return loadConfig({
    GITHUB_WEBHOOK_SECRET: "secret",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "key",
    REVIEWER_ROLES: "correctness",
  });
}

function seedJob(store: JobStore, headSha = "old-head", prNumber = 7) {
  return store.enqueue({
    repoFullName: "acme/widgets",
    repoOwner: "acme",
    repoName: "widgets",
    installationId: 42,
    provider: "forgejo",
    providerInstance: "forgejo.example",
    forgeConnectionId: "conn-1",
    prNumber,
    prTitle: "old title",
    prBody: "old body",
    prHtmlUrl: "https://forgejo.example/acme/widgets/pulls/7",
    prAuthor: "octocat",
    baseSha: "base-old",
    headSha,
    baseRef: "main",
    headRef: "feature",
    reviewers: [],
  }).job;
}

function harness(change: ForgeChange | Error) {
  const store = new JobStore(openDb(":memory:"));
  const enqueued: number[] = [];
  const aborted: number[][] = [];
  const queue = {
    enqueue(id: number) { enqueued.push(id); },
    abortMany(ids: number[]) { aborted.push(ids); },
  } as unknown as JobQueue;
  const forge = {
    forJob: () => ({
      getChange: async () => {
        if (change instanceof Error) throw change;
        return change;
      },
    }),
  };
  const rateLimiter = new RepoRateLimiter();
  const reconciler = new ForgejoMergeReconciler({ config: config(), store, queue, forge: forge as never, rateLimiter }, { batchSize: 10 });
  return { store, queue, enqueued, aborted, rateLimiter, reconciler };
}

function pull(overrides: Partial<ForgeChange> = {}): ForgeChange {
  return {
    repoOwner: "acme",
    repoName: "widgets",
    repoFullName: "acme/widgets",
    changeNumber: 7,
    title: "new title",
    body: "new body",
    htmlUrl: "https://forgejo.example/acme/widgets/pulls/7",
    author: "octocat",
    baseSha: "base-new",
    headSha: "old-head",
    baseRef: "main",
    headRef: "feature",
    draft: false,
    closed: false,
    ...overrides,
  };
}

describe("ForgejoMergeReconciler", () => {
  it("records an authoritative merged head and cancels active work through the shared path", async () => {
    const { store, aborted, reconciler } = harness(pull({ closed: true, merged: true }));
    const job = seedJob(store);

    const report = await reconciler.reconcileNow();

    expect(report).toMatchObject({ scanned: 1, merged: 1, errors: 0 });
    expect(store.hasMergedPullAtHead("acme/widgets", 7, "old-head", { provider: "forgejo", instance: "forgejo.example" })).toBe(true);
    expect(store.getJob(job.id)).toMatchObject({ state: "cancelled", cancelled_reason: "pr_merged" });
    expect(aborted).toEqual([[job.id]]);
  });

  it("enqueues the normal review path when the pull head moved", async () => {
    const { store, enqueued, aborted, reconciler } = harness(pull({ headSha: "new-head" }));
    const job = seedJob(store);

    const report = await reconciler.reconcileNow();

    expect(report).toMatchObject({ scanned: 1, requeued: 1, errors: 0 });
    const jobs = store.listJobs(10);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ head_sha: "new-head", pr_title: "new title", webhook_event: "forgejo.periodic_reconcile" });
    expect(store.getJob(job.id)?.state).toBe("stale");
    expect(enqueued).toEqual([jobs[0]!.id]);
    expect(aborted).toEqual([[job.id]]);
  });

  it("leaves state untouched when the forge read fails", async () => {
    const { store, enqueued, aborted, reconciler } = harness(new Error("temporary outage"));
    const job = seedJob(store);

    const report = await reconciler.reconcileNow();

    expect(report).toMatchObject({ scanned: 1, errors: 1, merged: 0, requeued: 0 });
    expect(store.getJob(job.id)?.state).toBe("queued");
    expect(store.listJobs(10)).toHaveLength(1);
    expect(enqueued).toEqual([]);
    expect(aborted).toEqual([]);
  });

  it("shares the Forgejo repository rate-limit budget with webhook ingestion", async () => {
    const { store, enqueued, rateLimiter, reconciler } = harness(pull({ headSha: "new-head" }));
    seedJob(store);
    const key = "forgejo:forgejo.example:42";
    for (let index = 0; index < 6; index += 1) rateLimiter.recordKey(key, 6, 60_000);

    const report = await reconciler.reconcileNow();

    expect(report.requeued).toBe(0);
    expect(enqueued).toEqual([]);
    expect(store.listJobs(10)).toHaveLength(1);
  });

  it("does not resurrect pulls while their repository review pause is active", async () => {
    const { store, enqueued, reconciler } = harness(pull({ headSha: "new-head" }));
    seedJob(store);
    store.createPause({ repoFullName: "acme/widgets", actor: "operator", durationMs: 60_000, provider: "forgejo", providerInstance: "forgejo.example" });

    const report = await reconciler.reconcileNow();

    expect(report.requeued).toBe(0);
    expect(enqueued).toEqual([]);
    expect(store.listJobs(10)).toHaveLength(1);
  });

  it("does not resurrect draft pulls when draft reviews are disabled", async () => {
    const { store, enqueued, reconciler } = harness(pull({ headSha: "new-head", draft: true }));
    seedJob(store);

    const report = await reconciler.reconcileNow();

    expect(report.requeued).toBe(0);
    expect(enqueued).toEqual([]);
    expect(store.listJobs(10)).toHaveLength(1);
  });
});

describe("latest pull-review reconciliation pages", () => {
  it("walks latest jobs per pull in bounded batches without duplicate older heads", () => {
    const store = new JobStore(openDb(":memory:"));
    const oldSeven = seedJob(store, "seven-old", 7);
    const newSeven = seedJob(store, "seven-new", 7);
    const eight = seedJob(store, "eight-head", 8);
    const nine = seedJob(store, "nine-head", 9);

    const first = store.listLatestPullReviewJobsPage({ limit: 2, provider: "forgejo" });
    expect(first.jobs.map((job) => job.id)).toEqual([nine.id, eight.id]);
    expect(first.hasMore).toBe(true);
    const second = store.listLatestPullReviewJobsPage({ limit: 2, beforeId: first.jobs.at(-1)!.id, provider: "forgejo" });
    expect(second.jobs.map((job) => job.id)).toEqual([newSeven.id]);
    expect(second.hasMore).toBe(false);
    expect([...first.jobs, ...second.jobs]).not.toContainEqual(expect.objectContaining({ id: oldSeven.id }));
  });
});
