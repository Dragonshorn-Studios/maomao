import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
import { JobStore } from "../jobs/store.js";
import { JobQueue } from "../jobs/queue.js";
import { exportTerminalJobMetrics, queueMetrics, terminalJobMetrics, exportQueueMetrics } from "./metrics.js";
import { flushOtlpExports, type OtlpMetric } from "./otlp.js";

const METRICS_URL = "https://oo.example.com/api/default/v1/metrics";

function makeStore() {
  // Same opt-in the production store gets in src/index.ts.
  return new JobStore(openDb(":memory:"), [], { emitJobSummaries: true });
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

function metricByName(metrics: OtlpMetric[], name: string): OtlpMetric {
  const found = metrics.find((m) => m.name === name);
  if (!found) throw new Error(`metric ${name} not emitted`);
  return found;
}

function attrValue(attributes: { key: string; value: Record<string, unknown> }[] | undefined, key: string) {
  return attributes?.find((a) => a.key === key)?.value;
}

beforeEach(() => {
  vi.stubEnv("OPENOBSERVE_METRICS_URL", "");
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

describe("queueMetrics", () => {
  it("emits depth, in-use, and configured slot gauges", () => {
    const metrics = queueMetrics(3, 2, 4, "1000");
    const depth = metricByName(metrics, "maomao.queue.depth");
    const inUse = metricByName(metrics, "maomao.queue.slots_in_use");
    const slots = metricByName(metrics, "maomao.queue.slots");
    expect("gauge" in depth && depth.gauge.dataPoints[0]).toEqual({ timeUnixNano: "1000", asInt: "3" });
    expect("gauge" in inUse && inUse.gauge.dataPoints[0].asInt).toBe("2");
    expect("gauge" in slots && slots.gauge.dataPoints[0].asInt).toBe("4");
    expect(metrics).toHaveLength(3);
  });
});

describe("terminalJobMetrics", () => {
  it("emits a +1 jobs counter with terminal-state and job attrs", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    store.setJobState(jobId, "completed");
    const job = store.getJob(jobId)!;
    const metrics = terminalJobMetrics(job, store.listReviewerRuns(jobId), undefined, "1000");
    const jobs = metricByName(metrics, "maomao.jobs");
    if (!("sum" in jobs)) throw new Error("maomao.jobs is not a sum");
    expect(jobs.sum.isMonotonic).toBe(true);
    expect(jobs.sum.aggregationTemporality).toBe(1);
    const point = jobs.sum.dataPoints[0];
    expect(point.asInt).toBe("1");
    expect(attrValue(point.attributes, "job_type")).toEqual({ stringValue: "pr_review" });
    expect(attrValue(point.attributes, "repo")).toEqual({ stringValue: "acme/widgets" });
    expect(attrValue(point.attributes, "state")).toEqual({ stringValue: "completed" });
    expect(attrValue(point.attributes, "attempt")).toEqual({ intValue: "1" });
    expect(attrValue(point.attributes, "usage_complete")).toEqual({ boolValue: true });
  });

  it("emits delta token sums by kind from the same snapshot the summary uses", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    store.patchJob(jobId, { routing_prompt_tokens: 5, routing_completion_tokens: 3, routing_total_tokens: 8 });
    const job = store.getJob(jobId)!;
    const metrics = terminalJobMetrics(job, store.listReviewerRuns(jobId), undefined, "1000");
    const tokens = metricByName(metrics, "maomao.job.tokens");
    if (!("sum" in tokens)) throw new Error("maomao.job.tokens is not a sum");
    const byKind = new Map(tokens.sum.dataPoints.map((p) => [attrValue(p.attributes, "kind")?.stringValue, p.asInt]));
    expect(byKind.get("prompt")).toBe("5");
    expect(byKind.get("completion")).toBe("3");
    expect(byKind.get("total")).toBe("8");
    expect(tokens.sum.isMonotonic).toBe(true);
  });

  it("observes duration as a one-bucket delta histogram point", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    store.setJobState(jobId, "completed");
    const job = store.getJob(jobId)!;
    const metrics = terminalJobMetrics(job, store.listReviewerRuns(jobId), undefined, "1000");
    const duration = metricByName(metrics, "maomao.job.duration_ms");
    if (!("histogram" in duration)) throw new Error("maomao.job.duration_ms is not a histogram");
    const point = duration.histogram.dataPoints[0];
    expect(point.count).toBe("1");
    expect(point.sum).toBeGreaterThanOrEqual(0);
    expect(point.explicitBounds).toEqual([]);
    expect(attrValue(point.attributes, "state")).toEqual({ stringValue: "completed" });
  });

  it("omits the duration metric when finished_at is unset", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    const job = store.getJob(jobId)!;
    const metrics = terminalJobMetrics(job, store.listReviewerRuns(jobId), undefined, "1000");
    expect(metrics.find((m) => m.name === "maomao.job.duration_ms")).toBeUndefined();
  });

  it("emits cost only when a cost was measured", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    const job = store.getJob(jobId)!;
    expect(
      terminalJobMetrics(job, store.listReviewerRuns(jobId), undefined, "1000").find(
        (m) => m.name === "maomao.job.cost_usd",
      ),
    ).toBeUndefined();
    store.patchJob(jobId, { routing_cost: 0.042 });
    const withCost = terminalJobMetrics(store.getJob(jobId)!, store.listReviewerRuns(jobId), undefined, "1000");
    const cost = metricByName(withCost, "maomao.job.cost_usd");
    if (!("sum" in cost)) throw new Error("maomao.job.cost_usd is not a sum");
    expect(cost.sum.dataPoints[0].asDouble).toBeCloseTo(0.042);
  });

  it("marks usage_complete=false on a mid-flight snapshot", () => {
    const store = makeStore();
    const jobId = seedJob(store);
    const job = store.getJob(jobId)!;
    const metrics = terminalJobMetrics(job, store.listReviewerRuns(jobId), { partialUsage: true }, "1000");
    const jobs = metricByName(metrics, "maomao.jobs");
    if (!("sum" in jobs)) throw new Error("maomao.jobs is not a sum");
    expect(attrValue(jobs.sum.dataPoints[0].attributes, "usage_complete")).toEqual({ boolValue: false });
  });
});

