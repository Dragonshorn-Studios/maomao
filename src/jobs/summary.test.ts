import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
import { JobStore, type JobRow } from "./store.js";
import {
  buildJobSummary,
  emitJobSummary,
  flushJobSummaryPosts,
  jobSpend,
  setJobSummarySink,
  type JobSummaryPayload,
} from "./summary.js";

function makeStore() {
  // Emission is opt-in in production (src/index.ts); these tests exercise it.
  return new JobStore(openDb(":memory:"), [], { emitJobSummaries: true });
}

function seedJob(
  store: JobStore,
  prNumber = 4,
  headSha = "cafebabe",
  repoFullName = "acme/widgets",
  forge?: { provider: string; instance: string },
) {
  const [repoOwner, repoName] = repoFullName.split("/") as [string, string];
  return store.enqueue({
    repoFullName,
    repoOwner,
    repoName,
    provider: forge?.provider,
    providerInstance: forge?.instance,
    installationId: 9,
    prNumber,
    prTitle: "t",
    prBody: "body",
    prHtmlUrl: "https://github.com/acme/widgets/pull/4",
    prAuthor: "dev",
    baseSha: "base",
    headSha,
    baseRef: "main",
    headRef: "feat",
    reviewers: [{ role: "correctness", title: "Correctness" }],
  }).job.id;
}

function seedStackJob(store: JobStore, vector: string) {
  return store
    .enqueue({
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
    headSha: "cafebabe",
    baseRef: "main",
    headRef: "feat",
      reviewers: [{ role: "stack_cumulative", title: "Stack cumulative" }],
      jobType: "stack_review",
      dedupKey: `stack:u1@${vector}`,
    })
    .job.id;
}

const lines: string[] = [];
const capture = (line: string) => {
  lines.push(line);
};

function payloadLines(): JobSummaryPayload[] {
  return lines.map((line) => JSON.parse(line) as JobSummaryPayload);
}

beforeEach(() => {
  // Keep the ambient environment out of store-driven emits: a developer or
  // CI box with OPENOBSERVE_LOGS_URL exported must not produce real POSTs.
  vi.stubEnv("OPENOBSERVE_LOGS_URL", "");
});

afterEach(async () => {
  lines.length = 0;
  setJobSummarySink((line) => process.stdout.write(`${line}\n`));
  // Drain the serialized ingest queue so a test's queued POST can't bleed
  // fetch calls into the next test's stubs.
  await flushJobSummaryPosts();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("jobSpend", () => {
  it("rolls up routing, aggregation, escalation, and specialist usage", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    store.patchJob(jobId, {
      routing_prompt_tokens: 3,
      routing_completion_tokens: 2,
      routing_total_tokens: 5,
      routing_cost: 0.01,
      aggregator_prompt_tokens: 10,
      aggregator_completion_tokens: 4,
      aggregator_total_tokens: 20,
      aggregator_cost: 0.05,
      internal_escalation_prompt_tokens: 2,
      internal_escalation_completion_tokens: 1,
      internal_escalation_total_tokens: 3,
      internal_escalation_cost: 0.005,
    });
    const run = store.listReviewerRuns(jobId)[0];
    const spend = jobSpend(store.getJob(jobId), [
      { ...run, prompt_tokens: 7, completion_tokens: 3, total_tokens: 11, cost: 0.02 },
    ]);
    expect(spend.promptTokens).toBe(22);
    expect(spend.completionTokens).toBe(10);
    expect(spend.totalTokens).toBe(39);
    expect(spend.costUsd).toBeCloseTo(0.085);
  });

  it("maps exact numeric spend values into the payload", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    store.patchJob(jobId, {
      routing_prompt_tokens: 3,
      routing_completion_tokens: 2,
      routing_total_tokens: 5,
      routing_cost: 0.01,
      aggregator_prompt_tokens: 7,
      aggregator_completion_tokens: 5,
      aggregator_total_tokens: 12,
      aggregator_cost: 0.02,
    });
    const run = store.listReviewerRuns(jobId)[0];
    store.patchReviewer(run.id, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost: 0.03 });
    const payload = buildJobSummary(store.getJob(jobId)!, store.listReviewerRuns(jobId));
    expect(payload.prompt_tokens).toBe(20);
    expect(payload.completion_tokens).toBe(11);
    expect(payload.total_tokens).toBe(31);
    expect(payload.cost_usd).toBeCloseTo(0.06);
  });

  it("reports null cost when nothing was measured", () => {
    const spend = jobSpend(null, []);
    expect(spend).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: null });
  });

  it("reports a measured zero cost as 0, not null", () => {
    const spend = jobSpend({ routing_cost: 0 } as JobRow, []);
    expect(spend.costUsd).toBe(0);
  });

  it("sums component tokens when a stage's total is unset", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    store.patchJob(jobId, {
      routing_prompt_tokens: 4,
      routing_completion_tokens: 6,
      routing_total_tokens: null,
    });
    const spend = jobSpend(store.getJob(jobId), []);
    expect(spend.totalTokens).toBe(10);
  });

  it("sums escalation stage and reviewer-run components when totals are unset", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    store.patchJob(jobId, {
      internal_escalation_prompt_tokens: 3,
      internal_escalation_completion_tokens: 4,
      internal_escalation_total_tokens: null,
    });
    const run = store.listReviewerRuns(jobId)[0];
    const spend = jobSpend(store.getJob(jobId), [
      {
        ...run,
        prompt_tokens: 5,
        completion_tokens: 6,
        reasoning_tokens: 2,
        cache_read_tokens: 1,
        cache_write_tokens: 1,
        total_tokens: null,
      },
    ]);
    expect(spend.totalTokens).toBe(22);
  });

  it("sums aggregator components including reasoning and cache tokens", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    store.patchJob(jobId, {
      aggregator_prompt_tokens: 10,
      aggregator_completion_tokens: 4,
      aggregator_reasoning_tokens: 3,
      aggregator_cache_read_tokens: 2,
      aggregator_cache_write_tokens: 1,
      aggregator_total_tokens: null,
    });
    expect(jobSpend(store.getJob(jobId), []).totalTokens).toBe(20);
  });
});

