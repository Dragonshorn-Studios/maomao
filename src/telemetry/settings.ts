import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

/**
 * Operator-managed OpenObserve settings for /config/telemetry: per-channel
 * endpoint URL + credentials, persisted to a JSON file so a working
 * connection survives restarts without going through process env. The
 * security model mirrors ProviderCredentialStore (opencode/credentials.ts):
 * secrets are write-only (the page shows a last-4 fingerprint), the file is
 * an atomic temp+rename write at mode 0600, and a malformed file is treated
 * as empty for reads but refuses writes rather than being clobbered.
 *
 * Most deployments share one OpenObserve org and one credential across all
 * three channels, so there is also a "shared" layer: a base URL like
 * https://oo.example.com/api/<org> from which channel endpoints are derived
 * (…/v1/traces, …/v1/metrics, …/<stream>/_json) plus shared credentials.
 * Per-channel settings stay as overrides.
 *
 * Resolution is env-over-stored per field: an env var always wins over the
 * stored value, so `.env` stays authoritative and the page's "source" badge
 * tells the operator which layer is feeding each channel. The logs channel
 * predates the generic env names — its env set is OPENOBSERVE_LOGS_* only,
 * while traces/metrics fall back to the generic OPENOBSERVE_* names
 * (see otlp.ts authHeaders).
 */

export type TelemetryChannel = "traces" | "metrics" | "logs";

export const TELEMETRY_CHANNELS: ReadonlyArray<{ id: TelemetryChannel; label: string; detail: string }> = [
  { id: "traces", label: "Traces (OTLP)", detail: "one span tree per terminal job run" },
  { id: "metrics", label: "Metrics (OTLP)", detail: "queue gauges + terminal-job counters" },
  { id: "logs", label: "Job summaries", detail: "one JSON line per terminal transition" },
];

export interface TelemetryChannelConfig {
  url?: string;
  token?: string;
  user?: string;
  password?: string;
}

/**
 * Shared OpenObserve connection: a base URL of the form
 * https://<host>/api/<org> plus optional credentials, from which per-channel
 * endpoints are derived when the channel has no explicit URL. `stream` is
 * the logs stream name — the logs endpoint needs it while the OTLP channels
 * don't.
 */
export interface TelemetrySharedConfig {
  baseUrl?: string;
  stream?: string;
  token?: string;
  user?: string;
  password?: string;
}

export type TelemetrySource = "environment" | "stored" | "none";

export interface TelemetryChannelStatus {
  channel: TelemetryChannel;
  /** Effective URL, credentials masked — safe to render. */
  url?: string;
  urlSource: TelemetrySource;
  /** Which env var(s) feed the URL when urlSource === "environment". */
  urlEnvVar?: string;
  /** The effective URL is derived from a shared base rather than set per channel. */
  urlShared: boolean;
  authSource: TelemetrySource;
  /** Env var name or last-4 fingerprint describing the auth in force. */
  authDetail?: string;
  /** Env var feeding auth when authSource === "environment". */
  authEnvVar?: string;
  /** The effective auth comes from the shared credentials, not this channel. */
  authShared: boolean;
  /** A stored entry exists for this channel — may be fully shadowed by env. */
  hasStored: boolean;
}

/** Status of the shared connection section shown at the top of the page. */
export interface TelemetrySharedStatus {
  baseUrl?: string;
  baseUrlSource: TelemetrySource;
  baseUrlEnvVar?: string;
  stream?: string;
  streamSource: TelemetrySource;
  streamEnvVar?: string;
  authSource: TelemetrySource;
  authDetail?: string;
  authEnvVar?: string;
  hasStored: boolean;
}

type TelemetryFile = Partial<Record<TelemetryChannel, TelemetryChannelConfig>> & {
  shared?: TelemetrySharedConfig;
};

/** Env name for the shared base URL; OPENOBSERVE_LOGS_STREAM names the logs stream. */
const SHARED_BASE_URL_ENV = "OPENOBSERVE_BASE_URL";
const SHARED_STREAM_ENV = "OPENOBSERVE_LOGS_STREAM";

/**
 * Derive a channel endpoint from a shared base (`https://host/api/<org>`):
 * OTLP signals get `/v1/<signal>`; logs gets `/<stream>/_json` and needs a
 * stream name — without one the logs channel cannot be derived.
 */
