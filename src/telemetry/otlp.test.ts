import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attr,
  exportMetrics,
  exportTraces,
  flushOtlpExports,
  metricsEnvelope,
  nanoTime,
  newSpanId,
  newTraceId,
  otlpEndpoint,
  resourceAttributes,
  tracesEnvelope,
  type OtlpMetric,
  type OtlpSpan,
} from "./otlp.js";

function makeSpan(overrides?: Partial<OtlpSpan>): OtlpSpan {
  return {
    traceId: "0".repeat(32),
    spanId: "1".repeat(16),
    name: "job.run",
    startTimeUnixNano: "1000",
    endTimeUnixNano: "2000",
    ...overrides,
  };
}

function makeGauge(): OtlpMetric {
  return {
    name: "maomao.queue.depth",
    unit: "{jobs}",
    gauge: { dataPoints: [{ timeUnixNano: "1000", asInt: "3" }] },
  };
}

const TRACES_URL = "https://oo.example.com/api/default/v1/traces";
const METRICS_URL = "https://oo.example.com/api/default/v1/metrics";

beforeEach(() => {
  // Keep the ambient environment out: a developer or CI box with OTLP envs
  // exported must not produce real POSTs.
  vi.stubEnv("OPENOBSERVE_TRACES_URL", "");
  vi.stubEnv("OPENOBSERVE_METRICS_URL", "");
  vi.stubEnv("OPENOBSERVE_TOKEN", "");
  vi.stubEnv("OPENOBSERVE_USER", "");
  vi.stubEnv("OPENOBSERVE_PASSWORD", "");
  vi.stubEnv("OPENOBSERVE_TRACES_TOKEN", "");
  vi.stubEnv("OPENOBSERVE_METRICS_TOKEN", "");
  vi.stubEnv("OTEL_SERVICE_NAME", "");
  vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "");
});

afterEach(async () => {
  // Drain the serialized export queue so a test's queued POST can't bleed
  // fetch calls into the next test's stubs.
  await flushOtlpExports();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("attr", () => {
  it("encodes strings, booleans, integers, and doubles", () => {
    expect(attr("a", "x")).toEqual({ key: "a", value: { stringValue: "x" } });
    expect(attr("b", true)).toEqual({ key: "b", value: { boolValue: true } });
    expect(attr("c", 7)).toEqual({ key: "c", value: { intValue: "7" } });
    expect(attr("d", 0.5)).toEqual({ key: "d", value: { doubleValue: 0.5 } });
  });
});

describe("nanoTime", () => {
  it("encodes epoch milliseconds as int64 nanosecond strings", () => {
    expect(nanoTime(1_700_000_000_123)).toBe("1700000000123000000");
    expect(nanoTime(0.9)).toBe("0");
    expect(typeof nanoTime()).toBe("string");
  });
});

describe("id generation", () => {
  it("returns lowercase hex ids of the OTLP widths", () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
    expect(newTraceId()).not.toBe(newTraceId());
  });
});

describe("resourceAttributes", () => {
  it("defaults service.name to maomao", () => {
    expect(resourceAttributes({} as NodeJS.ProcessEnv)).toEqual([
      { key: "service.name", value: { stringValue: "maomao" } },
    ]);
  });

  it("honors OTEL_SERVICE_NAME and parses OTEL_RESOURCE_ATTRIBUTES", () => {
    const env = {
      OTEL_SERVICE_NAME: "maomao-prod",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=prod, fleet=szefowo,bad-pair,=novalue",
    } as NodeJS.ProcessEnv;
    expect(resourceAttributes(env)).toEqual([
      { key: "service.name", value: { stringValue: "maomao-prod" } },
      { key: "deployment.environment", value: { stringValue: "prod" } },
      { key: "fleet", value: { stringValue: "szefowo" } },
    ]);
  });

  it("warns once per distinct malformed pair", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = { OTEL_RESOURCE_ATTRIBUTES: "malformed-no-equals" } as NodeJS.ProcessEnv;
    resourceAttributes(env);
    resourceAttributes(env);
    const warnings = err.mock.calls.filter((c) => String(c[0]).includes("malformed-no-equals"));
    expect(warnings).toHaveLength(1);
  });
});

