import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { JobStore } from "../jobs/store.js";
import { loadConfig } from "../config.js";
import { handleGithubWebhook, shouldHandlePullRequest } from "./webhooks.js";

function sign(secret: string, body: string): string {
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${digest}`;
}

function prPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    installation: { id: 42 },
    repository: { full_name: "acme/widgets", name: "widgets", owner: { login: "acme" } },
    pull_request: {
      number: 7,
      title: "Add frob",
      body: "does a thing",
      html_url: "https://github.com/acme/widgets/pull/7",
      draft: false,
      user: { login: "octocat" },
      base: { sha: "base111", ref: "main" },
      head: { sha: "head222", ref: "feature" },
    },
    ...overrides,
  };
}

describe("webhook handling", () => {
  it("rejects invalid signatures", async () => {
    const config = loadConfig({ GITHUB_WEBHOOK_SECRET: "s3cret", REVIEWER_ROLES: "correctness" });
    const store = new JobStore(openDb(":memory:"));
    const result = await handleGithubWebhook({
      config,
      store,
      request: {
        event: "ping",
        deliveryId: "1",
        signature: "sha256=deadbeef",
        rawBody: "{}",
      },
    });
    expect(result.status).toBe(401);
  });

  it("accepts ping with a valid signature", async () => {
    const secret = "s3cret";
    const config = loadConfig({ GITHUB_WEBHOOK_SECRET: secret, REVIEWER_ROLES: "correctness" });
    const store = new JobStore(openDb(":memory:"));
    const rawBody = "{}";
    const result = await handleGithubWebhook({
      config,
      store,
      request: { event: "ping", deliveryId: "1", signature: sign(secret, rawBody), rawBody },
    });
    expect(result.status).toBe(200);
  });

  it("ignores drafts by default", () => {
    const config = loadConfig({ REVIEW_DRAFTS: "false" });
    expect(shouldHandlePullRequest(config, prPayload({ pull_request: { ...prPayload().pull_request, draft: true } }))).toEqual(
      { handle: false, reason: "ignored draft pull request" },
    );
  });

  it("enqueues opened pull requests idempotently and stales old SHAs", async () => {
    const secret = "s3cret";
    const config = loadConfig({
      GITHUB_WEBHOOK_SECRET: secret,
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "k",
      REVIEWER_ROLES: "correctness,security",
    });
    const store = new JobStore(openDb(":memory:"));
    const firstBody = JSON.stringify(prPayload());
    const first = await handleGithubWebhook({
      config,
      store,
      request: {
        event: "pull_request",
        deliveryId: "d1",
        signature: sign(secret, firstBody),
        rawBody: firstBody,
      },
    });
    expect(first.status).toBe(202);
    expect(first.body.created).toBe(true);

    const dup = await handleGithubWebhook({
      config,
      store,
      request: {
        event: "pull_request",
        deliveryId: "d1b",
        signature: sign(secret, firstBody),
        rawBody: firstBody,
      },
    });
    expect(dup.body.created).toBe(false);
    expect(dup.body.jobId).toBe(first.body.jobId);

    const syncBody = JSON.stringify(
      prPayload({
        action: "synchronize",
        pull_request: { ...prPayload().pull_request, head: { sha: "head333", ref: "feature" } },
      }),
    );
    const sync = await handleGithubWebhook({
      config,
      store,
      request: {
        event: "pull_request",
        deliveryId: "d2",
        signature: sign(secret, syncBody),
        rawBody: syncBody,
      },
    });
    expect(sync.body.created).toBe(true);
    expect(sync.body.headSha).toBe("head333");
    expect(store.getJob(Number(first.body.jobId))?.state).toBe("stale");
  });

  it("enqueues hybrid jobs without a preselected reviewer set", async () => {
    const secret = "s3cret";
    const config = loadConfig({
      GITHUB_WEBHOOK_SECRET: secret,
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "k",
      REVIEWER_ROUTING: "hybrid",
      REVIEWER_ROLES: "correctness,security",
    });
    const store = new JobStore(openDb(":memory:"));
    const rawBody = JSON.stringify(prPayload());
    const result = await handleGithubWebhook({
      config,
      store,
      request: { event: "pull_request", deliveryId: "d3", signature: sign(secret, rawBody), rawBody },
    });
    expect(result.body.created).toBe(true);
    expect(store.listReviewerRuns(Number(result.body.jobId))).toHaveLength(0);
  });

  it("ignores bot and marker comments and accepts authorized escalate commands", async () => {
    const secret = "s3cret";
    const config = loadConfig({
      GITHUB_WEBHOOK_SECRET: secret,
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "k",
      REVIEWER_ROUTING: "fixed",
      REVIEWER_ROLES: "correctness",
      POISON_ALERT_POLICY: "manual",
      POISON_ALERT_EXTERNAL_ENABLED: "true",
    });
    const store = new JobStore(openDb(":memory:"));
    const prBody = JSON.stringify(prPayload());
    await handleGithubWebhook({
      config,
      store,
      request: { event: "pull_request", deliveryId: "p1", signature: sign(secret, prBody), rawBody: prBody },
    });
    const jobId = store.listJobs(1)[0]?.id;
    expect(jobId).toBeTruthy();
    store.patchJob(jobId!, { routing_profile: "poison-alert", github_review_id: "1" });

    const botBody = JSON.stringify({
      action: "created",
      installation: { id: 42 },
      repository: { full_name: "acme/widgets", name: "widgets", owner: { login: "acme" } },
      issue: { number: 7, pull_request: { url: "https://github.com/acme/widgets/pull/7" } },
      comment: {
        body: "@maomao escalate",
        user: { login: "other[bot]", type: "Bot" },
        author_association: "OWNER",
      },
    });
    const bot = await handleGithubWebhook({
      config,
      store,
      request: { event: "issue_comment", deliveryId: "c1", signature: sign(secret, botBody), rawBody: botBody },
    });
    expect(bot.body.reason).toMatch(/bot/i);

    const markerBody = JSON.stringify({
      action: "created",
      installation: { id: 42 },
      repository: { full_name: "acme/widgets", name: "widgets", owner: { login: "acme" } },
      issue: { number: 7, pull_request: { url: "https://github.com/acme/widgets/pull/7" } },
      comment: {
        body: "<!-- maomao-escalation id=x provider=github instance=github.com repo=acme/widgets pr=7 sha=head222 job=1 status=dispatched reason=\"x\" -->\n@maomao escalate",
        user: { login: "alice", type: "User" },
        author_association: "OWNER",
      },
    });
    const marker = await handleGithubWebhook({
      config,
      store,
      request: { event: "issue_comment", deliveryId: "c2", signature: sign(secret, markerBody), rawBody: markerBody },
    });
    expect(marker.body.reason).toMatch(/marker/i);

    const okBody = JSON.stringify({
      action: "created",
      installation: { id: 42 },
      repository: { full_name: "acme/widgets", name: "widgets", owner: { login: "acme" } },
      issue: { number: 7, pull_request: { url: "https://github.com/acme/widgets/pull/7" } },
      comment: {
        body: "@maomao escalate",
        user: { login: "alice", type: "User" },
        author_association: "OWNER",
      },
    });
    const ok = await handleGithubWebhook({
      config,
      store,
      request: { event: "issue_comment", deliveryId: "c3", signature: sign(secret, okBody), rawBody: okBody },
    });
    expect(ok.dispatchJobId).toBe(jobId);
    expect(store.getJob(jobId!)?.manual_escalate_requested).toBe(1);
  });
});
