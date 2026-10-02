import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
import { JobStore } from "../jobs/store.js";
import { exportTerminalJobTraces, jobTrace, traceIdForJob } from "./traces.js";
import { flushOtlpExports, nanoTime, type OtlpSpan } from "./otlp.js";

const TRACES_URL = "https://oo.example.com/api/default/v1/traces";

function makeStore() {
  // Same opt-in the production store gets in src/index.ts.
  return new JobStore(openDb(":memory:"), [], { emitJobSummaries: true });
}

function seedJob(store: JobStore, jobType: "pr_review" | "stack_review" = "pr_review") {
  return store.enqueue({
    repoFullName: "acme/widgets",
    repoOwner: "acme",
    repoName: "widgets",
    installationId: 9,
    prNumber: 4,
    prTitle: "t",
    prBody: "body",
    prHtmlUrl: "https://github.com/acme/widgets/pull/4",
    prAuthor: "dev",
    baseSha: "base",
    headSha: "cafebabe",
    baseRef: "main",
    headRef: "feat",
    jobType,
    reviewers: [{ role: "correctness", title: "Correctness" }],
  }).job.id;
}

function attrValue(span: OtlpSpan, key: string) {
  return span.attributes?.find((a) => a.key === key)?.value;
}

beforeEach(() => {
  vi.stubEnv("OPENOBSERVE_TRACES_URL", "");
  vi.stubEnv("OPENOBSERVE_TOKEN", "");
  vi.stubEnv("OTEL_SERVICE_NAME", "");
  vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "");
});

