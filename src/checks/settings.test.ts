import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { loadConfig } from "../config.js";
import { TrustedCheckSettingsStore } from "./settings.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

function envConfig(values: NodeJS.ProcessEnv = {}) {
  return loadConfig(values).trustedChecks;
}

describe("TrustedCheckSettingsStore", () => {
  it("saves, validates, and clears operator-managed pinning", () => {
    const store = new TrustedCheckSettingsStore(openDb(":memory:"), envConfig());
    expect(store.status().source).toBe("none");
    expect(store.save({ repoUrl: "https://git.example.com/security/checks.git", revision: "abc" }).ok).toBe(false);
    expect(store.save({ repoUrl: "https://git.example.com/security/checks.git", revision, enabledChecks: ["secrets"] })).toEqual({ ok: true });
    const status = store.status();
    expect(status.source).toBe("stored");
    expect(status.repoUrl).toBe("https://git.example.com/security/checks.git");
    expect(status.revision).toBe(revision);
    expect(status.enabledChecks).toEqual(["secrets"]);
    expect(store.clear()).toEqual({ removed: true });
    expect(store.status().source).toBe("none");
  });

  it("rejects ambiguous or missing sources", () => {
    const store = new TrustedCheckSettingsStore(openDb(":memory:"), envConfig());
    expect(store.save({ revision, enabledChecks: ["secrets"] }).ok).toBe(false);
    expect(store.save({ repoUrl: "https://example.com/checks.git", localPath: "/opt/checks", revision }).ok).toBe(false);
    const credentialed = store.save({ repoUrl: "https://user:token@example.com/checks.git", revision });
    expect(credentialed).toEqual({ ok: false, error: "Do not embed credentials in the trusted-check repository URL." });
  });

  it("keeps a complete environment configuration authoritative over stored values", () => {
    const env = envConfig({
      MAOMAO_TRUSTED_CHECKS_PATH: "/opt/env-checks",
      MAOMAO_TRUSTED_CHECKS_REVISION: revision,
    });
    const store = new TrustedCheckSettingsStore(openDb(":memory:"), env);
    expect(store.save({ repoUrl: "https://example.com/checks.git", revision }).ok).toBe(false);
    const status = store.status();
    expect(status.source).toBe("environment");
    expect(status.localPath).toBe("/opt/env-checks");
    expect(status.enabledChecks).toEqual(["secrets", "security"]);
  });
});