export function deriveChannelUrl(
  channel: TelemetryChannel,
  baseUrl: string | undefined,
  stream?: string,
): string | undefined {
  const base = baseUrl?.trim().split(/[?#]/)[0].replace(/\/+$/, "");
  if (!base) return undefined;
  if (channel === "logs") {
    const name = stream?.trim();
    return name ? `${base}/${encodeURIComponent(name)}/_json` : undefined;
  }
  return `${base}/v1/${channel}`;
}

export function telemetryConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.XDG_DATA_HOME?.trim();
  const home = env.HOME?.trim() || homedir();
  return dataHome ? join(dataHome, "maomao", "telemetry.json") : join(home, ".local", "share", "maomao", "telemetry.json");
}

function readSettingsFile(path: string): TelemetryFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as TelemetryFile;
  } catch {
    return {};
  }
}

function fileIsParseable(path: string): boolean {
  try {
    readFileSync(path, "utf8");
  } catch {
    return true; // absent file — a write creates it
  }
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return true;
  } catch {
    return false;
  }
}

function fingerprint(secret: string): string {
  return secret.length >= 4 ? `…${secret.slice(-4)}` : "";
}

/** Env names feeding one channel's URL; the first non-empty wins. */
function urlEnvVars(channel: TelemetryChannel): string[] {
  return channel === "logs" ? ["OPENOBSERVE_LOGS_URL"] : [`OPENOBSERVE_${channel.toUpperCase()}_URL`];
}

/**
 * Env auth for one channel — the same precedence the OTLP exporter used
 * before stored settings existed: any TOKEN (per-signal then generic) wins,
 * then any USER; password resolves across both prefixes independently.
 * Traces/metrics fall back to the generic OPENOBSERVE_* names; logs has no
 * generic fallback.
 */
function envAuth(
  channel: TelemetryChannel,
  env: NodeJS.ProcessEnv,
): { token?: string; user?: string; password?: string; envVar: string } | null {
  const prefix = `OPENOBSERVE_${channel.toUpperCase()}`;
  const names = channel === "logs" ? [prefix] : [prefix, "OPENOBSERVE"];
  const firstSet = (suffix: string): { value: string; envVar: string } | null => {
    for (const name of names) {
      const value = env[`${name}_${suffix}`]?.trim();
      if (value) return { value, envVar: `${name}_${suffix}` };
    }
    return null;
  };
  const token = firstSet("TOKEN");
  if (token) return { token: token.value, envVar: token.envVar };
  const user = firstSet("USER");
  if (user) return { user: user.value, password: firstSet("PASSWORD")?.value ?? "", envVar: user.envVar };
  return null;
}

/** Strip any userinfo so a pasted `https://user:pass@host/…` never renders. */
export function maskUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.href;
  } catch {
    return url.replace(/\/\/[^/@\s]+@/, "//<credentials>@");
  }
}

export class TelemetrySettingsStore {
  constructor(private readonly path: string) {}

  /** Stored config for one channel, or undefined when nothing is saved. */
  get(channel: TelemetryChannel): TelemetryChannelConfig | undefined {
    const raw = readSettingsFile(this.path)[channel];
    if (!raw || typeof raw !== "object") return undefined;
    const clean: TelemetryChannelConfig = {};
    for (const key of ["url", "token", "user", "password"] as const) {
      const value = raw[key];
      if (typeof value === "string" && value) clean[key] = value;
    }
    return Object.keys(clean).length ? clean : undefined;
  }

  /** Stored shared connection, or undefined when nothing is saved. */
  shared(): TelemetrySharedConfig | undefined {
    const raw = readSettingsFile(this.path).shared;
    if (!raw || typeof raw !== "object") return undefined;
    const clean: TelemetrySharedConfig = {};
    for (const key of ["baseUrl", "stream", "token", "user", "password"] as const) {
      const value = raw[key];
      if (typeof value === "string" && value) clean[key] = value;
    }
    return Object.keys(clean).length ? clean : undefined;
  }

