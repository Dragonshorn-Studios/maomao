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

export type TelemetrySource = "environment" | "stored" | "none";

export interface TelemetryChannelStatus {
  channel: TelemetryChannel;
  /** Effective URL, credentials masked — safe to render. */
  url?: string;
  urlSource: TelemetrySource;
  /** Which env var(s) feed the URL when urlSource === "environment". */
  urlEnvVar?: string;
  authSource: TelemetrySource;
  /** Env var name or last-4 fingerprint describing the auth in force. */
  authDetail?: string;
  /** Env var feeding auth when authSource === "environment". */
  authEnvVar?: string;
  /** A stored entry exists for this channel — may be fully shadowed by env. */
  hasStored: boolean;
}

type TelemetryFile = Partial<Record<TelemetryChannel, TelemetryChannelConfig>>;

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

  /** Effective per-channel status for the page: env wins, stored fills gaps. */
  status(env: NodeJS.ProcessEnv = process.env): TelemetryChannelStatus[] {
    const file = readSettingsFile(this.path);
    return TELEMETRY_CHANNELS.map(({ id }) => {
      const stored = file[id];
      const envVar = urlEnvVars(id).find((name) => Boolean(env[name]?.trim()));
      const storedUrl = typeof stored?.url === "string" && stored.url ? stored.url : undefined;
      const envAuthVar = envAuthVars(id, env);
      const storedAuth = stored && (stored.token || stored.user) ? "stored" : null;
      return {
        channel: id,
        hasStored: stored != null && Boolean(stored.url || stored.token || stored.user || stored.password),
        url: envVar ? maskUrlCredentials(env[envVar]!.trim()) : storedUrl ? maskUrlCredentials(storedUrl) : undefined,
        urlSource: envVar ? "environment" : storedUrl ? "stored" : "none",
        urlEnvVar: envVar,
        authSource: envAuthVar ? "environment" : storedAuth ?? "none",
        authEnvVar: envAuthVar ?? undefined,
        authDetail: envAuthVar ?? (storedAuth ? fingerprint(stored!.token ?? stored!.user ?? "") : undefined),
      };
    });
  }

  /**
   * Replace a channel's stored config. Empty fields delete the key; a fully
   * empty config removes the channel entry. Secrets are validated to the
   * same bar as provider keys (non-empty, no whitespace).
   */
  set(channel: TelemetryChannel, config: TelemetryChannelConfig): { ok: true } | { ok: false; error: string } {
    if (!TELEMETRY_CHANNELS.some((c) => c.id === channel)) return { ok: false, error: `Unknown channel ${channel}.` };
    const url = config.url?.trim();
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return { ok: false, error: "Endpoint URL must be http(s)." };
        }
      } catch {
        return { ok: false, error: "Endpoint URL is not a valid URL." };
      }
    }
    for (const key of ["token", "user", "password"] as const) {
      const value = config[key];
      if (value != null && value !== "" && /[\x00-\x1f\x7f\s]/.test(value)) {
        return { ok: false, error: `${key} must not contain whitespace or control characters.` };
      }
    }
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

  clear(channel: TelemetryChannel): { ok: true; removed: boolean } | { ok: false; error: string } {
    if (!fileIsParseable(this.path)) {
      return { ok: false, error: `${this.path} is not valid JSON — refusing to rewrite it. Fix or remove it first.` };
    }
    const file = readSettingsFile(this.path);
    const removed = channel in file;
    if (removed) {
      delete file[channel];
      this.write(file);
    }
    return { ok: true, removed };
  }

  /** Stored secret material for redaction lists — never logged or rendered. */
  storedSecrets(): string[] {
    const file = readSettingsFile(this.path);
    const secrets: string[] = [];
    for (const channel of Object.values(file)) {
      for (const value of [channel?.token, channel?.user, channel?.password]) {
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

/**
 * Effective auth for one channel: env wins (per-signal then generic for
 * OTLP), stored fills the gap. Returned in the shape authHeaders() builds
 * headers from.
 */
export function resolveChannelAuth(
  channel: TelemetryChannel,
  env: NodeJS.ProcessEnv = process.env,
  stored?: TelemetryChannelConfig,
): { token?: string; user?: string; password?: string } {
  const envResult = envAuth(channel, env);
  if (envResult) return { token: envResult.token, user: envResult.user, password: envResult.password };
  return { token: stored?.token, user: stored?.user, password: stored?.password };
}

/** Effective URL for one channel: env wins over stored. */
export function resolveChannelUrl(
  channel: TelemetryChannel,
  env: NodeJS.ProcessEnv = process.env,
  stored?: TelemetryChannelConfig,
): string | undefined {
  for (const name of urlEnvVars(channel)) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return stored?.url?.trim() || undefined;
}