describe("otlpEndpoint", () => {
  it("returns null when the signal URL is unset", () => {
    expect(otlpEndpoint("traces", {} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("resolves the per-signal URL with a json content type", () => {
    const env = { OPENOBSERVE_TRACES_URL: TRACES_URL } as NodeJS.ProcessEnv;
    const endpoint = otlpEndpoint("traces", env);
    expect(endpoint?.url).toBe(TRACES_URL);
    expect(endpoint?.headers["content-type"]).toBe("application/json");
    expect(endpoint?.headers.authorization).toBeUndefined();
  });

  it("prefers a per-signal token over the generic token", () => {
    const env = {
      OPENOBSERVE_METRICS_URL: METRICS_URL,
      OPENOBSERVE_METRICS_TOKEN: "sig-tok",
      OPENOBSERVE_TOKEN: "generic-tok",
    } as NodeJS.ProcessEnv;
    expect(otlpEndpoint("metrics", env)?.headers.authorization).toBe("Bearer sig-tok");
    const fallback = {
      OPENOBSERVE_METRICS_URL: METRICS_URL,
      OPENOBSERVE_TOKEN: "generic-tok",
    } as NodeJS.ProcessEnv;
    expect(otlpEndpoint("metrics", fallback)?.headers.authorization).toBe("Bearer generic-tok");
  });

  it("falls back to basic auth from generic credentials", () => {
    const env = {
      OPENOBSERVE_TRACES_URL: TRACES_URL,
      OPENOBSERVE_USER: "u",
      OPENOBSERVE_PASSWORD: "p",
    } as NodeJS.ProcessEnv;
    const expected = `Basic ${Buffer.from("u:p").toString("base64")}`;
    expect(otlpEndpoint("traces", env)?.headers.authorization).toBe(expected);
  });
});

describe("envelopes", () => {
  it("wraps spans in resourceSpans with the maomao scope", () => {
    const body = tracesEnvelope([makeSpan()], {} as NodeJS.ProcessEnv);
    expect(body.resourceSpans).toHaveLength(1);
    expect(body.resourceSpans[0].resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "maomao" } },
    ]);
    expect(body.resourceSpans[0].scopeSpans[0].scope).toEqual({ name: "maomao" });
    expect(body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
  });

  it("wraps metrics in resourceMetrics with the maomao scope", () => {
    const body = metricsEnvelope([makeGauge()], {} as NodeJS.ProcessEnv);
    expect(body.resourceMetrics).toHaveLength(1);
    expect(body.resourceMetrics[0].scopeMetrics[0].metrics[0].name).toBe("maomao.queue.depth");
  });
});

describe("exportTraces/exportMetrics", () => {
  it("does not call fetch when the endpoint is unconfigured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    exportTraces([makeSpan()]);
    exportMetrics([makeGauge()]);
    await flushOtlpExports();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips empty batches even when configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENOBSERVE_TRACES_URL", TRACES_URL);
    exportTraces([]);
    await flushOtlpExports();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the OTLP envelope to the configured endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENOBSERVE_TRACES_URL", TRACES_URL);
    vi.stubEnv("OPENOBSERVE_TOKEN", "tok");
    exportTraces([makeSpan()]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TRACES_URL);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const body = JSON.parse(init.body as string);
    expect(body.resourceSpans[0].scopeSpans[0].spans[0].name).toBe("job.run");
  });

  it("uses the stored config when no env vars are set, and env wins over it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    exportTraces([makeSpan()], process.env, { url: "https://stored.test/v1/traces", user: "su", password: "sp" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://stored.test/v1/traces");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("su:sp").toString("base64")}`,
    );

    vi.stubEnv("OPENOBSERVE_TRACES_URL", TRACES_URL);
    vi.stubEnv("OPENOBSERVE_TRACES_TOKEN", "env-tok");
    exportTraces([makeSpan()], process.env, { url: "https://stored.test/v1/traces", user: "su", password: "sp" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url2, init2] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url2).toBe(TRACES_URL);
    expect((init2.headers as Record<string, string>).authorization).toBe("Bearer env-tok");
  });

  it("serializes exports: one POST in flight, order preserved", async () => {
    const order: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      order.push(url);
      return { ok: true, status: 200 };
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENOBSERVE_TRACES_URL", TRACES_URL);
    vi.stubEnv("OPENOBSERVE_METRICS_URL", METRICS_URL);
    exportTraces([makeSpan()]);
    exportMetrics([makeGauge()]);
    exportTraces([makeSpan({ spanId: "2".repeat(16) })]);
    await flushOtlpExports();
    expect(order).toEqual([TRACES_URL, METRICS_URL, TRACES_URL]);
  });

  it("logs and continues on non-ok responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 502 });
    vi.stubGlobal("fetch", fetchMock);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("OPENOBSERVE_TRACES_URL", TRACES_URL);
    exportTraces([makeSpan()]);
    await flushOtlpExports();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("traces export returned 502"));
  });

  it("redacts the endpoint URL from fetch errors", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error(`fetch failed: ${TRACES_URL} unreachable`));
    vi.stubGlobal("fetch", fetchMock);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("OPENOBSERVE_TRACES_URL", TRACES_URL);
    exportTraces([makeSpan()]);
    await flushOtlpExports();
    const logged = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("<otlp-url>");
    expect(logged).not.toContain("oo.example.com");
  });

  it("warns once about credentials over plain http", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const httpUrl = "http://oo.internal/api/default/v1/metrics";
    vi.stubEnv("OPENOBSERVE_METRICS_URL", httpUrl);
    vi.stubEnv("OPENOBSERVE_TOKEN", "tok");
    exportMetrics([makeGauge()]);
    exportMetrics([makeGauge()]);
    await flushOtlpExports();
    const warnings = err.mock.calls.filter((c) => String(c[0]).includes("cleartext"));
    expect(warnings).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never throws on an unserializable payload — logs instead", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("OPENOBSERVE_TRACES_URL", TRACES_URL);
    const circular: Record<string, unknown> = { name: "x" };
    circular.self = circular;
    expect(() => exportTraces([circular as unknown as OtlpSpan])).not.toThrow();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("traces export failed"));
  });

  it("stays silent on plain http when no credentials are sent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("OPENOBSERVE_METRICS_URL", "http://oo.internal/api/default/v1/metrics");
    exportMetrics([makeGauge()]);
    await flushOtlpExports();
    expect(err).not.toHaveBeenCalled();
  });
});