  /** Effective per-channel status for the page: env wins, stored fills gaps. */
  status(env: NodeJS.ProcessEnv = process.env): TelemetryChannelStatus[] {
    const file = readSettingsFile(this.path);
    const shared = file.shared;
    return TELEMETRY_CHANNELS.map(({ id }) => {
      const stored = file[id];
      const envVar = urlEnvVars(id).find((name) => Boolean(env[name]?.trim()));
      const envDerived = envVar ? undefined : deriveChannelUrl(id, env[SHARED_BASE_URL_ENV], env[SHARED_STREAM_ENV]);
      const storedUrl = typeof stored?.url === "string" && stored.url ? stored.url : undefined;
      const storedDerived = envVar || envDerived || storedUrl
        ? undefined
        : deriveChannelUrl(id, shared?.baseUrl, shared?.stream);
      const url = envVar
        ? env[envVar]!.trim()
        : envDerived ?? storedUrl ?? storedDerived;
      const envAuthVar = envAuthVars(id, env);
      const channelAuth = Boolean(stored && (stored.token || stored.user));
      const sharedAuth = Boolean(shared && (shared.token || shared.user));
      const storedAuthSource = channelAuth || sharedAuth ? "stored" : null;
      const authShared = !envAuthVar && !channelAuth && sharedAuth;
      return {
        channel: id,
        hasStored: stored != null && Boolean(stored.url || stored.token || stored.user || stored.password),
        url: url ? maskUrlCredentials(url) : undefined,
        urlSource: envVar || envDerived ? "environment" : storedUrl || storedDerived ? "stored" : "none",
        urlEnvVar: envVar ?? (envDerived ? SHARED_BASE_URL_ENV : undefined),
        urlShared: !envVar && Boolean(envDerived || storedDerived),
        authSource: envAuthVar ? "environment" : storedAuthSource ?? "none",
        authEnvVar: envAuthVar ?? undefined,
        authShared,
        authDetail:
          envAuthVar ??
          (storedAuthSource
            ? fingerprint(channelAuth ? (stored!.token ?? stored!.user ?? "") : (shared!.token ?? shared!.user ?? ""))
            : undefined),
      };
    });
  }

  /** Effective status of the shared connection card. */
  sharedStatus(env: NodeJS.ProcessEnv = process.env): TelemetrySharedStatus {
    const shared = readSettingsFile(this.path).shared;
    const envBase = env[SHARED_BASE_URL_ENV]?.trim();
    const envStream = env[SHARED_STREAM_ENV]?.trim();
    const storedBase = typeof shared?.baseUrl === "string" && shared.baseUrl.trim() ? shared.baseUrl.trim() : undefined;
    const storedStream = typeof shared?.stream === "string" && shared.stream.trim() ? shared.stream.trim() : undefined;
    const envAuthVar = env.OPENOBSERVE_TOKEN?.trim()
      ? "OPENOBSERVE_TOKEN"
      : env.OPENOBSERVE_USER?.trim()
        ? "OPENOBSERVE_USER"
        : null;
    const storedAuth = Boolean(shared && (shared.token || shared.user));
    return {
      baseUrl: envBase ? maskUrlCredentials(envBase) : storedBase ? maskUrlCredentials(storedBase) : undefined,
      baseUrlSource: envBase ? "environment" : storedBase ? "stored" : "none",
      baseUrlEnvVar: envBase ? SHARED_BASE_URL_ENV : undefined,
      stream: envStream ?? storedStream,
      streamSource: envStream ? "environment" : storedStream ? "stored" : "none",
      streamEnvVar: envStream ? SHARED_STREAM_ENV : undefined,
      authSource: envAuthVar ? "environment" : storedAuth ? "stored" : "none",
      authEnvVar: envAuthVar ?? undefined,
      authDetail: envAuthVar ?? (storedAuth ? fingerprint(shared!.token ?? shared!.user ?? "") : undefined),
      hasStored: Boolean(
        shared && (shared.baseUrl || shared.stream || shared.token || shared.user || shared.password),
      ),
    };
  }

  /**
   * Replace a channel's stored config. Empty fields delete the key; a fully
   * empty config removes the channel entry. Secrets are validated to the
   * same bar as provider keys (non-empty, no whitespace).
   */
  set(channel: TelemetryChannel, config: TelemetryChannelConfig): { ok: true } | { ok: false; error: string } {
    if (!TELEMETRY_CHANNELS.some((c) => c.id === channel)) return { ok: false, error: `Unknown channel ${channel}.` };
    const urlError = validateUrl(config.url, "Endpoint URL");
    if (urlError) return { ok: false, error: urlError };
    const secretError = validateSecrets(config);
    if (secretError) return { ok: false, error: secretError };
    if (!fileIsParseable(this.path)) {
      return { ok: false, error: `${this.path} is not valid JSON — refusing to overwrite it. Fix or remove it first.` };
    }
    const file = readSettingsFile(this.path);
    const next: TelemetryChannelConfig = {};
    for (const key of ["url", "token", "user", "password"] as const) {
      const value = config[key]?.trim();
      if (value) next[key] = value;
    }
    if (Object.keys(next).length) file[channel] = next;
    else delete file[channel];
    this.write(file);
    return { ok: true };
  }

