import { ingestHeaders, postIngestLine, warnInsecureIngest } from "./ingest.js";
import {
  resolveChannelUrl,
  type TelemetryChannelConfig,
  type TelemetrySharedConfig,
} from "./settings.js";

/**
 * maomao's own operational log stream: one structured JSON line on stdout
 * plus an optional OpenObserve `_json` POST — same dual-channel shape as
 * the terminal job summary. Event names are `maomao.<name>`; payloads are
 * operational metadata only — never secrets, webhook URLs, diffs, review
 * bodies, or the ingest credentials themselves.
 *
 * Deliberately does not depend on the OTLP modules: when the log channel
 * itself is what a user is debugging, this stream still lands on stdout.
 */

let appLogSink: (line: string) => void = (line) => process.stdout.write(`${line}\n`);

/** Test hook: swap the stdout sink; returns the previous one for restoration. */
export function setAppLogSink(sink: (line: string) => void): (line: string) => void {
  const previous = appLogSink;
  appLogSink = sink;
  return previous;
}

export interface AppLogFields {
  level?: "info" | "warn" | "error";
  [key: string]: unknown;
}

/**
 * Emit one `maomao.<event>` line: stdout always, the OpenObserve POST only
 * when the logs channel resolves (env > stored > derived-from-shared).
 * `logsStored` is the logs channel's stored config — callers holding a
 * different channel's config must not pass it here.
 * Never throws — a broken ingest endpoint must not break the caller.
 */
export function emitAppLog(
  event: string,
  fields: AppLogFields = {},
  env: NodeJS.ProcessEnv = process.env,
  logsStored?: TelemetryChannelConfig,
  shared?: TelemetrySharedConfig,
): void {
  try {
    const line = JSON.stringify(appLogPayload(event, fields));
    try {
      appLogSink(line);
    } catch (error) {
      console.error(
        `app-log: stdout write failed for ${event}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const url = resolveChannelUrl("logs", env, logsStored, shared);
    if (!url) return;
    const headers = ingestHeaders(env, logsStored, shared);
    warnInsecureIngest(url, headers);
    postIngestLine(url, headers, line, `event ${event}`, "app-log");
  } catch (error) {
    console.error(
      `app-log: emission failed for ${event}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function appLogPayload(event: string, fields: AppLogFields = {}): Record<string, unknown> {
  return { event: `maomao.${event}`, _timestamp: new Date().toISOString(), ...fields };
}
