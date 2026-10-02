import { randomBytes } from "node:crypto";
import {
  resolveChannelAuth,
  telemetryAuthHeader,
  resolveChannelUrl,
  maskUrlCredentials,
  type TelemetryChannelConfig,
  type TelemetrySharedConfig,
} from "./settings.js";
import { emitAppLog } from "./app-log.js";

/**
 * Thin OTLP/HTTP exporter groundwork (issue #143, meta #138): hand-rolled
 * OTLP/JSON over HTTP POST to OpenObserve — no OpenTelemetry SDK. The
 * decision and rationale live in docs/telemetry/otlp-exporter.md.
 *
 * This module is the transport + wire-format layer the metrics (#141) and
 * traces (#142) slices land on: it resolves per-signal endpoints from env,
 * encodes OTLP envelopes, and ships them through the same fire-and-forget
 * serialized POST discipline as the job-summary ingest (src/jobs/summary.ts)
 * — one request in flight, a capped pending queue, a bounded timeout, and
 * errors logged with credentials redacted. Nothing here is wired into the
 * pipeline yet; payloads stay usage metadata only — never secrets, diffs,
 * webhook URLs, or review bodies.
 *
 * Env (mirrors the OPENOBSERVE_LOGS_* pattern):
 *   OPENOBSERVE_TRACES_URL / OPENOBSERVE_METRICS_URL — full OTLP/HTTP
 *     endpoint per signal (e.g. https://oo.example.com/api/default/v1/traces).
 *     Unset = that signal is silently off. OPENOBSERVE_BASE_URL (e.g.
 *     https://oo.example.com/api/default) derives both when the per-signal
 *     URL is unset.
 *   Auth, resolved per signal with a generic fallback — always HTTP Basic
 *   (OpenObserve ingestion rejects Bearer):
 *     (OPENOBSERVE_<SIGNAL>_EMAIL ?? OPENOBSERVE_EMAIL) +
 *     (OPENOBSERVE_<SIGNAL>_TOKEN ?? OPENOBSERVE_TOKEN)        → Basic (email:ingestion-token)
 *     OPENOBSERVE_<SIGNAL>_USER  ?? OPENOBSERVE_USER           → Basic (user)
 *     OPENOBSERVE_<SIGNAL>_PASSWORD ?? OPENOBSERVE_PASSWORD    → Basic (pass)
 *   Resource conventions shared with the rest of the fleet:
 *     OTEL_SERVICE_NAME          → resource attr service.name (default "maomao")
 *     OTEL_RESOURCE_ATTRIBUTES   → extra resource attrs, "k=v,k2=v2" (strings)
 */

export type OtlpSignal = "traces" | "metrics";

export interface OtlpEndpoint {
  url: string;
  headers: Record<string, string>;
}

/** OTLP/JSON AnyValue — attribute values stay usage metadata only. */
export interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };
}

/** Integer-valued OTLP attributes encode int64 as a JSON string per the protobuf JSON mapping. */
export function attr(key: string, value: string | number | boolean): OtlpAttribute {
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (Number.isInteger(value)) return { key, value: { intValue: String(value) } };
  return { key, value: { doubleValue: value } };
}

/** Span kind / status as int enum values — OpenObserve's JSON decoder requires the i32 form. */
export const SPAN_KIND_INTERNAL = 1;
export const SPAN_KIND_CLIENT = 3;
export const STATUS_CODE_OK = 1;
export const STATUS_CODE_ERROR = 2;

/**
 * OpenObserve's strict OTLP-JSON span decoder rejects fractional
 * `doubleValue` ("invalid type: map, expected f64"), dropping the whole
 * envelope — verified against v1.0.4 (integral doubles and string forms of
 * integers pass; fractional values 400). Emit integral doubles as
 * `doubleValue`, fractional ones as `stringValue`; callers that need the
 * number machine-readable should also emit an `intValue` micros twin.
 */
export function compatDoubleAttr(key: string, value: number): OtlpAttribute {
  return Number.isInteger(value)
    ? { key, value: { doubleValue: value } }
    : { key, value: { stringValue: String(value) } };
}

/** OTLP/JSON span shape; traceId/spanId are lowercase hex (32/16 chars). */
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** 1=internal, 2=server, 3=client, 4=producer, 5=consumer. */
  kind?: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpAttribute[];
  /** status.code: 0=unset, 1=ok, 2=error. */
  status?: { code: number; message?: string };
  links?: { traceId: string; spanId: string; attributes?: OtlpAttribute[] }[];
}

export interface OtlpNumberDataPoint {
  timeUnixNano: string;
  attributes?: OtlpAttribute[];
  asInt?: string;
  asDouble?: number;
}

