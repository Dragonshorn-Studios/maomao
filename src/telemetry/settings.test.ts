import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  TelemetrySettingsStore,
  deriveChannelUrl,
  maskUrlCredentials,
  resolveChannelAuth,
  resolveChannelUrl,
  telemetryConfigPath,
} from "./settings.js";

function store(): { store: TelemetrySettingsStore; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "maomao-telemetry-")), "telemetry.json");
  return { store: new TelemetrySettingsStore(path), path };
}

describe("telemetryConfigPath", () => {
  it("prefers XDG_DATA_HOME, falls back to ~/.local/share", () => {
    expect(telemetryConfigPath({ XDG_DATA_HOME: "/data", HOME: "/h" })).toBe("/data/maomao/telemetry.json");
    expect(telemetryConfigPath({ HOME: "/h" })).toBe("/h/.local/share/maomao/telemetry.json");
  });
});

describe("TelemetrySettingsStore", () => {
  it("round-trips a channel config atomically at mode 0600", () => {
    const { store: s, path } = store();
    expect(s.set("traces", { url: "https://oo.test/api/default/v1/traces", token: "abc123secret" })).toEqual({ ok: true });
    expect(s.get("traces")).toEqual({ url: "https://oo.test/api/default/v1/traces", token: "abc123secret" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("abc123secret");
  });

  it("clear removes the channel and reports removed", () => {
    const { store: s } = store();
    s.set("metrics", { url: "https://oo.test/api/default/v1/metrics" });
    expect(s.clear("metrics")).toEqual({ ok: true, removed: true });
    expect(s.get("metrics")).toBeUndefined();
    expect(s.clear("metrics")).toEqual({ ok: true, removed: false });
  });

  it("rejects whitespace-bearing secrets and non-http urls", () => {
    const { store: s } = store();
    expect(s.set("traces", { token: "has space" }).ok).toBe(false);
    expect(s.set("traces", { url: "ftp://x" }).ok).toBe(false);
    expect(s.set("traces", { url: "not a url" }).ok).toBe(false);
    expect(s.get("traces")).toBeUndefined();
  });

  it("reads a malformed file as empty but refuses to overwrite it", () => {
    const { store: s, path } = store();
    writeFileSync(path, "{not json");
    expect(s.get("logs")).toBeUndefined();
    expect(s.status({}).every((c) => c.urlSource === "none")).toBe(true);
    const result = s.set("logs", { url: "https://oo.test/api/default/s/_json" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not valid JSON");
  });

  it("empty config removes the channel entry", () => {
    const { store: s, path } = store();
    s.set("logs", { url: "https://oo.test/api/default/s/_json", user: "u", password: "p" });
    expect(s.set("logs", {})).toEqual({ ok: true });
    expect(s.get("logs")).toBeUndefined();
    expect(readFileSync(path, "utf8")).not.toContain("https://oo.test");
  });

  it("storedSecrets returns stored token/user/password material only", () => {
    const { store: s } = store();
    s.set("metrics", { url: "https://oo.test/api/default/v1/metrics", user: "operator-1", password: "pw-long-enough" });
    expect(s.storedSecrets().sort()).toEqual(["operator-1", "pw-long-enough"].sort());
  });
});

describe("channel resolution", () => {
  it("env wins over stored for url and auth", () => {
    const env = { OPENOBSERVE_TRACES_URL: "https://env.test/v1/traces", OPENOBSERVE_TOKEN: "env-token" };
    const stored = { url: "https://stored.test/v1/traces", token: "stored-token" };
    expect(resolveChannelUrl("traces", env, stored)).toBe("https://env.test/v1/traces");
    expect(resolveChannelAuth("traces", env, stored)).toEqual({ token: "env-token", user: undefined, password: undefined });
  });

  it("any token wins over any user across prefixes, and password resolves independently", () => {
    // OPENOBSERVE_TRACES_USER + generic OPENOBSERVE_TOKEN must still pick
    // Bearer — the precedence the exporter documented before stored settings.
    const env = { OPENOBSERVE_TRACES_USER: "u", OPENOBSERVE_TOKEN: "tok" };
    expect(resolveChannelAuth("traces", env)).toEqual({ token: "tok", user: undefined, password: undefined });
    const env2 = { OPENOBSERVE_METRICS_PASSWORD: "per-pw", OPENOBSERVE_USER: "gen-u", OPENOBSERVE_PASSWORD: "gen-pw" };
    expect(resolveChannelAuth("metrics", env2)).toEqual({ token: undefined, user: "gen-u", password: "per-pw" });
  });

  it("generic OPENOBSERVE_* auth falls back for otlp signals but not logs", () => {
    const env = { OPENOBSERVE_USER: "u", OPENOBSERVE_PASSWORD: "p" };
    expect(resolveChannelAuth("metrics", env).user).toBe("u");
    expect(resolveChannelAuth("logs", env)).toEqual({ token: undefined, user: undefined, password: undefined });
    // Stored creds fill the gap for logs when no per-signal env exists.
    expect(resolveChannelAuth("logs", env, { user: "su", password: "sp" }).user).toBe("su");
  });

  it("status reports per-field sources and fingerprints stored auth", () => {
    const { store: s } = store();
    s.set("logs", { url: "https://oo.test/api/default/s/_json", token: "tok-1234abcd" });
    const statuses = s.status({ OPENOBSERVE_LOGS_TOKEN: "envtok" });
    const logs = statuses.find((c) => c.channel === "logs")!;
    expect(logs.urlSource).toBe("stored");
    expect(logs.url).toBe("https://oo.test/api/default/s/_json");
    // env auth wins over stored; detail shows the env var name.
    expect(logs.authSource).toBe("environment");
    expect(logs.authEnvVar).toBe("OPENOBSERVE_LOGS_TOKEN");
    const traces = statuses.find((c) => c.channel === "traces")!;
    expect(traces.urlSource).toBe("none");
    expect(traces.authSource).toBe("none");
  });

  it("status shows stored auth fingerprint without exposing the secret", () => {
    const { store: s } = store();
    s.set("metrics", { url: "https://oo.test/m", token: "secret-token-9999" });
    const metrics = s.status({}).find((c) => c.channel === "metrics")!;
    expect(metrics.authSource).toBe("stored");
    expect(metrics.authDetail).toBe("…9999");
    expect(JSON.stringify(metrics)).not.toContain("secret-token-9999");
  });
});

describe("shared connection", () => {
  it("deriveChannelUrl builds channel endpoints from a base", () => {
    const base = "https://oo.test/api/default/";
    expect(deriveChannelUrl("traces", base)).toBe("https://oo.test/api/default/v1/traces");
    expect(deriveChannelUrl("metrics", base)).toBe("https://oo.test/api/default/v1/metrics");
    expect(deriveChannelUrl("logs", base, "job_summaries")).toBe("https://oo.test/api/default/job_summaries/_json");
    expect(deriveChannelUrl("logs", base)).toBeUndefined();
    expect(deriveChannelUrl("traces", undefined)).toBeUndefined();
  });

  it("setShared/clearShared round-trips and validates the stream name", () => {
    const { store: s, path } = store();
    expect(
      s.setShared({ baseUrl: "https://oo.test/api/default", stream: "job_summaries", token: "shared-tok-9" }),
    ).toEqual({ ok: true });
    expect(s.shared()).toEqual({ baseUrl: "https://oo.test/api/default", stream: "job_summaries", token: "shared-tok-9" });
    expect(s.setShared({ stream: "bad/name" }).ok).toBe(false);
    expect(s.setShared({ baseUrl: "ftp://x" }).ok).toBe(false);
    expect(s.clearShared()).toEqual({ ok: true, removed: true });
    expect(readFileSync(path, "utf8")).not.toContain("shared-tok-9");
    expect(s.clearShared()).toEqual({ ok: true, removed: false });
  });

  it("env base derives channel urls; per-channel env wins; stored base fills the gap", () => {
    const env = { OPENOBSERVE_BASE_URL: "https://env-oo.test/api/default", OPENOBSERVE_LOGS_STREAM: "summaries" };
    expect(resolveChannelUrl("traces", env)).toBe("https://env-oo.test/api/default/v1/traces");
    expect(resolveChannelUrl("logs", env)).toBe("https://env-oo.test/api/default/summaries/_json");
    const withOverride = { ...env, OPENOBSERVE_METRICS_URL: "https://explicit.test/v1/metrics" };
    expect(resolveChannelUrl("metrics", withOverride)).toBe("https://explicit.test/v1/metrics");
    // Stored channel url wins over the stored shared base; stored base is the last resort.
    const storedShared = { baseUrl: "https://stored-oo.test/api/default", stream: "s" };
    expect(resolveChannelUrl("traces", {}, { url: "https://chan.test/v1/traces" }, storedShared)).toBe("https://chan.test/v1/traces");
    expect(resolveChannelUrl("traces", {}, undefined, storedShared)).toBe("https://stored-oo.test/api/default/v1/traces");
  });

  it("shared stored auth fills the gap — including logs, which has no generic env", () => {
    const shared = { token: "shared-token-1234" };
    expect(resolveChannelAuth("traces", {}, undefined, shared)).toEqual({ token: "shared-token-1234", user: undefined, password: undefined });
    expect(resolveChannelAuth("logs", {}, undefined, shared).token).toBe("shared-token-1234");
    // Per-channel stored creds beat shared stored creds.
    expect(resolveChannelAuth("metrics", {}, { user: "mu", password: "mp" }, shared)).toEqual({
      token: undefined,
      user: "mu",
      password: "mp",
    });
  });

  it("status marks shared-derived urls and auth", () => {
    const { store: s } = store();
    s.setShared({ baseUrl: "https://oo.test/api/default", stream: "summaries", token: "shared-tok-9999" });
    const statuses = s.status({});
    const traces = statuses.find((c) => c.channel === "traces")!;
    expect(traces.url).toBe("https://oo.test/api/default/v1/traces");
    expect(traces.urlSource).toBe("stored");
    expect(traces.urlShared).toBe(true);
    expect(traces.authShared).toBe(true);
    expect(traces.authDetail).toBe("…9999");
    const logs = statuses.find((c) => c.channel === "logs")!;
    expect(logs.url).toBe("https://oo.test/api/default/summaries/_json");
    const sharedStatus = s.sharedStatus({});
    expect(sharedStatus.baseUrlSource).toBe("stored");
    expect(sharedStatus.stream).toBe("summaries");
    expect(sharedStatus.authSource).toBe("stored");
    expect(sharedStatus.hasStored).toBe(true);
  });
});

describe("maskUrlCredentials", () => {
  it("strips userinfo from a parseable url", () => {
    expect(maskUrlCredentials("https://user:pw@oo.test/api/default/v1/traces")).toBe("https://oo.test/api/default/v1/traces");
  });
  it("masks userinfo in an unparseable url", () => {
    expect(maskUrlCredentials("https://user:pw@oo test bad")).toBe("https://<credentials>@oo test bad");
  });
});
