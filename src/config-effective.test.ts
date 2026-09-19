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
    const roles = find(entries, "Enabled roles");
    expect(roles.source).toBe("default");
    const approve = find(entries, "Allow APPROVE verdicts");
    expect(approve.value).toBe("disabled");
    const webhook = find(entries, "GitHub webhook secret");
    expect(webhook.value).toBe("not configured");
    // Empty model slots state the real runtime behavior, not a generic default.
    expect(find(entries, "Reviewer model").value).toBe("(empty — provider default)");
    expect(find(entries, "Aggregator model").value).toBe("(empty — runs the reviewer model)");
    expect(find(entries, "Verifier model").value).toBe(
      "(empty — reconciliation verification disabled; priors left open)",
    );
    expect(find(entries, "Router model (env/defaults)").value).toBe("(empty — deterministic routing in hybrid mode)");
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
    expect(find(entries, "Enabled roles")).toMatchObject({ source: "environment" });
    expect(find(entries, "Post empty reviews")).toMatchObject({ source: "environment", value: "enabled" });
    expect(find(entries, "Diff size cap")).toMatchObject({ source: "environment", value: "2048 KiB" });
    const webhook = find(entries, "GitHub webhook secret");
    expect(webhook.source).toBe("environment");
    expect(webhook.value).toBe("configured");
  });

  it("labels active-profile overrides with the revision id and reports enforced ceilings", () => {
    const config = loadConfig({});
    const revision = fakeRevision();
    const entries = effectiveConfigEntries(config, {}, revision);
    const set = find(entries, "Profile reviewer set (effective)");
    expect(set).toMatchObject({ source: "profile", sourceDetail: "#12 (strict)", value: "correctness, security" });
    const router = find(entries, "Profile router model");
    expect(router).toMatchObject({ source: "profile", value: "test/router" });
    const severity = find(entries, "Profile minimum publishable severity");
    expect(severity).toMatchObject({ source: "profile", value: "low" });
    const cost = find(entries, "Profile total cost ceiling");
    expect(cost).toMatchObject({ source: "profile" });
    expect(cost.notEnforced).toBeFalsy();
    const tokens = find(entries, "Profile total token ceiling");
    expect(tokens).toMatchObject({ source: "profile" });
    expect(tokens.notEnforced).toBeFalsy();
    const timeouts = find(entries, "Profile per-reviewer timeouts");
    expect(timeouts).toMatchObject({ source: "profile", value: "correctness: 120s" });
    expect(timeouts.notEnforced).toBeFalsy();
    const behavior = find(entries, "Profile budget behavior");
    expect(behavior).toMatchObject({ source: "profile", value: expect.stringContaining("degrade") });
    // Profile reviewer selection applies only in fixed routing mode.
    const reviewerSet = find(entries, "Profile reviewer set (effective)");
    expect(reviewerSet.notEnforced).toBe(true);
  });

  it("marks the profile reviewer set as enforced in fixed routing mode and drops roles missing from env", () => {
    const config = loadConfig({ REVIEWER_ROLES: "correctness,security" });
    const revision = fakeRevision({
      reviewers: [
        { role: "correctness" },
        { role: "performance" as never },
        { role: "security" as never },
      ],
    });
    const entries = effectiveConfigEntries(config, { REVIEWER_ROLES: "correctness,security" }, revision);
    // Intersection wins: performance is dropped, not silently run.
    expect(find(entries, "Profile reviewer set (effective)")).toMatchObject({
      value: "correctness, security",
      // Default routing mode is hybrid, where the profile set does not apply.
      notEnforced: true,
    });
    expect(find(entries, "Profile roles dropped (not in the env role list)").value).toBe("performance");
  });

  it("marks the profile reviewer set as enforced in fixed routing mode", () => {
    const config = loadConfig({ REVIEWER_ROLES: "correctness,security", REVIEWER_ROUTING: "fixed" });
    const revision = fakeRevision({ reviewers: [{ role: "correctness" }] });
    const entries = effectiveConfigEntries(config, { REVIEWER_ROLES: "correctness,security" }, revision);
    expect(find(entries, "Profile reviewer set (effective)")).toMatchObject({
      value: "correctness",
      notEnforced: false,
    });
  });

  it("marks inherited model slots when only the reviewer model env var is set", () => {
    const env = { OPENCODE_REVIEWER_MODEL: "test/reviewer" };
    const entries = effectiveConfigEntries(loadConfig(env), env, null);
    const aggregator = find(entries, "Aggregator model");
    expect(aggregator).toMatchObject({ source: "environment", value: "test/reviewer", sourceDetail: "inherited from OPENCODE_REVIEWER_MODEL" });
    const verifier = find(entries, "Verifier model");
    expect(verifier).toMatchObject({ source: "environment", sourceDetail: "inherited from OPENCODE_REVIEWER_MODEL" });
    const router = find(entries, "Router model (env/defaults)");
    expect(router.source).toBe("environment");
  });

  it("marks the env router model as shadowed when the profile provides one", () => {
    const env = { OPENCODE_ROUTER_MODEL: "test/env-router" };
    const config = loadConfig(env);
    const entries = effectiveConfigEntries(config, env, fakeRevision());
    const envRouter = find(entries, "Router model (env/defaults)");
    expect(envRouter).toMatchObject({ source: "environment", value: "test/env-router" });
    expect(envRouter.sourceDetail).toContain("not in effect");
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

  it("omits conditional profile entries when their values are absent", () => {
    const entries = effectiveConfigEntries(loadConfig({}), {}, fakeRevision({
      routerModel: undefined,
      reviewers: [{ role: "security" }],
      maxTotalCostUsd: undefined,
      maxTotalTokens: undefined,
    }));
    const labels = entries.map((entry) => entry.label);
    for (const absent of [
      "Per-reviewer profile models",
      "Profile router model",
      "Profile total cost ceiling",
      "Profile total token ceiling",
      "Profile per-reviewer timeouts",
      "Profile roles dropped (not in the env role list)",
    ]) {
      expect(labels, `${absent} should be absent`).not.toContain(absent);
    }
  });

  it("covers the operational surface: webhooks, access, poison alerts, runner", () => {
    const env = {
      PULL_REQUEST_ACTIONS: "opened,synchronize",
      ALLOWED_GITHUB_ACCOUNT_IDS: "1001",
      ALLOWED_GITHUB_REPOSITORY_IDS: "2002",
      REPO_RATE_LIMIT_PER_WINDOW: "6",
      POISON_ALERT_INTERNAL_ENABLED: "true",
      POISON_ALERT_INTERNAL_MODEL: "test/lab",
      POISON_ALERT_POLICY: "internal_and_external",
      GITHUB_ISSUE_CREATION_ENABLED: "true",
      OPENCODE_BIN: "/usr/local/bin/opencode",
    };
    const entries = effectiveConfigEntries(loadConfig(env), env, null);
    expect(find(entries, "Webhook actions that enqueue reviews")).toMatchObject({
      source: "environment",
      value: "opened, synchronize",
    });
    expect(find(entries, "Allowed GitHub accounts")).toMatchObject({ source: "environment", value: "1001" });
    expect(find(entries, "Repository rate limit")).toMatchObject({ value: "6 per 60min" });
    expect(find(entries, "Internal re-check")).toMatchObject({ value: "enabled" });
    expect(find(entries, "Internal model")).toMatchObject({ source: "environment", value: "test/lab" });
    expect(find(entries, "Issue creation from scans")).toMatchObject({ value: "enabled" });
    expect(find(entries, "OpenCode binary")).toMatchObject({ value: "/usr/local/bin/opencode" });
  });

describe("env-var to entry mapping (table)", () => {
  const cases: Array<[string, string]> = [
    ["OPENCODE_VERIFIER_MODEL", "Verifier model"],
    ["MODEL_CATALOG", "Model catalog (allowlist)"],
    ["OPENCODE_VERIFIER_TIMEOUT_MS", "Verifier timeout"],
    ["ROUTER_TIMEOUT_MS", "Router timeout"],
    ["OPENCODE_REVIEWER_CONCURRENCY", "Reviewer concurrency (per job)"],
    ["OPENCODE_MAX_RETRIES", "Reviewer retries"],
    ["REVIEWER_ROUTING", "Routing mode"],
    ["ROUTER_MAX_DIFF_CHARS", "Router max diff chars"],
    ["ROUTER_MAX_REVIEWERS", "Router max reviewers"],
    ["GITHUB_REVIEW_REQUEST_CHANGES_MIN_SEVERITY", "Request-changes minimum severity"],
    ["GITHUB_REVIEW_ALLOW_REQUEST_CHANGES", "Allow REQUEST_CHANGES verdicts"],
    ["REVIEW_DRAFTS", "Review drafts"],
    ["MAX_INLINE_COMMENTS", "Max inline comments"],
    ["POISON_ALERT_INTERNAL_MAX_COST_USD", "Internal max cost"],
    ["POISON_ALERT_INTERNAL_MAX_TOKENS", "Internal max tokens"],
    ["POISON_ALERT_EXTERNAL_MIN_SEVERITY", "External minimum severity"],
    ["OPENCODE_EXTRA_ARGS", "OpenCode extra args"],
  ];
  // Sentinel values each parser accepts, so the value (not just the badge) is env-derived.
  const accepted: Record<string, string> = {
    OPENCODE_VERIFIER_MODEL: "test/verifier",
    OPENCODE_VERIFIER_TIMEOUT_MS: "90000",
    ROUTER_TIMEOUT_MS: "45000",
    OPENCODE_REVIEWER_CONCURRENCY: "3",
    OPENCODE_MAX_RETRIES: "2",
    ROUTER_MAX_DIFF_CHARS: "8000",
    ROUTER_MAX_REVIEWERS: "4",
    GITHUB_REVIEW_REQUEST_CHANGES_MIN_SEVERITY: "high",
    GITHUB_REVIEW_ALLOW_REQUEST_CHANGES: "true",
    REVIEW_DRAFTS: "true",
    MAX_INLINE_COMMENTS: "9",
    POISON_ALERT_INTERNAL_MAX_COST_USD: "0.5",
    POISON_ALERT_INTERNAL_MAX_TOKENS: "100000",
    POISON_ALERT_EXTERNAL_MIN_SEVERITY: "high",
    REVIEWER_ROUTING: "deterministic",
  };
  // Rendered form differs from the raw value for formatted rows.
  const rendered: Record<string, string> = {
    OPENCODE_VERIFIER_TIMEOUT_MS: "90s",
    ROUTER_TIMEOUT_MS: "45s",
    GITHUB_REVIEW_ALLOW_REQUEST_CHANGES: "enabled",
    REVIEW_DRAFTS: "enabled",
    POISON_ALERT_INTERNAL_MAX_COST_USD: "$0.50",
  };
  // Rows that only render when the feature is enabled.
  const requiresEnabled: Record<string, string> = {
    POISON_ALERT_INTERNAL_MAX_COST_USD: "POISON_ALERT_INTERNAL_ENABLED",
    POISON_ALERT_INTERNAL_MAX_TOKENS: "POISON_ALERT_INTERNAL_ENABLED",
  };

  it.each(cases)("labels %s as the source of the %s entry", (envKey, label) => {
    const env: Record<string, string> = { [envKey]: accepted[envKey] ?? "sentinel" };
    for (const gate of [requiresEnabled[envKey]].filter(Boolean)) {
      env[gate!] = "true";
    }
    if (envKey === "POISON_ALERT_INTERNAL_MODEL") env.POISON_ALERT_INTERNAL_MODEL = "test/lab";
    const entries = effectiveConfigEntries(loadConfig(env), env, null);
    const entry = find(entries, label);
    expect(entry.source).toBe("environment");
    expect(entry.value).toContain(rendered[envKey] ?? (accepted[envKey] ?? "sentinel"));
  });
});