afterEach(async () => {
  await flushOtlpExports();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("jobTrace", () => {
  it("emits a root span named for the job type with usage-metadata attrs", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    store.setJobState(jobId, "completed");
    const spans = jobTrace(store.getJob(jobId)!, store.listReviewerRuns(jobId));
    expect(spans).toHaveLength(1);
    const root = spans[0];
    expect(root.name).toBe("maomao.job.pr_review");
    expect(root.traceId).toBe(traceIdForJob(jobId));
    expect(root.parentSpanId).toBeUndefined();
    expect(root.status).toEqual({ code: 1 });
    expect(attrValue(root, "job_type")).toEqual({ stringValue: "pr_review" });
    expect(attrValue(root, "repo")).toEqual({ stringValue: "acme/widgets" });
    expect(attrValue(root, "state")).toEqual({ stringValue: "completed" });
    expect(attrValue(root, "attempt")).toEqual({ intValue: "1" });
    expect(Number(attrValue(root, "queued_ms")?.intValue)).toBeGreaterThanOrEqual(0);
    expect(BigInt(root.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(root.startTimeUnixNano));
  });

  it("marks a failed root span with status error and the state as message", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    store.setJobState(jobId, "failed", { failure_reason: "boom" });
    const root = jobTrace(store.getJob(jobId)!, store.listReviewerRuns(jobId))[0];
    expect(root.status).toEqual({ code: 2, message: "failed" });
  });

  it("hangs the routing span off the job start via routing_duration_ms", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    const start = "2026-10-01T08:00:00.000Z";
    store.patchJob(jobId, {
      started_at: start,
      routing_state: "done",
      routing_duration_ms: 120,
      routing_model: "m7",
      routing_profile: "medium",
      routing_total_tokens: 42,
    });
    store.setJobState(jobId, "completed");
    const spans = jobTrace(store.getJob(jobId)!, store.listReviewerRuns(jobId));
    const routing = spans.find((s) => s.name === "maomao.stage.routing")!;
    expect(routing.parentSpanId).toBe(spans[0].spanId);
    expect(routing.startTimeUnixNano).toBe(nanoTime(Date.parse(start)));
    expect(routing.endTimeUnixNano).toBe(nanoTime(Date.parse(start) + 120));
    expect(attrValue(routing, "model")).toEqual({ stringValue: "m7" });
    expect(attrValue(routing, "profile")).toEqual({ stringValue: "medium" });
    expect(attrValue(routing, "total_tokens")).toEqual({ intValue: "42" });
  });

  it("emits one reviewer span per run with role, model, and attempt attrs", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    const run = store.listReviewerRuns(jobId)[0];
    store["db"]
      .prepare(`UPDATE reviewer_runs SET state = 'done', model = 'gpt-5', started_at = ?, finished_at = ?, duration_ms = ?, total_tokens = 100, cost = 0.01 WHERE id = ?`)
      .run("2026-10-01T08:00:01.000Z", "2026-10-01T08:00:02.000Z", 1000, run.id);
    store.setJobState(jobId, "completed");
    const spans = jobTrace(store.getJob(jobId)!, store.listReviewerRuns(jobId));
    const reviewer = spans.find((s) => s.name === "maomao.stage.reviewer")!;
    expect(reviewer.parentSpanId).toBe(spans[0].spanId);
    expect(attrValue(reviewer, "reviewer_role")).toEqual({ stringValue: "correctness" });
    expect(attrValue(reviewer, "model")).toEqual({ stringValue: "gpt-5" });
    expect(attrValue(reviewer, "total_tokens")).toEqual({ intValue: "100" });
    expect(reviewer.startTimeUnixNano).toBe(nanoTime(Date.parse("2026-10-01T08:00:01.000Z")));
    expect(reviewer.status).toEqual({ code: 1 });
  });

  it("marks LLM-call spans with gen_ai attributes for OpenObserve AI observability", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    const run = store.listReviewerRuns(jobId)[0];
    store["db"]
      .prepare(
        `UPDATE reviewer_runs SET state = 'done', model = 'gpt-5', provider = 'openai', started_at = ?, finished_at = ?, prompt_tokens = 70, completion_tokens = 30, total_tokens = 100, cost = 0.01, cache_read_tokens = 5 WHERE id = ?`,
      )
      .run("2026-10-01T08:00:01.000Z", "2026-10-01T08:00:02.000Z", run.id);
    store.setJobState(jobId, "completed");
    const reviewer = jobTrace(store.getJob(jobId)!, store.listReviewerRuns(jobId)).find(
      (s) => s.name === "maomao.stage.reviewer",
    )!;
    expect(reviewer.kind).toBe(3);
    expect(attrValue(reviewer, "gen_ai.operation.name")).toEqual({ stringValue: "chat" });
    expect(attrValue(reviewer, "gen_ai.provider.name")).toEqual({ stringValue: "openai" });
    expect(attrValue(reviewer, "gen_ai.request.model")).toEqual({ stringValue: "gpt-5" });
    expect(attrValue(reviewer, "gen_ai.usage.prompt_tokens")).toEqual({ intValue: "70" });
    expect(attrValue(reviewer, "gen_ai.usage.completion_tokens")).toEqual({ intValue: "30" });
    expect(attrValue(reviewer, "gen_ai.usage.input_tokens")).toEqual({ intValue: "70" });
    expect(attrValue(reviewer, "gen_ai.usage.output_tokens")).toEqual({ intValue: "30" });
    expect(attrValue(reviewer, "gen_ai.usage.total_tokens")).toEqual({ intValue: "100" });
    expect(attrValue(reviewer, "gen_ai.usage.cache_read_tokens")).toEqual({ intValue: "5" });
    // Fractional doubles go out as strings — OO's strict decoder 400s the
    // whole envelope on {"doubleValue":0.01}; cost_usd_micros keeps it numeric.
    expect(attrValue(reviewer, "gen_ai.usage.cost")).toEqual({ stringValue: "0.01" });
    expect(attrValue(reviewer, "cost_usd")).toEqual({ stringValue: "0.01" });
    expect(attrValue(reviewer, "cost_usd_micros")).toEqual({ intValue: "10000" });
    expect(attrValue(reviewer, "gen_ai.prompt.name")).toEqual({ stringValue: "correctness" });
    expect(attrValue(reviewer, "error.type")).toBeUndefined();
  });

  it("emits aggregation and internal-escalation spans in stage order", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    store.patchJob(jobId, {
      started_at: "2026-10-01T08:00:00.000Z",
      aggregator_state: "done",
      aggregator_started_at: "2026-10-01T08:00:10.000Z",
      aggregator_finished_at: "2026-10-01T08:00:12.000Z",
      aggregator_model: "m-agg",
      internal_escalation_state: "done",
      internal_escalation_duration_ms: 500,
      internal_escalation_alert_cleared: 1,
    });
    store.setJobState(jobId, "completed");
    const spans = jobTrace(store.getJob(jobId)!, store.listReviewerRuns(jobId));
    const agg = spans.find((s) => s.name === "maomao.stage.aggregation")!;
    const esc = spans.find((s) => s.name === "maomao.stage.internal_escalation")!;
    expect(agg.endTimeUnixNano).toBe(nanoTime(Date.parse("2026-10-01T08:00:12.000Z")));
    // Internal escalation records duration only — it follows aggregation.
    expect(esc.startTimeUnixNano).toBe(agg.endTimeUnixNano);
    expect(BigInt(esc.endTimeUnixNano) - BigInt(esc.startTimeUnixNano)).toBe(500n * 1_000_000n);
    expect(attrValue(esc, "alert_cleared")).toEqual({ boolValue: true });
  });

  it("parents a member pr_review's whole trace under the stack job root", () => {
    const store = makeStore();
    const stackId = seedJob(store, "stack_review");
    const memberId = seedJob(store);
    store.insertStackMembers(stackId, [
      { position: 0, prNumber: 4, baseRef: "main", headRef: "a", baseSha: "b0", headSha: "h0" },
    ]);
    const memberRow = store.listStackMembers(stackId)[0];
    store.patchStackMember(memberRow.id, { memberJobId: memberId });
    store.setJobState(memberId, "completed");

    const membership = store.stackMembershipForJobs([memberId]).get(memberId)!;
    expect(membership.stackJobId).toBe(stackId);
    const spans = jobTrace(store.getJob(memberId)!, store.listReviewerRuns(memberId), undefined, membership);
    const root = spans[0];
    expect(root.traceId).toBe(traceIdForJob(stackId));
    expect(root.parentSpanId).toBeDefined();
    expect(attrValue(root, "stack_job_id")).toEqual({ intValue: String(stackId) });
    // Children share the stack trace id.
    for (const span of spans) expect(span.traceId).toBe(traceIdForJob(stackId));
  });

  it("emits zero-duration markers for stack members that never got a job", () => {
    const store = makeStore();
    const stackId = seedJob(store, "stack_review");
    store.insertStackMembers(stackId, [
      { position: 0, prNumber: 4, baseRef: "main", headRef: "a", baseSha: "b0", headSha: "h0" },
      { position: 1, prNumber: 5, baseRef: "a", headRef: "b", baseSha: "b1", headSha: "h1" },
    ]);
    store.patchStackMember(store.listStackMembers(stackId)[0].id, { memberJobId: 999, state: "done" });
    store.patchStackMember(store.listStackMembers(stackId)[1].id, { state: "skipped" });
    store.setJobState(stackId, "completed");

    const members = store.listStackMembers(stackId);
    const spans = jobTrace(store.getJob(stackId)!, [], undefined, null, members);
    const markers = spans.filter((s) => s.name === "maomao.stack.member");
    expect(markers).toHaveLength(1);
    expect(attrValue(markers[0], "pr_number")).toEqual({ intValue: "5" });
    expect(attrValue(markers[0], "state")).toEqual({ stringValue: "skipped" });
    expect(markers[0].startTimeUnixNano).toBe(markers[0].endTimeUnixNano);
  });
});