export interface OtlpHistogramDataPoint {
  timeUnixNano: string;
  attributes?: OtlpAttribute[];
  count: string;
  sum?: number;
  bucketCounts: string[];
  explicitBounds: number[];
}

/** aggregationTemporality: 1=delta, 2=cumulative. */
export type OtlpMetric =
  | { name: string; unit?: string; description?: string; gauge: { dataPoints: OtlpNumberDataPoint[] } }
  | {
      name: string;
      unit?: string;
      description?: string;
      sum: { dataPoints: OtlpNumberDataPoint[]; aggregationTemporality: number; isMonotonic: boolean };
    }
  | {
      name: string;
      unit?: string;
      description?: string;
      histogram: { dataPoints: OtlpHistogramDataPoint[]; aggregationTemporality: number };
    };

const SCOPE_NAME = "maomao";

/** ms epoch → OTLP int64 nanoseconds, as the decimal string the JSON mapping uses. */
export function nanoTime(epochMs: number = Date.now()): string {
  return `${BigInt(Math.trunc(epochMs)) * 1_000_000n}`;
}

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Resource attributes for every envelope: `service.name` (OTEL_SERVICE_NAME,
 * default "maomao") plus OTEL_RESOURCE_ATTRIBUTES pairs — the standard env
 * names other fleet apps use, so dashboards share resource conventions.
 * Malformed pairs (no '=', empty key) are skipped with a once-per-value
 * warning; values stay strings.
 */
// A typo in OTEL_RESOURCE_ATTRIBUTES silently dropping a resource attribute
// is an invisible misconfiguration — warn once per distinct malformed pair.
const malformedAttrWarned = new Set<string>();

export function resourceAttributes(env: NodeJS.ProcessEnv = process.env): OtlpAttribute[] {
  const attrs = [attr("service.name", env.OTEL_SERVICE_NAME?.trim() || "maomao")];
  const raw = env.OTEL_RESOURCE_ATTRIBUTES?.trim();
  if (!raw) return attrs;
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      if (!malformedAttrWarned.has(pair)) {
        malformedAttrWarned.add(pair);
        console.error(`otlp: skipping malformed OTEL_RESOURCE_ATTRIBUTES pair "${pair}" — expected key=value`);
      }
      continue;
    }
    attrs.push(attr(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()));
  }
  return attrs;
}

/**
 * Authorization headers for one signal: env wins (per-signal then generic
 * OPENOBSERVE_*), the stored /config/telemetry value fills the gap.
 */
function authHeaders(
  signal: OtlpSignal,
  env: NodeJS.ProcessEnv,
  stored?: TelemetryChannelConfig,
  shared?: TelemetrySharedConfig,
): Record<string, string> {
  return telemetryAuthHeader(resolveChannelAuth(signal, env, stored, shared));
}

/**
 * Resolve the configured endpoint for one signal — env URL wins over the
 * stored one — or null when neither layer configures a URL.
 */
export function otlpEndpoint(
  signal: OtlpSignal,
  env: NodeJS.ProcessEnv = process.env,
  stored?: TelemetryChannelConfig,
  shared?: TelemetrySharedConfig,
): OtlpEndpoint | null {
  const url = resolveChannelUrl(signal, env, stored, shared);
  if (!url) return null;
  return { url, headers: { "content-type": "application/json", ...authHeaders(signal, env, stored, shared) } };
}

/** Wrap spans in the OTLP resourceSpans envelope for one export call. */
export function tracesEnvelope(spans: OtlpSpan[], env: NodeJS.ProcessEnv = process.env) {
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes(env) },
        scopeSpans: [{ scope: { name: SCOPE_NAME }, spans }],
      },
    ],
  };
}

/** Wrap metrics in the OTLP resourceMetrics envelope for one export call. */
export function metricsEnvelope(metrics: OtlpMetric[], env: NodeJS.ProcessEnv = process.env) {
  return {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttributes(env) },
        scopeMetrics: [{ scope: { name: SCOPE_NAME }, metrics }],
      },
    ],
  };
}

// Export POSTs are serialized like the job-summary ingest: one request in
// flight at most, so a burst of spans/metrics cannot fan out unbounded
// sockets against a slow endpoint.
let postChain: Promise<void> = Promise.resolve();

// Depth cap: serialization bounds concurrency, not backlog. Telemetry is
// best-effort — overflow drops and logs rather than delaying delivery for
// minutes behind a stalled endpoint.
const MAX_PENDING_EXPORTS = 256;
let pendingExports = 0;

// Warn once per distinct URL: credentials over plain http travel in
// cleartext — a scheme typo must not silently downgrade transport security.
const insecureEndpointWarned = new Set<string>();

