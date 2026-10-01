# Setting up OpenObserve for maomao telemetry

Maomao emits three channels into OpenObserve, all best-effort and never blocking jobs:

| Channel | Env var | Endpoint shape | Content |
|---|---|---|---|
| Job summaries (logs) | `OPENOBSERVE_LOGS_URL` | `/api/<org>/<stream>/_json` | one JSON line per terminal job transition |
| Metrics (OTLP) | `OPENOBSERVE_METRICS_URL` | `/api/<org>/v1/metrics` | queue gauges + per-terminal-job counters |
| Traces (OTLP) | `OPENOBSERVE_TRACES_URL` | `/api/<org>/v1/traces` | one span tree per terminal job run |

Each channel is independent — set only the ones you want. Everything below applies per channel.

The operator UI at `/config/telemetry` shows the effective endpoint + auth
source per channel, persists settings under the XDG data dir (env vars still
win over stored values), and can POST a probe payload to verify a connection
before it is committed — either the effective config or ad-hoc values that
are never saved. The env-var setup below remains the primary path for
production deployments.

## 1. OpenObserve side

### Credentials

OpenObserve authenticates ingestion with `Authorization: Basic <base64(email:password)>`.
Create a dedicated user (or reuse an existing login); maomao builds the header
itself from `OPENOBSERVE_USER`/`OPENOBSERVE_PASSWORD`, so keep the raw email
and password — no base64 needed:

```bash
OPENOBSERVE_USER=maomao-ingest@example.com
OPENOBSERVE_PASSWORD=<password>
```

A Bearer token (`OPENOBSERVE_TOKEN`) also works if your deployment fronts OO
with a token-issuing proxy; for a stock OpenObserve, Basic is the path.

### Endpoints

- Cloud: `https://api.openobserve.ai/api/<org>/...`
- Self-hosted default: `http://<host>:5080/api/<org>/...` (`default` org)

In the OO UI, **Ingestion → Custom → OpenTelemetry** shows the exact HTTP
endpoint and a prebuilt Authorization header for your instance.

Use plain `https://` in production — over `http://` credentials travel in
cleartext and maomao warns once per endpoint on stderr (`otlp: … uses http —
credentials are sent in cleartext`).

## 2. Maomao env

```bash
# Logs — job summary stream (existing channel). Note the stream name in the path:
OPENOBSERVE_LOGS_URL=https://oo.example.com/api/default/maomao/_json

# OTLP signals — no stream name; OO maps by signal type:
OPENOBSERVE_METRICS_URL=https://oo.example.com/api/default/v1/metrics
OPENOBSERVE_TRACES_URL=https://oo.example.com/api/default/v1/traces

# Logs auth — per-signal only (the logs channel predates the generic names):
OPENOBSERVE_LOGS_USER=maomao-ingest@example.com
OPENOBSERVE_LOGS_PASSWORD=<password>
# OTLP auth — generic, shared by traces + metrics (per-signal overrides exist):
OPENOBSERVE_USER=maomao-ingest@example.com
OPENOBSERVE_PASSWORD=<password>

# Resource attributes stamped on every OTLP envelope (fleet conventions):
OTEL_SERVICE_NAME=maomao
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=prod,fleet=<name>
```

- `JOB_SUMMARIES=false` turns off **all** terminal-state telemetry (logs,
  metrics, and traces emit from the same seam). Queue gauges are unaffected —
  they emit on queue mutations regardless.
- Auth resolution: OTLP signals take `OPENOBSERVE_<SIGNAL>_TOKEN ??
  OPENOBSERVE_TOKEN` (Bearer) or `OPENOBSERVE_<SIGNAL>_USER ??
  OPENOBSERVE_USER` + the matching `_PASSWORD` (Basic), `<SIGNAL>` = `TRACES`
  or `METRICS`. The logs channel reads only `OPENOBSERVE_LOGS_TOKEN` /
  `OPENOBSERVE_LOGS_USER` / `OPENOBSERVE_LOGS_PASSWORD` — no generic fallback.

## 3. Verify

Enqueue a review (or dequeue/requeue to move the queue), then:

- **Traces**: OO Traces tab → service `maomao`. Each terminal job run is one
  trace, `maomao.job.<job_type>` root with `maomao.stage.*` children. A
  `stack_review` trace contains member `pr_review` trees parented to the
  stack root.
- **Metrics**: Metrics explorer → `maomao.queue.depth`,
  `maomao.queue.slots_in_use`, `maomao.queue.slots`, `maomao.jobs`,
  `maomao.job.tokens`, `maomao.job.cost_usd`, `maomao.job.duration_ms`.
- **Logs**: Logs tab → stream `maomao`, filter
  `event='maomao.job_summary'`.

## 4. Semantics worth knowing when dashboarding

- **Terminal-time emission**: traces and per-job metrics appear only when a
  job finishes (or fails/cancels) — nothing mid-run.
- **Delta temporality**: counters are DELTA sums of each terminal event's
  contribution. A retried job emits again with a higher `attempt` attribute;
  routing and internal-escalation spend carries across attempts, so summing
  every point re-counts those stages — for per-job totals take the latest
  `attempt`, same rollup as the UI.
- **`usage_complete=false`** marks a snapshot taken mid-flight (stale/cancel
  of a running job): a floor, not a total.
- **Gauges report on change**, not on a timer — depth/slots move only when
  the queue mutates, so flat lines between mutations are expected.
- **Best-effort delivery**: fire-and-forget, at-most-once, no retry and no
  durable outbox. A crash between the terminal commit and the POST loses
  that event; overflow of the 256-deep pending queue drops and logs.
- **Member→stack trace linkage is by id, not ordering**: a member
  `pr_review` posts its spans the moment *it* finishes, usually before the
  stack's root span exists — OO resolves the parent when the stack job
  lands. A member belonging to several stack runs joins the latest.

## 5. Troubleshooting

| stderr line | Meaning |
|---|---|
| `otlp: <signal> export returned <status>` | Endpoint reachable but rejected — usually wrong org in the URL or bad credentials (401/403). |
| `otlp: <signal> export failed: <err>` | Network/TLS error reaching the endpoint; URL path typos surface here. |
| `otlp: dropping <signal> export: queue full` | More than 256 pending POSTs — endpoint is down or very slow. |
| `otlp: <signal> endpoint uses http — credentials are sent in cleartext` | URL scheme is `http://` with auth configured. |
| `otlp: skipping malformed OTEL_RESOURCE_ATTRIBUTES pair` | A `key=value` pair is missing its `=`. |
| nothing at all | Signal env unset (channel off), or `JOB_SUMMARIES=false` for job-bound channels. |

Nothing is emitted synchronously — a broken endpoint never shows up as a job
failure, only as `otlp:` lines on stderr.
