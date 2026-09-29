import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
import { JobStore } from "./store.js";
import { buildJobSummary, emitJobSummary, jobSpend, setJobSummarySink, type JobSummaryPayload } from "./summary.js";

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
    headSha: "cafebabe",
    baseRef: "main",
    headRef: "feat",
    reviewers: [{ role: "stack_cumulative", title: "Stack cumulative" }],
    jobType: "stack_review",
    dedupKey: `stack:u1@${vector}`,
  }).job.id;
}

const lines: string[] = [];
const capture = (line: string) => {
  lines.push(line);
};

function payloadLines(): JobSummaryPayload[] {
  return lines.map((line) => JSON.parse(line) as JobSummaryPayload);
}

afterEach(() => {
  lines.length = 0;
  setJobSummarySink((line) => process.stdout.write(`${line}\n`));
  vi.unstubAllGlobals();
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
    });
    const run = store.listReviewerRuns(jobId)[0];
    const spend = jobSpend(store.getJob(jobId), [
      { ...run, prompt_tokens: 7, completion_tokens: 3, total_tokens: 11, cost: 0.02 },
    ]);
    expect(spend.promptTokens).toBe(20);
    expect(spend.completionTokens).toBe(9);
    expect(spend.totalTokens).toBe(36);
    expect(spend.costUsd).toBeCloseTo(0.08);
  });

  it("reports null cost when nothing was measured", () => {
    const spend = jobSpend(null, []);
    expect(spend).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: null });
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
      ].sort(),
    );
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
    expect(payloadLines().map((p) => `${p.job_id}:${p.state}`)).toEqual([`${stalePr}:stale`]);

    lines.length = 0;
    const queued = seedStackJob(store, "vec1");
    const staled = store.staleOpenStackJobs("acme/widgets", "u1", "stack:u1@vec2");
    expect(staled).toEqual([queued]);
    expect(payloadLines().map((p) => `${p.job_id}:${p.state}`)).toEqual([`${queued}:stale`]);
  });

  it("POSTs the payload to OPENOBSERVE_LOGS_URL when set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const store = makeStore();
    const jobId = seedJob(store);
    emitJobSummary(store, jobId, {
      OPENOBSERVE_LOGS_URL: "https://oo.example.com/api/default/maomao/_json",
      OPENOBSERVE_LOGS_TOKEN: "secret-token",
    } as NodeJS.ProcessEnv);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oo.example.com/api/default/maomao/_json");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.event).toBe("maomao.job_summary");
    expect(JSON.stringify(body)).not.toContain("secret-token");
  });

  it("uses Basic auth when OPENOBSERVE_LOGS_USER is set", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const store = makeStore();
    const jobId = seedJob(store);
    emitJobSummary(store, jobId, {
      OPENOBSERVE_LOGS_URL: "https://oo.example.com/api/default/maomao/_json",
      OPENOBSERVE_LOGS_USER: "ingest-user",
      OPENOBSERVE_LOGS_PASSWORD: "ingest-pass",
    } as NodeJS.ProcessEnv);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("ingest-user:ingest-pass").toString("base64")}`,
    );
  });

  it("survives a rejected ingest POST without throwing or logging credentials", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchMock);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
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