describe("buildJobSummary", () => {
  it("emits usage metadata only — no bodies, urls, or secrets", () => {
    const store = makeStore();
    const jobId = seedJob(store, 4, "deadbeef01");
    store.setJobState(jobId, "completed");
    const payload = buildJobSummary(store.getJob(jobId)!, store.listReviewerRuns(jobId));
    expect(payload).toMatchObject({
      event: "maomao.job_summary",
      job_id: jobId,
      job_type: "pr_review",
      repo: "acme/widgets",
      pr: 4,
      provider: "github",
      state: "completed",
      head_sha: "deadbeef01",
    });
    expect(typeof payload.duration_ms).toBe("number");
    expect(payload.duration_ms).toBeGreaterThanOrEqual(0);
    expect(Object.keys(payload).sort()).toEqual(
      [
        "event",
        "job_id",
        "job_type",
        "repo",
        "pr",
        "provider",
        "provider_instance",
        "state",
        "duration_ms",
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "cost_usd",
        "head_sha",
        "finished_at",
        "usage_complete",
        "attempt",
      ].sort(),
    );
    expect(payload.usage_complete).toBe(true);
    expect(payload.attempt).toBe(1);
  });

  it("reports null duration_ms for a job with no finished_at", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    const payload = buildJobSummary(store.getJob(jobId)!, []);
    expect(payload.finished_at).toBeNull();
    expect(payload.duration_ms).toBeNull();
  });

  it("marks usage_complete false when a reviewer run reports incomplete usage", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    const run = store.listReviewerRuns(jobId)[0];
    store.patchReviewer(run.id, { usage_complete: 0 });
    const payload = buildJobSummary(store.getJob(jobId)!, store.listReviewerRuns(jobId));
    expect(payload.usage_complete).toBe(false);
  });

  it.each([
    "aggregator_usage_complete",
    "routing_usage_complete",
    "internal_escalation_usage_complete",
  ] as const)("marks usage_complete false when %s is 0", (column) => {
    const store = makeStore();
    const jobId = seedJob(store);
    store.patchJob(jobId, { [column]: 0 });
    const payload = buildJobSummary(store.getJob(jobId)!, []);
    expect(payload.usage_complete).toBe(false);
  });

  it("emits pr null for negative and zero pull request numbers", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    const job = store.getJob(jobId)!;
    expect(buildJobSummary({ ...job, pr_number: -1 }, []).pr).toBeNull();
    expect(buildJobSummary({ ...job, pr_number: 0 }, []).pr).toBeNull();
  });

  it("clamps duration_ms to 0 when finished_at precedes started_at", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    const job = {
      ...store.getJob(jobId)!,
      started_at: "2026-01-02T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:00.000Z",
    };
    expect(buildJobSummary(job, []).duration_ms).toBe(0);
  });

  it("reports attempt 3 for a twice-retried job", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    const job = { ...store.getJob(jobId)!, retry_count: 2 };
    expect(buildJobSummary(job, []).attempt).toBe(3);
  });

  it("emits pr null for jobs without a pull request", () => {
    const store = makeStore();
    const jobId = seedJob(store, 0, "deadbeef02");
    const payload = buildJobSummary(store.getJob(jobId)!, []);
    expect(payload.pr).toBeNull();
  });
});

