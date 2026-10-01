import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  TelemetrySettingsStore,
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

describe("maskUrlCredentials", () => {
  it("strips userinfo from a parseable url", () => {
    expect(maskUrlCredentials("https://user:pw@oo.test/api/default/v1/traces")).toBe("https://oo.test/api/default/v1/traces");
  });
  it("masks userinfo in an unparseable url", () => {
    expect(maskUrlCredentials("https://user:pw@oo test bad")).toBe("https://<credentials>@oo test bad");
  });
});
