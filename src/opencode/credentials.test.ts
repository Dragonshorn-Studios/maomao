import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { opencodeAuthPath, ProviderCredentialStore } from "./credentials.js";

function tempAuth(): { path: string; store: (env?: NodeJS.ProcessEnv) => ProviderCredentialStore } {
  const dir = mkdtempSync(join(tmpdir(), "maomao-auth-"));
  mkdirSync(join(dir, "opencode"), { recursive: true });
  const path = join(dir, "opencode", "auth.json");
  return {
    path,
    store: (env: NodeJS.ProcessEnv = {}) => new ProviderCredentialStore(path, env),
  };
}

describe("opencodeAuthPath", () => {
  it("uses XDG_DATA_HOME when set, else ~/.local/share", () => {
    expect(opencodeAuthPath({ HOME: "/h", XDG_DATA_HOME: "/xdg" })).toBe("/xdg/opencode/auth.json");
    expect(opencodeAuthPath({ HOME: "/h" })).toBe("/h/.local/share/opencode/auth.json");
  });
});

describe("ProviderCredentialStore", () => {
  it("lists every known provider as unconfigured when no file exists", () => {
    const { store } = tempAuth();
    const statuses = store().list();
    expect(statuses.length).toBeGreaterThan(5);
    expect(statuses.every((status) => status.source === "none")).toBe(true);
  });

  it("writes an api entry at mode 0600 and reports it stored with a fingerprint", () => {
    const { path, store } = tempAuth();
    const result = store().set("anthropic", "sk-ant-secret-1234");
    expect(result.ok).toBe(true);
    const anthropic = store().list().find((status) => status.id === "anthropic")!;
    expect(anthropic.source).toBe("stored");
    expect(anthropic.fingerprint).toBe("1234");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, { type: string }>;
    expect(parsed.anthropic.type).toBe("api");
  });

  it("reports env-sourced providers and names the winning env var", () => {
    const { store } = tempAuth();
    const statuses = store({ ANTHROPIC_API_KEY: "sk-env" }).list();
    const anthropic = statuses.find((status) => status.id === "anthropic")!;
    expect(anthropic.source).toBe("environment");
    expect(anthropic.envVar).toBe("ANTHROPIC_API_KEY");
  });

  it("env beats stored for status display", () => {
    const { store } = tempAuth();
    store().set("anthropic", "sk-stored");
    const anthropic = store({ ANTHROPIC_API_KEY: "sk-env" }).list().find((status) => status.id === "anthropic")!;
    expect(anthropic.source).toBe("environment");
  });

  it("preserves oauth entries on write", () => {
    const { path, store } = tempAuth();
    const seed = { "github-copilot": { type: "oauth", access: "a", refresh: "r", expires: 1 } };
    writeFileSync(path, JSON.stringify(seed));
    expect(store().set("openai", "sk-oai-9999").ok).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, { type: string; access?: string }>;
    expect(parsed["github-copilot"]).toEqual(seed["github-copilot"]);
    expect(parsed.openai.type).toBe("api");
  });

  it("delete removes only the targeted entry", () => {
    const { path, store } = tempAuth();
    store().set("openai", "sk-aaaa1111");
    store().set("groq", "sk-bbbb2222");
    expect(store().delete("openai")).toEqual({ ok: true, removed: true });
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(parsed.openai).toBeUndefined();
    expect(parsed.groq).toBeDefined();
    expect(store().delete("openai")).toEqual({ ok: true, removed: false });
  });

  it("lists stored entries for providers outside the known list", () => {
    const { path, store } = tempAuth();
    const seed = { "my-custom": { type: "api", key: "key-zzzz" } };
    writeFileSync(path, JSON.stringify(seed));
    const custom = store().list().find((status) => status.id === "my-custom")!;
    expect(custom.source).toBe("stored");
    expect(custom.fingerprint).toBe("zzzz");
  });

  it("rejects empty and whitespace-bearing keys without writing", () => {
    const { path, store } = tempAuth();
    expect(store().set("openai", "   ")).toEqual({ ok: false, error: "API key is empty." });
    expect(store().set("openai", "sk with space").ok).toBe(false);
    expect(() => statSync(path)).toThrow();
  });

  it("rejects malformed provider ids", () => {
    const { store } = tempAuth();
    expect(store().set("../escape", "sk-good").ok).toBe(false);
    expect(store().set("", "sk-good").ok).toBe(false);
  });

  it("refuses to write over a corrupt auth.json", () => {
    const { path, store } = tempAuth();
    writeFileSync(path, "not json{");
    expect(store().set("openai", "sk-ok").ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("not json{");
  });

  it("storedSecrets returns key material for redaction, never fingerprints", () => {
    const { store } = tempAuth();
    store().set("openai", "sk-visible-secret");
    const secrets = store().storedSecrets();
    expect(secrets).toContain("sk-visible-secret");
  });
});