describe("exportTerminalJobMetrics", () => {
  it("does not fetch when OPENOBSERVE_METRICS_URL is unset", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = makeStore();
    const jobId = seedJob(store);
    store.setJobState(jobId, "completed");
    await flushOtlpExports();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the terminal metrics envelope on a completed job", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENOBSERVE_METRICS_URL", METRICS_URL);
    const store = makeStore();
    const jobId = seedJob(store);
    store.setJobState(jobId, "completed");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(METRICS_URL);
    const body = JSON.parse(init.body as string);
    const names = body.resourceMetrics[0].scopeMetrics[0].metrics.map((m: OtlpMetric) => m.name);
    expect(names).toEqual(
      expect.arrayContaining(["maomao.jobs", "maomao.job.tokens", "maomao.job.duration_ms"]),
    );
  });

  it("never throws when the store lookup fails", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = {
      getJob: () => {
        throw new Error("db gone");
      },
      listReviewerRuns: () => [],
    };
    expect(() => exportTerminalJobMetrics(store as unknown as JobStore, 1, {} as NodeJS.ProcessEnv)).not.toThrow();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("terminal metrics failed for job 1"));
  });
});

describe("exportQueueMetrics + JobQueue", () => {
  it("exports gauges on enqueue and claim", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENOBSERVE_METRICS_URL", METRICS_URL);
    // Empty store: start() has no interrupted jobs to drain.
    const store = makeStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new JobQueue(store, 1, () => gate);
    queue.start(); // empty queue: emits (depth 0, in-use 0)
    queue.enqueue(1); // emits depth 1, then the claim emits (depth 0, in-use 1)
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3));
    const series = () => {
      const bodies = fetchMock.mock.calls.map(
        (c) => JSON.parse((c[1] as RequestInit).body as string).resourceMetrics[0].scopeMetrics[0].metrics,
      );
      const gaugeValue = (ms: OtlpMetric[], name: string) => {
        const m = ms.find((x: OtlpMetric) => x.name === name);
        return m && "gauge" in m ? m.gauge.dataPoints[0].asInt : undefined;
      };
      return {
        depth: bodies.map((ms: OtlpMetric[]) => gaugeValue(ms, "maomao.queue.depth")),
        inUse: bodies.map((ms: OtlpMetric[]) => gaugeValue(ms, "maomao.queue.slots_in_use")),
      };
    };
    expect(series().depth.slice(0, 3)).toEqual(["0", "1", "0"]);
    expect(series().inUse.slice(0, 3)).toEqual(["0", "0", "1"]);
    release();
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4));
    // Slot release re-pumps: the final gauge pair settles at (0, 0).
    expect(series().depth.at(-1)).toBe("0");
    expect(series().inUse.at(-1)).toBe("0");
    await flushOtlpExports();
  });

  it("fires only after the pending list changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENOBSERVE_METRICS_URL", METRICS_URL);
    exportQueueMetrics(2, 1, 3);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const names = body.resourceMetrics[0].scopeMetrics[0].metrics.map((m: OtlpMetric) => m.name);
    expect(names).toEqual(["maomao.queue.depth", "maomao.queue.slots_in_use", "maomao.queue.slots"]);
  });
});
