import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import {
  authorizationLogLine,
  authorizeGithubTarget,
  logAuthorizationRejection,
} from "./authorize.js";

function config(env: Record<string, string> = {}) {
  return loadConfig({ REVIEWER_ROLES: "correctness", ...env });
}

describe("authorizeGithubTarget", () => {
  it("allows any subject when both allowlists are empty", () => {
    expect(
      authorizeGithubTarget(config(), { installationId: 1, accountId: 99, repositoryId: 7 }),
    ).toEqual({ ok: true });
    expect(authorizeGithubTarget(config(), {})).toEqual({ ok: true });
  });

  it("restricts by numeric account id and fails closed when the id is missing", () => {
    const cfg = config({ ALLOWED_GITHUB_ACCOUNT_IDS: "100, 200" });
    expect(authorizeGithubTarget(cfg, { installationId: 1, accountId: 200, repositoryId: 3 })).toEqual({
      ok: true,
    });
    expect(authorizeGithubTarget(cfg, { installationId: 1, accountId: 1, repositoryId: 3 })).toEqual({
      ok: false,
      reason: "unauthorized account",
    });
    expect(authorizeGithubTarget(cfg, { installationId: 1, repositoryId: 3 })).toEqual({
      ok: false,
      reason: "missing account id",
    });
  });

  it("restricts by numeric repository id independently of names", () => {
    const cfg = config({ ALLOWED_GITHUB_REPOSITORY_IDS: "555" });
    expect(authorizeGithubTarget(cfg, { installationId: 9, accountId: 1, repositoryId: 555 })).toEqual({
      ok: true,
    });
    expect(authorizeGithubTarget(cfg, { installationId: 9, accountId: 1, repositoryId: 1 })).toEqual({
      ok: false,
      reason: "unauthorized repository",
    });
    expect(authorizeGithubTarget(cfg, { installationId: 9, accountId: 1 })).toEqual({
      ok: false,
      reason: "missing repository id",
    });
  });

  it("requires both allowlists to pass when both are set", () => {
    const cfg = config({
      ALLOWED_GITHUB_ACCOUNT_IDS: "10",
      ALLOWED_GITHUB_REPOSITORY_IDS: "20",
    });
    expect(authorizeGithubTarget(cfg, { accountId: 10, repositoryId: 20 })).toEqual({ ok: true });
    expect(authorizeGithubTarget(cfg, { accountId: 10, repositoryId: 99 }).ok).toBe(false);
    expect(authorizeGithubTarget(cfg, { accountId: 99, repositoryId: 20 }).ok).toBe(false);
  });
});

describe("authorization logging", () => {
  it("logs only installation id, repository id, and reason", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logAuthorizationRejection({
      installationId: 42,
      repositoryId: 99,
      reason: "unauthorized account",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('"installation_id":42');
    expect(line).toContain('"repository_id":99');
    expect(line).toContain('"reason":"unauthorized account"');
    expect(line).not.toContain("acme");
    expect(line).not.toContain("widgets");
    expect(line).not.toContain("github.com");
    warn.mockRestore();
  });

  it("formats a job-log line without repository names", () => {
    const line = authorizationLogLine({
      installationId: 7,
      repositoryId: 8,
      reason: "unauthorized repository",
    });
    expect(line).toBe("installation_id=7 repository_id=8 reason=unauthorized repository");
  });
});
