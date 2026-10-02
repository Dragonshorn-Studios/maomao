import {
  resolveChannelAuth,
  telemetryAuthHeader,
  type TelemetryChannelConfig,
  type TelemetrySharedConfig,
} from "./settings.js";

/**
 * Shared transport for log-style JSON lines into OpenObserve's `_json`
 * ingest: job summaries (jobs/summary.ts) and app-log events
 * (telemetry/app-log.ts) both post through here so serialization, the
 * backlog cap, the 10s bound, and error redaction apply to one queue.
 */

// POSTs are serialized so a bulk terminal sweep (e.g. the global-pause
// cancel flipping hundreds of jobs at once) cannot fan out one unbounded
// socket per event — at most one request is in flight at a time.
let postChain: Promise<void> = Promise.resolve();

// Depth cap: serialization bounds concurrency, not backlog — a bulk sweep
// enqueueing hundreds of lines against an endpoint stalling near the 10s
// timeout would otherwise delay delivery for tens of minutes. The stdout
// line is the durable copy, so overflow drops and logs instead of growing
// the queue without bound.
const MAX_PENDING_INGEST_POSTS = 256;
let pendingIngestPosts = 0;

// Warn once per distinct URL: ingest credentials over plain http travel in
// cleartext — a scheme typo must not silently downgrade transport security.
const insecureIngestWarned = new Set<string>();

export function warnInsecureIngest(url: string, headers: Record<string, string>): void {
  if (headers.authorization && url.startsWith("http://") && !insecureIngestWarned.has(url)) {
    insecureIngestWarned.add(url);
    console.error("log-ingest: endpoint uses http — credentials are sent in cleartext");
  }
}

function redactIngestError(message: string, url: string): string {
  let safe = message.split(url).join("<openobserve-url>");
  try {
    const parsed = new URL(url);
    // Fetch errors can echo the normalized href (lowercased host, added
    // trailing slash) rather than the verbatim configured string.
    if (parsed.href !== url) safe = safe.split(parsed.href).join("<openobserve-url>");
    if (parsed.username || parsed.password) {
      // Userinfo embedded in the URL survives normalization — strip any
      // //user:pass@ remnant wherever it appears in the message.
      safe = safe.replace(/\/\/[^/\s]+@/g, "//<credentials>@");
    }
  } catch {
    // Unparseable configured URL — the exact-string pass above is all we can do.
  }
  return safe;
}

export function ingestHeaders(
  env: NodeJS.ProcessEnv,
  stored?: TelemetryChannelConfig,
  shared?: TelemetrySharedConfig,
): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  return { ...headers, ...telemetryAuthHeader(resolveChannelAuth("logs", env, stored, shared)) };
}

/**
 * Queue one `_json` POST. `ref` and `label` only shape the stderr messages:
 * `label: OpenObserve POST for ref returned 500`. Never throws and never
 * leaks the URL or its embedded credentials into errors.
 */
export function postIngestLine(
  url: string,
  headers: Record<string, string>,
  line: string,
  ref: string,
  label: string,
): void {
  if (pendingIngestPosts >= MAX_PENDING_INGEST_POSTS) {
    console.error(`${label}: dropping OpenObserve POST for ${ref}: ingest queue full`);
    return;
  }
  pendingIngestPosts += 1;
  postChain = postChain.then(async () => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        // _json's documented contract is a JSON array of records — wrapping
        // even for single-line posts so strict deployments don't reject it.
        body: `[${line}]`,
        // Bounded so a hung ingest endpoint cannot linger forever; there is no
        // retry — the stdout line remains the durable copy.
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        console.error(`${label}: OpenObserve POST for ${ref} returned ${response.status}`);
      }
    } catch (error) {
      // URL parse/construction errors echo the request URL — strip it (and
      // any normalized form/userinfo) so credentials embedded in the URL
      // never reach stderr.
      const raw = error instanceof Error ? error.message : String(error);
      console.error(`${label}: OpenObserve POST failed for ${ref}: ${redactIngestError(raw, url)}`);
    } finally {
      pendingIngestPosts -= 1;
    }
    // Self-healing chain: a rejection escaping the task (e.g. console.error
    // throwing inside the handler) must not leave postChain rejected —
    // that would skip every later task while their counter increments
    // still stand, silently wedging all future POSTs at the depth cap.
  }).catch(() => {});
}

/** Test hook: resolves once every queued ingest POST has settled. */
export function flushIngestPosts(): Promise<void> {
  return postChain;
}