describe("emitJobSummary", () => {
  it("writes one JSON line on stdout for each terminal transition", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store);
    store.setJobState(jobId, "completed");
    expect(lines).toHaveLength(1);
    expect(payloadLines()[0]).toMatchObject({ job_id: jobId, state: "completed" });
  });

  it("does not re-emit on same-state patches of a terminal job", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store);
    store.setJobState(jobId, "completed");
    store.patchJob(jobId, { risk_profile: "observation" });
    expect(lines).toHaveLength(1);
  });

  it("emits for bulk-cancelled jobs", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const first = seedJob(store, 4, "sha1");
    const second = seedJob(store, 5, "sha2");
    store.cancelJobs({ repoFullName: "acme/widgets", prNumber: 4 }, "manual_cancel", null);
    store.cancelJobs({ repoFullName: "acme/widgets", prNumber: 5 }, "manual_cancel", null);
    const states = payloadLines().map((p) => `${p.job_id}:${p.state}`);
    expect(states).toEqual([`${first}:cancelled`, `${second}:cancelled`]);
  });

  it("emits for jobs staled by enqueue and staleOpenStackJobs", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const stalePr = seedJob(store, 4, "oldsha");
    seedJob(store, 4, "newsha"); // head-move sweep stales the older job
    expect(payloadLines()).toEqual([
      expect.objectContaining({ job_id: stalePr, state: "stale", usage_complete: true }),
    ]);

    lines.length = 0;
    const queued = seedStackJob(store, "vec1");
    const staled = store.staleOpenStackJobs("acme/widgets", "u1", "stack:u1@vec2");
    expect(staled).toEqual([queued]);
    expect(payloadLines()).toEqual([
      expect.objectContaining({ job_id: queued, state: "stale", usage_complete: true }),
    ]);
  });

  it("emits once for a failed job relabeled stale by a later push", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const failed = seedJob(store, 4, "oldsha");
    store.setJobState(failed, "failed");
    seedJob(store, 4, "newsha"); // head-move sweep relabels failed -> stale
    expect(store.getJob(failed)!.state).toBe("stale");
    expect(payloadLines().map((p) => `${p.job_id}:${p.state}`)).toEqual([`${failed}:failed`]);
  });

  it("emits once for a completed job relabeled stale by a later push", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const done = seedJob(store, 4, "oldsha");
    store.setJobState(done, "completed");
    seedJob(store, 4, "newsha"); // head-move sweep relabels completed -> stale
    expect(store.getJob(done)!.state).toBe("stale");
    expect(payloadLines().map((p) => `${p.job_id}:${p.state}`)).toEqual([`${done}:completed`]);
  });

  it("does not re-emit for already-terminal jobs relabeled by staleOpenStackJobs", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const done = seedStackJob(store, "vec1");
    store.setJobState(done, "completed");
    const staled = store.staleOpenStackJobs("acme/widgets", "u1", "stack:u1@vec2");
    expect(staled).toEqual([done]);
    expect(payloadLines().map((p) => `${p.job_id}:${p.state}`)).toEqual([`${done}:completed`]);
  });

  it("marks usage incomplete when a live job is cancelled, complete for a queued one", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const live = seedJob(store, 4, "sha1");
    store.setJobState(live, "routing");
    const queued = seedJob(store, 5, "sha2");
    store.cancelJobs({ repoFullName: "acme/widgets", prNumber: 4 }, "manual_cancel", null);
    store.cancelJobs({ repoFullName: "acme/widgets", prNumber: 5 }, "manual_cancel", null);
    expect(payloadLines()).toEqual([
      expect.objectContaining({ job_id: live, state: "cancelled", usage_complete: false }),
      expect.objectContaining({ job_id: queued, state: "cancelled", usage_complete: true }),
    ]);
  });

  it("does not re-emit when the same job is cancelled twice", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store);
    expect(store.cancelJobs({ jobId }, "manual_cancel", null)).toEqual([jobId]);
    expect(store.cancelJobs({ jobId }, "manual_cancel", null)).toEqual([]);
    expect(payloadLines()).toHaveLength(1);
  });

  it("reports null duration_ms when the start timestamp is unparseable", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    const job = {
      ...store.getJob(jobId)!,
      started_at: "not-a-date",
      created_at: "also-not-a-date",
      finished_at: "2026-01-01T00:00:00.000Z",
    };
    expect(buildJobSummary(job, []).duration_ms).toBeNull();
  });

  it("reports ~0 duration for a queued job failed via setJobState (started_at stamped at the transition)", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store);
    // setJobState stamps started_at = updated_at on any queued->non-queued
    // move, so this path measures claim-to-finish, not creation-to-finish —
    // the created_at fallback only applies to the raw-UPDATE cancel paths.
    store.setJobState(jobId, "failed");
    expect(payloadLines().map((p) => [p.state, p.duration_ms])).toEqual([["failed", 0]]);
  });

  it("measures duration_ms from created_at for jobs that never started", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store);
    store.cancelJobs({ jobId }, "manual_cancel", null);
    const job = store.getJob(jobId)!;
    expect(job.started_at).toBeNull();
    expect(payloadLines()[0].duration_ms).toBe(
      Date.parse(job.finished_at!) - Date.parse(job.created_at),
    );
  });

  it("emits attempt 2 when a retried job is staled by a later push", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store, 4, "oldsha");
    const run = store.listReviewerRuns(jobId)[0];
    store.patchReviewer(run.id, { state: "failed" });
    store.setJobState(jobId, "failed");
    expect(store.retryFailedReviewers(jobId).ok).toBe(true);
    seedJob(store, 4, "newsha"); // head-move sweep stales the re-queued job
    expect(payloadLines().map((p) => [p.state, p.attempt, p.usage_complete])).toEqual([
      ["failed", 1, true],
      ["stale", 2, true],
    ]);
  });

  it("emits attempt 3 after two store-level retries", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store);
    for (let i = 0; i < 2; i++) {
      const run = store.listReviewerRuns(jobId)[0];
      store.patchReviewer(run.id, { state: "failed" });
      store.setJobState(jobId, "failed");
      expect(store.retryFailedReviewers(jobId).ok).toBe(true);
    }
    store.setJobState(jobId, "completed");
    expect(payloadLines().map((p) => [p.state, p.attempt])).toEqual([
      ["failed", 1],
      ["failed", 2],
      ["completed", 3],
    ]);
  });

  it("emits one line per attempt with an incrementing discriminator on retry", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store);
    const run = store.listReviewerRuns(jobId)[0];
    store.patchReviewer(run.id, { state: "failed" });
    store.setJobState(jobId, "failed");
    expect(store.retryFailedReviewers(jobId).ok).toBe(true);
    store.setJobState(jobId, "completed");
    expect(payloadLines().map((p) => [p.job_id, p.state, p.attempt])).toEqual([
      [jobId, "failed", 1],
      [jobId, "completed", 2],
    ]);
  });

  it("emits partialUsage when a live stack job is superseded by a new push", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const first = seedStackJob(store, "vec1");
    store.setJobState(first, "reviewing");
    seedStackJob(store, "vec1"); // same dedup key — supersedes the live run
    expect(store.getJob(first)!.state).toBe("stale");
    expect(payloadLines()).toEqual([
      expect.objectContaining({ job_id: first, state: "stale", usage_complete: false }),
    ]);
  });

  it("emits partialUsage when the head-move sweep stales a live job", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const live = seedJob(store, 4, "oldsha");
    store.setJobState(live, "reviewing");
    seedJob(store, 4, "newsha");
    expect(store.getJob(live)!.state).toBe("stale");
    expect(payloadLines()).toEqual([
      expect.objectContaining({ job_id: live, state: "stale", usage_complete: false }),
    ]);
  });

  it("emits partialUsage when staleOpenStackJobs sweeps a live job", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const live = seedStackJob(store, "vec1");
    store.setJobState(live, "reviewing");
    const staled = store.staleOpenStackJobs("acme/widgets", "u1", "stack:u1@vec2");
    expect(staled).toEqual([live]);
    expect(payloadLines()).toEqual([
      expect.objectContaining({ job_id: live, state: "stale", usage_complete: false }),
    ]);
  });

  it("emits only for the cancelled repo's jobs on a repo-scoped type cancel", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const mine = seedJob(store, 4, "sha1");
    const other = seedJob(store, 4, "sha2", "acme/other");
    const cancelled = store.cancelJobs(
      { repoFullName: "acme/widgets", jobType: "pr_review" },
      "repo_paused",
      null,
    );
    expect(cancelled).toEqual([mine]);
    expect(payloadLines()).toEqual([
      expect.objectContaining({ job_id: mine, state: "cancelled", usage_complete: true }),
    ]);
    expect(store.getJob(other)!.state).toBe("queued");
  });

  it("emits one line for a cancel inside a non-default forge scope", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store, 4, "sha1", "acme/widgets", {
      provider: "gitlab",
      instance: "gitlab.example.com",
    });
    const cancelled = store.cancelJobs(
      {
        repoFullName: "acme/widgets",
        jobType: "pr_review",
        scope: { provider: "gitlab", instance: "gitlab.example.com" },
      },
      "manual_cancel",
      null,
    );
    expect(cancelled).toEqual([jobId]);
    expect(payloadLines()).toEqual([
      expect.objectContaining({ job_id: jobId, state: "cancelled", provider: "gitlab" }),
    ]);
  });

  it("emits for a type-wide (global pause) cancel across repos", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const first = seedJob(store, 4, "sha1");
    const second = seedJob(store, 5, "sha2");
    const cancelled = store.cancelJobs({ jobType: "pr_review" }, "reviews_paused", null);
    expect(cancelled).toEqual([first, second]);
    expect(payloadLines()).toEqual([
      expect.objectContaining({ job_id: first, state: "cancelled", usage_complete: true }),
      expect.objectContaining({ job_id: second, state: "cancelled", usage_complete: true }),
    ]);
  });

  it("marks usage incomplete on a direct live->cancelled transition", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store);
    store.setJobState(jobId, "reviewing");
    store.setJobState(jobId, "cancelled");
    expect(payloadLines()).toEqual([
      expect.objectContaining({ job_id: jobId, state: "cancelled", usage_complete: false }),
    ]);
  });

  it("defaults attempt to 1 for a job row with no retry_count", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    const legacy = { ...store.getJob(jobId)!, retry_count: null as unknown as number };
    expect(buildJobSummary(legacy, []).attempt).toBe(1);
  });

  it("marks usage incomplete on a direct live->stale transition", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store);
    store.setJobState(jobId, "reviewing");
    store.setJobState(jobId, "stale");
    expect(payloadLines()).toEqual([
      expect.objectContaining({ job_id: jobId, state: "stale", usage_complete: false }),
    ]);
  });

  it("emits nothing when the store is constructed with no opts (emission defaults off)", () => {
    setJobSummarySink(capture);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    // The gate is opt-in: a bare JobStore (what tests/demo/harnesses build)
    // must stay silent even with an ingest URL exported in the environment.
    const store = new JobStore(openDb(":memory:"));
    const jobId = seedJob(store);
    vi.stubEnv("OPENOBSERVE_LOGS_URL", "https://oo.example.com/api/default/maomao/_json");
    store.setJobState(jobId, "completed");
    expect(lines).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("emits nothing on any terminal path when emitJobSummaries is off", () => {
    setJobSummarySink(capture);
    // emitJobSummaries defaults off; the explicit false pins the flag itself.
    const store = new JobStore(openDb(":memory:"), [], { emitJobSummaries: false });
    const jobId = seedJob(store, 4, "sha-a");
    store.setJobState(jobId, "failed"); // setJobState path
    const queued = seedJob(store, 8, "sha-1");
    seedJob(store, 8, "sha-2"); // enqueue head-move sweep
    expect(store.getJob(queued)!.state).toBe("stale");
    const stackId = seedStackJob(store, "vec1");
    expect(store.staleOpenStackJobs("acme/widgets", "u1", "stack:u1@vec2")).toEqual([stackId]); // stack sweep
    const cancellable = seedJob(store, 9, "s9"); // cancelJobs path on a live-cancellable row
    expect(store.cancelJobs({ jobId: cancellable }, "manual_cancel", null)).toEqual([cancellable]);
    expect(lines).toHaveLength(0);
  });

  it("emits a complete-usage line when a queued job goes straight to stale via setJobState", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store);
    store.setJobState(jobId, "stale");
    // queued is not a live state: nothing was mid-flight, so the line is a
    // final tally (usage_complete), not a floor.
    expect(payloadLines()).toEqual([
      expect.objectContaining({ job_id: jobId, state: "stale", usage_complete: true }),
    ]);
  });

  it("skips a sweep-selected job a concurrent writer cancelled before the guarded UPDATE", () => {
    setJobSummarySink(capture);
    const db = openDb(":memory:");
    const store = new JobStore(db, [], { emitJobSummaries: true });
    const victim = seedJob(store, 4, "oldsha");
    const origPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("SET state = 'stale'") && sql.includes("RETURNING id")) {
        origPrepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(victim);
      }
      return origPrepare(sql);
    }) as typeof db.prepare);
    seedJob(store, 4, "newsha"); // head-move sweep selects victim, UPDATE must skip it
    expect(store.getJob(victim)!.state).toBe("cancelled");
    expect(lines).toHaveLength(0);
  });

  it("staleOpenStackJobs skips a row a concurrent writer cancelled before the guarded UPDATE", () => {
    setJobSummarySink(capture);
    const db = openDb(":memory:");
    const store = new JobStore(db, [], { emitJobSummaries: true });
    const victim = seedStackJob(store, "vec1");
    const origPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("SET state = 'stale'") && sql.includes("RETURNING id")) {
        origPrepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(victim);
      }
      return origPrepare(sql);
    }) as typeof db.prepare);
    expect(store.staleOpenStackJobs("acme/widgets", "u1", "stack:u1@vec2")).toEqual([]);
    expect(store.getJob(victim)!.state).toBe("cancelled");
    expect(lines).toHaveLength(0);
  });

  it("skips a stack-sweep-selected job a concurrent writer cancelled before the guarded UPDATE", () => {
    setJobSummarySink(capture);
    const db = openDb(":memory:");
    const store = new JobStore(db, [], { emitJobSummaries: true });
    const victim = seedStackJob(store, "vec1");
    store.setJobState(victim, "reviewing"); // live state so the stack sweep selects it
    lines.length = 0;
    const origPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("SET state = 'stale'") && sql.includes("state IN (")) {
        origPrepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(victim);
      }
      return origPrepare(sql);
    }) as typeof db.prepare);
    const result = store.enqueue({
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
      headSha: "cafebabe",
      baseRef: "main",
      headRef: "feat",
      reviewers: [{ role: "stack_cumulative", title: "Stack cumulative" }],
      jobType: "stack_review",
      dedupKey: "stack:u1@vec1",
    });
    expect(result.staleJobIds).toEqual([]);
    expect(store.getJob(victim)!.state).toBe("cancelled");
    expect(lines).toHaveLength(0);
  });

  it("skips a cancelJobs-selected job a concurrent writer finished before the guarded UPDATE", () => {
    setJobSummarySink(capture);
    const db = openDb(":memory:");
    const store = new JobStore(db, [], { emitJobSummaries: true });
    const victim = seedJob(store, 4, "sha1");
    const origPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("SET state = 'cancelled'") && sql.includes("RETURNING id")) {
        origPrepare("UPDATE jobs SET state = 'completed' WHERE id = ?").run(victim);
      }
      return origPrepare(sql);
    }) as typeof db.prepare);
    expect(store.cancelJobs({ jobId: victim }, "manual_cancel", null)).toEqual([]);
    expect(store.getJob(victim)!.state).toBe("completed");
    expect(lines).toHaveLength(0);
  });

  it("emits usage_complete:true for a live job completing normally", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store);
    store.setJobState(jobId, "reviewing");
    store.setJobState(jobId, "completed");
    expect(payloadLines()).toEqual([
      expect.objectContaining({ job_id: jobId, state: "completed", usage_complete: true }),
    ]);
  });

  it("does not emit a second line when a terminal job is relabelled via setJobState", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store);
    store.setJobState(jobId, "completed");
    store.setJobState(jobId, "failed"); // terminal -> terminal: no second line
    expect(payloadLines().map((p) => p.state)).toEqual(["completed"]);
    expect(store.getJob(jobId)!.state).toBe("failed");
  });

  it("skips emission when setJobState's guarded update loses a concurrent state change", () => {
    setJobSummarySink(capture);
    const db = openDb(":memory:");
    const store = new JobStore(db, [], { emitJobSummaries: true });
    const jobId = seedJob(store);
    store.setJobState(jobId, "failed");
    lines.length = 0;
    // A second writer cancelling between the pre-state read and the guarded
    // UPDATE: the UPDATE lands 0 rows, so no emit/publish/coverage follow-up.
    const origPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("UPDATE jobs SET") && sql.includes("WHERE id = ? AND state = ?")) {
        origPrepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(jobId);
      }
      return origPrepare(sql);
    }) as typeof db.prepare);
    store.setJobState(jobId, "completed");
    expect(store.getJob(jobId)!.state).toBe("cancelled");
    expect(lines).toHaveLength(0);
  });

  it("does not revert a concurrent transition when patchJob's pre-read state is stale", () => {
    const db = openDb(":memory:");
    const store = new JobStore(db, [], { emitJobSummaries: true });
    const jobId = seedJob(store);
    // A second writer cancels between patchJob's getJob and the transaction's
    // own read: keepCurrentState must re-write 'cancelled', not the stale
    // 'queued' the caller saw.
    const origTx = db.transaction.bind(db);
    const origPrepare = db.prepare.bind(db);
    vi.spyOn(db, "transaction").mockImplementation(((fn: () => unknown) =>
      origTx(() => {
        origPrepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(jobId);
        return fn();
      })) as typeof db.transaction);
    store.patchJob(jobId, { failure_reason: "race-probe" });
    expect(store.getJob(jobId)!.state).toBe("cancelled");
    expect(store.getJob(jobId)!.failure_reason).toBe("race-probe");
  });

  it("aborts the retry with no run resets when the job state changed mid-transaction", () => {
    const db = openDb(":memory:");
    const store = new JobStore(db, [], { emitJobSummaries: true });
    const jobId = seedJob(store);
    const run = store.listReviewerRuns(jobId)[0];
    store.patchReviewer(run.id, { state: "failed" });
    store.setJobState(jobId, "failed");
    const origPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("retry_count = retry_count + 1")) {
        origPrepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(jobId);
      }
      return origPrepare(sql);
    }) as typeof db.prepare);
    expect(store.retryFailedReviewers(jobId)).toEqual({ ok: false, error: "job state changed — retry aborted" });
    expect(store.getJob(jobId)!.state).toBe("cancelled");
    expect(store.listReviewerRuns(jobId)[0].state).toBe("failed");
  });

  it("skips run resets whose 'failed' state was lost mid-transaction and reports the real count", () => {
    const db = openDb(":memory:");
    const store = new JobStore(db, [], { emitJobSummaries: true });
    const jobId = seedJob(store);
    const run = store.listReviewerRuns(jobId)[0];
    store.patchReviewer(run.id, { state: "failed" });
    store.setJobState(jobId, "failed");
    const origPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("UPDATE reviewer_runs SET") && sql.includes("state = 'failed'")) {
        origPrepare("UPDATE reviewer_runs SET state = 'done' WHERE id = ?").run(run.id);
      }
      return origPrepare(sql);
    }) as typeof db.prepare);
    expect(store.retryFailedReviewers(jobId)).toEqual({ ok: true, reset: 0 });
    expect(store.getJob(jobId)!.state).toBe("queued");
    expect(store.getJob(jobId)!.retry_count).toBe(1);
    expect(store.listReviewerRuns(jobId)[0].state).toBe("done");
  });

  it("logs and returns when the store read throws", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      getJob: () => {
        throw new Error("db dead");
      },
      listReviewerRuns: () => [],
    };
    expect(() => emitJobSummary(broken as never, 1, {} as NodeJS.ProcessEnv)).not.toThrow();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("emission failed"));
    err.mockClear();
    const halfBroken = {
      getJob: () => ({ id: 1 }),
      listReviewerRuns: () => {
        throw new Error("runs query dead");
      },
    };
    expect(() => emitJobSummary(halfBroken as never, 1, {} as NodeJS.ProcessEnv)).not.toThrow();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("emission failed"));
  });

  it("no-ops for a missing job id", () => {
    setJobSummarySink(capture);
    const store = makeStore();
    expect(() => emitJobSummary(store, 999999, {} as NodeJS.ProcessEnv)).not.toThrow();
    expect(lines).toHaveLength(0);
  });

  it("setJobSummarySink returns the previous sink for restoration", () => {
    const first = (line: string) => void line;
    const previous = setJobSummarySink(first);
    expect(setJobSummarySink(capture)).toBe(first);
    expect(previous).toBeTypeOf("function");
  });

  it("a throwing sink does not break the job transition or the ingest POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENOBSERVE_LOGS_URL", "https://oo.example.com/api/x/_json");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    setJobSummarySink(() => {
      throw new Error("stdout exploded");
    });
    const store = makeStore();
    const jobId = seedJob(store);
    expect(() => store.setJobState(jobId, "completed")).not.toThrow();
    expect(store.getJob(jobId)!.state).toBe("completed");
    expect(err).toHaveBeenCalled();
    // A dead stdout channel must not suppress the configured ingest POST.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("POSTs the payload to OPENOBSERVE_LOGS_URL when set", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store);
    emitJobSummary(store, jobId, {
      OPENOBSERVE_LOGS_URL: "https://oo.example.com/api/default/maomao/_json",
      OPENOBSERVE_LOGS_TOKEN: "secret-token",
    } as NodeJS.ProcessEnv);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oo.example.com/api/default/maomao/_json");
    expect(init.method).toBe("POST");
    // Bounded delivery — a hung endpoint can't linger past the timeout.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    // _json's documented contract is a JSON array with exactly the one record.
    const body = JSON.parse(init.body as string) as Record<string, unknown>[];
    expect(body).toHaveLength(1);
    expect(body[0].event).toBe("maomao.job_summary");
    expect(JSON.stringify(body)).not.toContain("secret-token");
  });

  it("warns once when ingest credentials would travel over plain http", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    setJobSummarySink(capture);
    const store = makeStore();
    const env = {
      OPENOBSERVE_LOGS_URL: "http://oo-warn-check.internal/api/default/maomao/_json",
      OPENOBSERVE_LOGS_TOKEN: "secret-token",
    } as NodeJS.ProcessEnv;
    emitJobSummary(store, seedJob(store, 4, "s1"), env);
    emitJobSummary(store, seedJob(store, 5, "s2"), env);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const warnings = err.mock.calls.filter((call) => String(call[0]).includes("cleartext"));
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(err.mock.calls)).not.toContain("secret-token");
  });

  it("does not warn for an http ingest URL without credentials", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    setJobSummarySink(capture);
    const store = makeStore();
    emitJobSummary(store, seedJob(store), {
      OPENOBSERVE_LOGS_URL: "http://oo-no-creds.internal/api/default/maomao/_json",
    } as NodeJS.ProcessEnv);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(err.mock.calls.filter((call) => String(call[0]).includes("cleartext"))).toHaveLength(0);
  });

  it("redacts the configured URL from error logs even when it is unparseable", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new Error("could not reach not-a-valid-url%%% endpoint"));
    vi.stubGlobal("fetch", fetchMock);
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store);
    emitJobSummary(store, jobId, { OPENOBSERVE_LOGS_URL: "not-a-valid-url%%%" } as NodeJS.ProcessEnv);
    await flushJobSummaryPosts();
    const logged = err.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).not.toContain("not-a-valid-url%%%");
    expect(logged).toContain("<openobserve-url>");
  });

  it("redacts normalized URL forms and embedded userinfo from ingest error logs", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error("fetch failed: https://User:Pass@OO.example.com/x/_json"));
    vi.stubGlobal("fetch", fetchMock);
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store);
    // The thrown error echoes a differently-cased (normalized-looking) URL —
    // verbatim string redaction alone would leak the userinfo.
    emitJobSummary(store, jobId, {
      OPENOBSERVE_LOGS_URL: "https://User:Pass@OO.Example.com/x/_json",
    } as NodeJS.ProcessEnv);
    await flushJobSummaryPosts();
    const logged = err.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).not.toContain("User");
    expect(logged).not.toContain("Pass");
    expect(logged).toContain("<credentials>@");
  });

  it("prefers TOKEN over user/password and sends no auth header when neither is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    setJobSummarySink(capture);
    const store = makeStore();
    const url = "https://oo.example.com/api/default/maomao/_json";
    emitJobSummary(store, seedJob(store, 4), {
      OPENOBSERVE_LOGS_URL: url,
      OPENOBSERVE_LOGS_TOKEN: "tok",
      OPENOBSERVE_LOGS_USER: "u",
      OPENOBSERVE_LOGS_PASSWORD: "p",
    } as NodeJS.ProcessEnv);
    emitJobSummary(store, seedJob(store, 5), { OPENOBSERVE_LOGS_URL: url } as NodeJS.ProcessEnv);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const headers = (call: number) =>
      (fetchMock.mock.calls[call][1] as RequestInit).headers as Record<string, string>;
    expect(headers(0).authorization).toBe("Bearer tok");
    expect(headers(1).authorization).toBeUndefined();
  });

  it("reads ingest config from process.env when driven through the store", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENOBSERVE_LOGS_URL", "https://oo.example.com/api/default/maomao/_json");
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store);
    store.setJobState(jobId, "completed");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("https://oo.example.com/api/default/maomao/_json");
  });

  it("serializes ingest POSTs to one in-flight request", async () => {
    let resolveFirst!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => gate)
      .mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    setJobSummarySink(capture);
    const store = makeStore();
    const env = { OPENOBSERVE_LOGS_URL: "https://oo.example.com/api/x/_json" } as NodeJS.ProcessEnv;
    emitJobSummary(store, seedJob(store, 4), env);
    emitJobSummary(store, seedJob(store, 5), env);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveFirst({ ok: true, status: 200 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("still delivers subsequent ingest POSTs after one rejection", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = makeStore();
    const env = { OPENOBSERVE_LOGS_URL: "https://oo.example.com/api/x/_json" } as NodeJS.ProcessEnv;
    emitJobSummary(store, seedJob(store, 4), env);
    emitJobSummary(store, seedJob(store, 5), env);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("drops and logs past the ingest queue depth cap, then resumes once drained", async () => {
    let resolveFirst!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => gate)
      .mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = makeStore();
    const env = { OPENOBSERVE_LOGS_URL: "https://oo.example.com/api/x/_json" } as NodeJS.ProcessEnv;
    for (let i = 0; i < 300; i++) emitJobSummary(store, seedJob(store, i + 1), env);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("ingest queue full"));
    resolveFirst({ ok: true, status: 200 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(256));
    // Once the backlog drains, delivery resumes — the cap didn't wedge the chain.
    emitJobSummary(store, seedJob(store, 999), env);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(257));
  });

  it("logs the status of a rejected-status ingest POST without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetchMock);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = makeStore();
    const jobId = seedJob(store);
    emitJobSummary(store, jobId, {
      OPENOBSERVE_LOGS_URL: "https://oo.example.com/api/x/_json",
    } as NodeJS.ProcessEnv);
    await vi.waitFor(() => expect(err).toHaveBeenCalledWith(expect.stringContaining("returned 401")));
  });

  it("redacts the ingest URL from logged fetch errors", async () => {
    const badUrl = "https://user:pass@oo.example.com/api/x/_json";
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error(`Failed to parse URL from ${badUrl}`));
    vi.stubGlobal("fetch", fetchMock);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = makeStore();
    const jobId = seedJob(store);
    emitJobSummary(store, jobId, { OPENOBSERVE_LOGS_URL: badUrl } as NodeJS.ProcessEnv);
    await vi.waitFor(() => expect(err).toHaveBeenCalled());
    const logged = err.mock.calls.flat().join(" ");
    expect(logged).toContain("<openobserve-url>");
    expect(logged).not.toContain("user:pass");
  });

  it("treats a whitespace-only OPENOBSERVE_LOGS_URL as unset", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setJobSummarySink(capture);
    const store = makeStore();
    emitJobSummary(store, seedJob(store), { OPENOBSERVE_LOGS_URL: "   " } as NodeJS.ProcessEnv);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
  });

  it("sends no auth header for whitespace-only TOKEN and USER", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    setJobSummarySink(capture);
    const store = makeStore();
    emitJobSummary(store, seedJob(store), {
      OPENOBSERVE_LOGS_URL: "https://oo.example.com/api/x/_json",
      OPENOBSERVE_LOGS_TOKEN: "   ",
      OPENOBSERVE_LOGS_USER: " \t ",
    } as NodeJS.ProcessEnv);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("uses Basic auth when OPENOBSERVE_LOGS_USER is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store);
    emitJobSummary(store, jobId, {
      OPENOBSERVE_LOGS_URL: "https://oo.example.com/api/default/maomao/_json",
      OPENOBSERVE_LOGS_USER: "ingest-user",
      OPENOBSERVE_LOGS_PASSWORD: "ingest-pass",
    } as NodeJS.ProcessEnv);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("ingest-user:ingest-pass").toString("base64")}`,
    );
  });

  it("sends no auth header when only OPENOBSERVE_LOGS_PASSWORD is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    setJobSummarySink(capture);
    const store = makeStore();
    emitJobSummary(store, seedJob(store), {
      OPENOBSERVE_LOGS_URL: "https://oo.example.com/api/x/_json",
      OPENOBSERVE_LOGS_PASSWORD: "ingest-pass",
    } as NodeJS.ProcessEnv);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("sends Basic auth with an empty password when only USER is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    setJobSummarySink(capture);
    const store = makeStore();
    emitJobSummary(store, seedJob(store), {
      OPENOBSERVE_LOGS_URL: "https://oo.example.com/api/default/maomao/_json",
      OPENOBSERVE_LOGS_USER: "ingest-user",
    } as NodeJS.ProcessEnv);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("ingest-user:").toString("base64")}`,
    );
  });

  it("survives a rejected ingest POST without throwing or logging credentials", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchMock);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store);
    expect(() =>
      emitJobSummary(store, jobId, {
        OPENOBSERVE_LOGS_URL: "https://oo.example.com/api/default/maomao/_json",
        OPENOBSERVE_LOGS_TOKEN: "secret-token",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
    await vi.waitFor(() => expect(err).toHaveBeenCalled());
    expect(err.mock.calls.flat().join(" ")).not.toContain("secret-token");
    // The stdout line is the durable copy — it exists even when ingest fails.
    expect(lines).toHaveLength(1);
  });

  it("is stdout-only and never throws when OPENOBSERVE_LOGS_URL is unset", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setJobSummarySink(capture);
    const store = makeStore();
    const jobId = seedJob(store);
    emitJobSummary(store, jobId, {} as NodeJS.ProcessEnv);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
  });
});
