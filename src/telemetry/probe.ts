import { redactSecrets, truncate } from "../util.js";
import {
  attr,
  metricsEnvelope,
  nanoTime,
  newSpanId,
  newTraceId,
  tracesEnvelope,
  type OtlpMetric,
  type OtlpSpan,
} from "./otlp.js";
import { telemetryAuthHeader, type TelemetryChannel, type TelemetryChannelConfig } from "./settings.js";

/**
 * Synchronous connection probe for /config/telemetry: POST one real
 * telemetry payload per channel to a given OpenObserve endpoint and report
 * HTTP status, so the operator verifies URL + credentials from the page
 * instead of waiting for a terminal job. Unlike the export path this is a
 * request/response probe — it awaits the POST, returns the status, and
 * redacts credentials from errors before they reach the page.
 *
 * The payload is usage metadata only (the hard rule from #139): a one-span
 * trace, a one-point gauge, or a one-line log marked `probe`, so OpenObserve
 * dashboards can filter it out via `maomao.telemetry_test` / `probe=true`.
 */

export type ProbeResult =
  | { ok: true; status: number }
  | { ok: false; status?: number; detail: string };

function probeSpan(): OtlpSpan {
  const now = nanoTime();
  return {
    traceId: newTraceId(),
    spanId: newSpanId(),
    name: "maomao.telemetry_test",
    kind: 1,
    startTimeUnixNano: now,
    endTimeUnixNano: now,
    attributes: [attr("probe", "connection_test")],
  };
}

function probeMetric(): OtlpMetric {
  return {
    name: "maomao.telemetry_test",
    unit: "{tests}",
    description: "Connection test probes sent from /config/telemetry",
    gauge: {
      dataPoints: [{ timeUnixNano: nanoTime(), asInt: "1", attributes: [attr("probe", "connection_test")] }],
    },
  };
}

function probeBody(channel: TelemetryChannel, env: NodeJS.ProcessEnv): string {
  if (channel === "logs") {
    // _json's documented contract is a JSON array of records (same wrapper
    // the real ingest POST in jobs/summary.ts uses).
    return JSON.stringify([{ event: "maomao.telemetry_test", probe: "connection_test", ts: new Date().toISOString() }]);
  }
  return channel === "traces"
    ? JSON.stringify(tracesEnvelope([probeSpan()], env))
    : JSON.stringify(metricsEnvelope([probeMetric()], env));
}

function probeAuth(config: TelemetryChannelConfig): Record<string, string> {
  return telemetryAuthHeader(config);
}

const PROBE_TIMEOUT_MS = 10_000;

/** POST one probe payload; returns HTTP status or a redacted error detail. Never throws. */
export async function probeTelemetryChannel(
  channel: TelemetryChannel,
  config: TelemetryChannelConfig,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const url = config.url?.trim();
  if (!url) return { ok: false, detail: "No endpoint URL configured for this channel." };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, detail: "Endpoint URL must be http(s)." };
    }
  } catch {
    return { ok: false, detail: "Endpoint URL is not a valid URL." };
  }
  // Everything the response or a thrown error could echo back to the page.
  const secrets = [config.token, config.user, config.password, url]
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...probeAuth(config) },
      body: probeBody(channel, env),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // A HTML body means the probe hit a login page or reverse proxy, not the
    // OpenObserve ingest API — report that instead of dumping markup.
    const contentType = response.headers.get("content-type") ?? "";
    const body = (await response.text()).trim();
    if (contentType.includes("html") || body.startsWith("<")) {
      return {
        ok: false,
        status: response.status,
        detail: `HTTP ${response.status} — Received an HTML response instead of an OpenObserve telemetry response. Check the endpoint or reverse proxy.`,
      };
    }
    if (response.ok) return { ok: true, status: response.status };
    const detail = truncate(redactSecrets(body, secrets), 300);
    return { ok: false, status: response.status, detail: `HTTP ${response.status}${detail ? ` — ${detail}` : ""}` };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: truncate(redactSecrets(raw, secrets), 300) || "request failed" };
  }
}