function redactEndpointError(message: string, url: string): string {
  let safe = message.split(url).join("<otlp-url>");
  try {
    const parsed = new URL(url);
    if (parsed.href !== url) safe = safe.split(parsed.href).join("<otlp-url>");
    if (parsed.username || parsed.password) {
      safe = safe.replace(/\/\/[^/\s]+@/g, "//<credentials>@");
    }
  } catch {
    // Unparseable configured URL — the exact-string pass above is all we can do.
  }
  return safe;
}

function queueExport(
  signal: OtlpSignal,
  endpoint: OtlpEndpoint,
  body: string,
  env: NodeJS.ProcessEnv,
  logsStored?: TelemetryChannelConfig,
  shared?: TelemetrySharedConfig,
  appLogs = true,
): void {
  if (pendingExports >= MAX_PENDING_EXPORTS) {
    console.error(`otlp: dropping ${signal} export: queue full`);
    if (appLogs) {
      emitAppLog(
        "telemetry_export_dropped",
        { level: "warn", signal, reason: "queue full", url: maskUrlCredentials(endpoint.url) },
        env,
        logsStored,
        shared,
      );
    }
    return;
  }
  if (endpoint.headers.authorization && endpoint.url.startsWith("http://") && !insecureEndpointWarned.has(endpoint.url)) {
    insecureEndpointWarned.add(endpoint.url);
    console.error(`otlp: ${signal} endpoint uses http — credentials are sent in cleartext`);
  }
  pendingExports += 1;
  postChain = postChain.then(async () => {
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: endpoint.headers,
        body,
        // Bounded so a hung endpoint cannot linger forever; there is no
        // retry — telemetry is best-effort, job flow never waits on it.
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        // The upstream error body is the fastest route to "why" (auth vs
        // malformed envelope vs wrong endpoint) — carry it, sanitized and
        // capped, into the app-log event and stderr.
        const raw = typeof response.text === "function" ? await response.text().catch(() => "") : "";
        const detail = redactEndpointError(raw.replace(/\s+/g, " ").trim().slice(0, 300), endpoint.url);
        const auth = endpoint.headers.authorization;
        const safeDetail = auth ? detail.split(auth).join("[redacted]") : detail;
        console.error(`otlp: ${signal} export returned ${response.status}${safeDetail ? `: ${safeDetail}` : ""}`);
        if (appLogs) {
          emitAppLog(
            "telemetry_export_failed",
            {
              level: "error",
              signal,
              status: response.status,
              url: maskUrlCredentials(endpoint.url),
              ...(safeDetail ? { response: safeDetail } : {}),
            },
            env,
            logsStored,
            shared,
          );
        }
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const safe = redactEndpointError(raw, endpoint.url);
      console.error(`otlp: ${signal} export failed: ${safe}`);
      if (appLogs) {
        emitAppLog(
          "telemetry_export_failed",
          { level: "error", signal, error: safe, url: maskUrlCredentials(endpoint.url) },
          env,
          logsStored,
          shared,
        );
      }
    } finally {
      pendingExports -= 1;
    }
    // Self-healing chain: a rejection escaping the task must not leave
    // postChain rejected and wedge every later export.
  }).catch(() => {});
}

/** Test hook: resolves once every queued export POST has settled. */
export function flushOtlpExports(): Promise<void> {
  return postChain;
}

/**
 * Fire-and-forget one trace export. Never throws: a broken or unconfigured
 * endpoint must not affect job flow. Empty span batches are skipped.
 */
export function exportTraces(
  spans: OtlpSpan[],
  env: NodeJS.ProcessEnv = process.env,
  stored?: TelemetryChannelConfig,
  shared?: TelemetrySharedConfig,
  logsStored?: TelemetryChannelConfig,
  appLogs = true,
): void {
  try {
    if (spans.length === 0) return;
    const endpoint = otlpEndpoint("traces", env, stored, shared);
    if (!endpoint) return;
    queueExport("traces", endpoint, JSON.stringify(tracesEnvelope(spans, env)), env, logsStored, shared, appLogs);
  } catch (error) {
    console.error(
      `otlp: traces export failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Fire-and-forget one metrics export. Never throws. Empty metric batches
 * are skipped.
 */
export function exportMetrics(
  metrics: OtlpMetric[],
  env: NodeJS.ProcessEnv = process.env,
  stored?: TelemetryChannelConfig,
  shared?: TelemetrySharedConfig,
  logsStored?: TelemetryChannelConfig,
  appLogs = true,
): void {
  try {
    if (metrics.length === 0) return;
    const endpoint = otlpEndpoint("metrics", env, stored, shared);
    if (!endpoint) return;
    queueExport("metrics", endpoint, JSON.stringify(metricsEnvelope(metrics, env)), env, logsStored, shared, appLogs);
  } catch (error) {
    console.error(
      `otlp: metrics export failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
