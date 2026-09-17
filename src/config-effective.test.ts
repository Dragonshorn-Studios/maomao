import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { effectiveConfigEntries } from "./config-effective.js";
import type { ProfileRevisionRow } from "./config-revisions.js";

function fakeRevision(overrides: Partial<ProfileRevisionRow["definition"]> = {}): ProfileRevisionRow {
  const definition = {
    name: "strict",
    reviewers: [
      { role: "correctness", model: "test/model-a", timeoutMs: 120_000 },
      { role: "security" },
    ],
    routerModel: "test/router",
    minPublishableSeverity: "low" as const,
    maxTotalCostUsd: 1.5,
    maxTotalTokens: 500_000,
    ...overrides,
  };
  return {
    id: 12,
    name: "strict",
    status: "active",
    definition,
    definition_json: JSON.stringify(definition),
    note: null,
    created_by: "octocat",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    activated_at: "2026-01-01T00:00:00Z",
    schema_version: 1,
    editSeq: 3,
  } as ProfileRevisionRow;
}

function find(entries: ReturnType<typeof effectiveConfigEntries>, label: string) {
  const entry = entries.find((entry) => entry.label === label);
  expect(entry, `expected an entry labeled ${label}`).toBeTruthy();
  return entry!;
}

describe("effectiveConfigEntries", () => {
  it("labels defaults when no env vars are set", () => {
    const config = loadConfig({});
    const entries = effectiveConfigEntries(config, {}, null);
    const reviewerModel = find(entries, "Reviewer model");
    expect(reviewerModel.source).toBe("default");
    const roles = find(entries, "Enabled roles (env/default)");
    expect(roles.source).toBe("default");
    const approve = find(entries, "Allow APPROVE verdicts");
    expect(approve.value).toBe("disabled");
    const webhook = find(entries, "GitHub webhook secret");
    expect(webhook.value).toBe("not configured");
  });

  it("labels environment-backed values and their variable wins over defaults", () => {
    const config = loadConfig({
      OPENCODE_REVIEWER_MODEL: "test/reviewer",
      OPENCODE_TIMEOUT_MS: "300000",
      JOB_CONCURRENCY: "4",
      REVIEWER_ROLES: "correctness,security",
      POST_EMPTY_REVIEW: "true",
      GITHUB_WEBHOOK_SECRET: "whsec-canary-value",
      MAX_DIFF_BYTES: "2097152",
    });
    const entries = effectiveConfigEntries(config, {
      OPENCODE_REVIEWER_MODEL: "test/reviewer",
      OPENCODE_TIMEOUT_MS: "300000",
      JOB_CONCURRENCY: "4",
      REVIEWER_ROLES: "correctness,security",
      POST_EMPTY_REVIEW: "true",
      GITHUB_WEBHOOK_SECRET: "whsec-canary-value",
      MAX_DIFF_BYTES: "2097152",
    }, null);
    expect(find(entries, "Reviewer model")).toMatchObject({ source: "environment", value: "test/reviewer" });
    expect(find(entries, "Reviewer timeout")).toMatchObject({ source: "environment", value: "300s" });
    expect(find(entries, "Job concurrency")).toMatchObject({ source: "environment", value: "4" });
    expect(find(entries, "Enabled roles (env/default)")).toMatchObject({ source: "environment" });
    expect(find(entries, "Post empty reviews")).toMatchObject({ source: "environment", value: "enabled" });
    expect(find(entries, "Diff size cap")).toMatchObject({ source: "environment", value: "2048 KiB" });
    const webhook = find(entries, "GitHub webhook secret");
    expect(webhook.source).toBe("environment");
    expect(webhook.value).toBe("configured");
  });

  it("labels active-profile overrides with the revision id and flags unenforced fields", () => {
    const config = loadConfig({});
    const revision = fakeRevision();
    const entries = effectiveConfigEntries(config, {}, revision);
    const set = find(entries, "Profile reviewer set");
    expect(set).toMatchObject({ source: "profile", sourceDetail: "#12 (strict)", value: "correctness, security" });
    const router = find(entries, "Profile router model");
    expect(router).toMatchObject({ source: "profile", value: "test/router" });
    const severity = find(entries, "Profile minimum publishable severity");
    expect(severity).toMatchObject({ source: "profile", value: "low" });
    const cost = find(entries, "Profile total cost ceiling");
    expect(cost).toMatchObject({ source: "profile", notEnforced: true });
    const tokens = find(entries, "Profile total token ceiling");
    expect(tokens).toMatchObject({ source: "profile", notEnforced: true });
    const timeouts = find(entries, "Profile per-reviewer timeouts");
    expect(timeouts).toMatchObject({ source: "profile", notEnforced: true, value: "correctness: 120s" });
  });

  it("never embeds credential values — presence only", () => {
    const config = loadConfig({
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "PRIVATE-KEY-CANARY-VALUE",
      GITHUB_WEBHOOK_SECRET: "WEBHOOK-SECRET-CANARY",
      GITHUB_OAUTH_CLIENT_SECRET: "OAUTH-SECRET-CANARY",
      UI_PASSWORD: "PASSWORD-CANARY",
      UI_SESSION_SECRET: "SESSION-SECRET-CANARY",
    });
    const env = {
      GITHUB_APP_PRIVATE_KEY: "PRIVATE-KEY-CANARY-VALUE",
      GITHUB_WEBHOOK_SECRET: "WEBHOOK-SECRET-CANARY",
      GITHUB_OAUTH_CLIENT_SECRET: "OAUTH-SECRET-CANARY",
      UI_PASSWORD: "PASSWORD-CANARY",
      UI_SESSION_SECRET: "SESSION-SECRET-CANARY",
    };
    const rendered = JSON.stringify(effectiveConfigEntries(config, env, fakeRevision()));
    for (const canary of [
      "PRIVATE-KEY-CANARY-VALUE",
      "WEBHOOK-SECRET-CANARY",
      "OAUTH-SECRET-CANARY",
      "PASSWORD-CANARY",
      "SESSION-SECRET-CANARY",
    ]) {
      expect(rendered, `credential canary ${canary} leaked`).not.toContain(canary);
    }
    expect(rendered).toContain("configured");
  });
});
