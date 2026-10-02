# OTLP exporter for OpenObserve — decision record

Issue [#143](https://github.com/Dragonshorn-Studios/maomao/issues/143) (child of meta [#138](https://github.com/Dragonshorn-Studios/maomao/issues/138)).

## Decision

**Thin hand-rolled OTLP/HTTP exporter** — `src/telemetry/otlp.ts` — not the OpenTelemetry SDK. Zero new dependencies.

## Options compared

### Full OpenTelemetry SDK (`@opentelemetry/sdk-trace-node` + `sdk-metrics` + `exporter-*-otlp-http`)

- **Dependency weight**: ~10+ packages (api, core, resources, semantic-conventions, two SDKs, two OTLP exporters) plus their transitive tree — the largest dep surface maomao would take on for telemetry that is strictly best-effort.
- **Shared conventions**: `service.name`/`resource` attrs are the whole point of the SDK, but maomao can emit the identical wire attrs by hand — `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` are honored directly, so fleet conventions (`deployment.environment`, shared `service.name`) carry over without the SDK.
- **Batching/retry**: `BatchSpanProcessor` and periodic metric readers solve queueing maomao does not have. Expected volume is one root span + a handful of children per job run and a few metric points per export tick; the existing serialized-POST discipline (one request in flight, capped pending queue, 10s timeout) already covers it.
- **Maintenance**: SDK upgrades, version-matrix compat (`api` peer pins), and instrumenting our own spans into their `Context` API — real ongoing cost for features (context propagation across processes, sampling, multiple exporters) we do not use.

### Thin OTLP/HTTP exporter (chosen)

- **Dependency weight**: zero — `fetch` + OTLP/JSON encoding, ~250 LOC owned by us, same shape as the `OPENOBSERVE_LOGS_URL` ingest POST that already works in production.
- **Shared conventions**: emits standard OTLP/JSON `resource` attrs — `service.name` from `OTEL_SERVICE_NAME` (default `maomao`), arbitrary pairs from `OTEL_RESOURCE_ATTRIBUTES` — the same standard env names other fleet apps use.
- **Batching/retry**: exports are fire-and-forget and serialized (one POST in flight, depth-capped, drop-and-log on overflow). Telemetry never blocks or retries job flow — identical semantics to the job-summary ingest. Best-effort is the stated bar for v1+; OpenObserve accepts plain OTLP/HTTP JSON at `…/v1/traces` and `…/v1/metrics`.
- **Maintenance**: OTLP/JSON is a stable documented wire format; the only ongoing cost is adding fields as the slices need them.

## Configuration

```bash
# Per-signal OTLP/HTTP endpoints — unset means that signal is off:
OPENOBSERVE_TRACES_URL=https://oo.example.com/api/default/v1/traces
OPENOBSERVE_METRICS_URL=https://oo.example.com/api/default/v1/metrics

# Auth — per-signal override wins, generic is the fallback. Ingestion is
# always HTTP Basic: the ingestion token is the password and the OpenObserve
# email the username (Bearer is not sent):
OPENOBSERVE_EMAIL=... + OPENOBSERVE_TOKEN=...        # Basic (email:ingestion-token)
# or: OPENOBSERVE_USER=... + OPENOBSERVE_PASSWORD=...   # Basic (legacy user/password)
# per-signal: OPENOBSERVE_TRACES_TOKEN / OPENOBSERVE_TRACES_EMAIL / OPENOBSERVE_TRACES_USER / ..._PASSWORD
#             OPENOBSERVE_METRICS_TOKEN / OPENOBSERVE_METRICS_EMAIL / OPENOBSERVE_METRICS_USER / ..._PASSWORD

# Resource conventions (standard OTel env names, shared with the fleet):
OTEL_SERVICE_NAME=maomao              # resource attr service.name
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=prod,fleet=szefowo
```

## Hard rules carried from #139

- Usage metadata only: ids, states, durations, token counts — **no** secrets, PII, diff text, webhook URLs, or review bodies in attributes. Sole identity carve-out: `user.id` carries the PR author's forge login (already public on the pull request) for OpenObserve's Sessions user column; `TELEMETRY_USER_ID=false` omits it everywhere.
- Credentials live in env only and are never logged; fetch/endpoint errors are redacted before printing; plain-`http` endpoints with credentials warn once.
- Exports are serialized, depth-capped, 10s-bounded, and never throw — a broken endpoint cannot affect job flow.

## When to revisit

Switch to the OTel SDK if we need: context propagation **across processes** (the thin exporter propagates in-process via parentSpanId/links only), tail-sampling or a collector between maomao and OO, more than one backend, or auto-instrumentation of HTTP/db libraries. None of those are in scope for #141/#142.

## What lands on this skeleton

- **#141 (metrics)** — landed in this stack: `src/telemetry/metrics.ts` emits queue gauges and per-terminal-job counters/histograms via `exportMetrics(...)`.
- **#142 (traces)** — landed in this stack: `src/telemetry/traces.ts` rebuilds the span tree at terminal time from the persisted stage timings (`buildJobSummary` snapshot + `reviewer_runs` rows). Trace/span ids are deterministic hashes of the job id, so member `pr_review` jobs parent into the `stack_review` trace without in-flight context propagation.

Operator-side setup: [openobserve-setup.md](openobserve-setup.md).