describe("exportTerminalJobTraces", () => {
  it("does not fetch when OPENOBSERVE_TRACES_URL is unset", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = makeStore();
    const jobId = seedJob(store);
    store.setJobState(jobId, "completed");
    await flushOtlpExports();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a trace envelope on a terminal transition", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENOBSERVE_TRACES_URL", TRACES_URL);
    const store = makeStore();
    const jobId = seedJob(store);
    store.setJobState(jobId, "completed");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TRACES_URL);
    const body = JSON.parse(init.body as string);
    const spans = body.resourceSpans[0].scopeSpans[0].spans;
    expect(spans.map((s: OtlpSpan) => s.name)).toContain("maomao.job.pr_review");
    expect(body.resourceSpans[0].resource.attributes).toEqual(
      expect.arrayContaining([{ key: "service.name", value: { stringValue: "maomao" } }]),
    );
  });

  it("never throws when the store lookup fails", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = {
      getJob: () => {
        throw new Error("db gone");
      },
      listReviewerRuns: () => [],
      listStackMembers: () => [],
      stackMembershipForJobs: () => new Map(),
    };
    expect(() => exportTerminalJobTraces(store as unknown as JobStore, 1, {} as NodeJS.ProcessEnv)).not.toThrow();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("terminal trace failed for job 1"));
  });
});