  /** Replace the shared connection; empty fields delete the key, fully empty removes the entry. */
  setShared(config: TelemetrySharedConfig): { ok: true } | { ok: false; error: string } {
    const urlError = validateUrl(config.baseUrl, "Base URL");
    if (urlError) return { ok: false, error: urlError };
    const stream = config.stream?.trim();
    if (stream && /[\x00-\x1f\x7f\s/?#]/.test(stream)) {
      return { ok: false, error: "Logs stream must be a plain stream name — no whitespace, slashes, or query characters." };
    }
    const secretError = validateSecrets(config);
    if (secretError) return { ok: false, error: secretError };
    if (!fileIsParseable(this.path)) {
      return { ok: false, error: `${this.path} is not valid JSON — refusing to overwrite it. Fix or remove it first.` };
    }
    const file = readSettingsFile(this.path);
    const next: TelemetrySharedConfig = {};
    for (const key of ["baseUrl", "stream", "token", "user", "password"] as const) {
      const value = config[key]?.trim();
      if (value) next[key] = value;
    }
    if (Object.keys(next).length) file.shared = next;
    else delete file.shared;
    this.write(file);
    return { ok: true };
  }

  clear(channel: TelemetryChannel): { ok: true; removed: boolean } | { ok: false; error: string } {
    return this.clearKey(channel);
  }

  clearShared(): { ok: true; removed: boolean } | { ok: false; error: string } {
    return this.clearKey("shared");
  }

  private clearKey(key: TelemetryChannel | "shared"): { ok: true; removed: boolean } | { ok: false; error: string } {
    if (!fileIsParseable(this.path)) {
      return { ok: false, error: `${this.path} is not valid JSON — refusing to rewrite it. Fix or remove it first.` };
    }
    const file = readSettingsFile(this.path);
    const removed = key in file;
    if (removed) {
      delete file[key];
      this.write(file);
    }
    return { ok: true, removed };
  }

  /** Stored secret material for redaction lists — never logged or rendered. */
  storedSecrets(): string[] {
    const file = readSettingsFile(this.path);
    const secrets: string[] = [];
    for (const entry of Object.values(file)) {
      for (const value of [entry?.token, entry?.user, entry?.password]) {
        if (typeof value === "string" && value.length >= 8) secrets.push(value);
      }
    }
    return secrets;
  }

  private write(file: TelemetryFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${createHash("sha1").update(String(Date.now())).digest("hex").slice(0, 8)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }
}

/** env var name feeding auth when env provides it (for source badges). */
function envAuthVars(channel: TelemetryChannel, env: NodeJS.ProcessEnv): string | null {
  return envAuth(channel, env)?.envVar ?? null;
}

function validateUrl(url: string | undefined, label: string): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return `${label} must be http(s).`;
  } catch {
    return `${label} is not a valid URL.`;
  }
  return null;
}

function validateSecrets(config: { token?: string; user?: string; password?: string }): string | null {
  for (const key of ["token", "user", "password"] as const) {
    const value = config[key];
    if (value != null && value !== "" && /[\x00-\x1f\x7f\s]/.test(value)) {
      return `${key} must not contain whitespace or control characters.`;
    }
  }
  return null;
}

/**
 * Effective auth for one channel: env wins (per-signal then generic for
 * OTLP), then the channel's stored credentials, then the shared stored
 * credentials. Returned in the shape authHeaders() builds headers from.
 */
export function resolveChannelAuth(
  channel: TelemetryChannel,
  env: NodeJS.ProcessEnv = process.env,
  stored?: TelemetryChannelConfig,
  shared?: TelemetrySharedConfig,
): { token?: string; user?: string; password?: string } {
  const envResult = envAuth(channel, env);
  if (envResult) return { token: envResult.token, user: envResult.user, password: envResult.password };
  const pick = (c?: { token?: string; user?: string; password?: string }) =>
    c && (c.token || c.user) ? { token: c.token, user: c.user, password: c.password } : undefined;
  return pick(stored) ?? pick(shared) ?? {};
}

/**
 * Effective URL for one channel: the channel's env var wins, then a URL
 * derived from the env base (OPENOBSERVE_BASE_URL), then the channel's
 * stored URL, then a URL derived from the stored shared base.
 */
export function resolveChannelUrl(
  channel: TelemetryChannel,
  env: NodeJS.ProcessEnv = process.env,
  stored?: TelemetryChannelConfig,
  shared?: TelemetrySharedConfig,
): string | undefined {
  for (const name of urlEnvVars(channel)) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  const envDerived = deriveChannelUrl(channel, env[SHARED_BASE_URL_ENV], env[SHARED_STREAM_ENV]);
  if (envDerived) return envDerived;
  const storedUrl = stored?.url?.trim();
  if (storedUrl) return storedUrl;
  return deriveChannelUrl(channel, shared?.baseUrl, shared?.stream);
}
