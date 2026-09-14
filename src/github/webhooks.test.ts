import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
import { JobStore } from "../jobs/store.js";
import { loadConfig } from "../config.js";
import { handleGithubWebhook, parsePullRequestPayload, shouldHandlePullRequest } from "./webhooks.js";
import { RepoRateLimiter } from "./rate-limit.js";

function sign(secret: string, body: string): string {
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${digest}`;
}

function prPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    installation: { id: 42, account: { id: 1001 } },
    repository: { id: 2002, full_name: "acme/widgets", name: "widgets", owner: { login: "acme", id: 1001 } },
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
    expect(store.getJob(Number(first.body.jobId))?.github_account_id).toBe(1001);
    expect(store.getJob(Number(sync.body.jobId))?.github_repository_id).toBe(2002);
  });

  it("parses numeric account and repository ids from the payload", () => {
    const parsed = parsePullRequestPayload(prPayload());
    expect(parsed.installationId).toBe(42);
    expect(parsed.githubAccountId).toBe(1001);
    expect(parsed.githubRepositoryId).toBe(2002);
  });

  it("returns 202 ignored for unauthorized accounts and never enqueues", async () => {
    const secret = "s3cret";
    const config = loadConfig({
      GITHUB_WEBHOOK_SECRET: secret,
      REVIEWER_ROLES: "correctness",
      ALLOWED_GITHUB_ACCOUNT_IDS: "9999",
    });
    const store = new JobStore(openDb(":memory:"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rawBody = JSON.stringify(prPayload());
    const result = await handleGithubWebhook({
      config,
      store,
      request: {
        event: "pull_request",
        deliveryId: "d-unauth-account",
        signature: sign(secret, rawBody),
        rawBody,
      },
    });
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ ok: true, ignored: true, reason: "unauthorized account" });
    expect(result.enqueue).toBeUndefined();
    expect(store.listJobs()).toEqual([]);
    const log = String(warn.mock.calls[0]?.[0]);
    expect(log).toContain("unauthorized account");
    expect(log).toContain('"installation_id":42');
    expect(log).toContain('"repository_id":2002');
    expect(log).not.toContain("acme/widgets");
    expect(log).not.toContain("octocat");
    expect(log).not.toContain("https://github.com");
    warn.mockRestore();
  });

  it("returns 202 ignored for unauthorized repositories and never enqueues", async () => {
    const secret = "s3cret";
    const config = loadConfig({
      GITHUB_WEBHOOK_SECRET: secret,
      REVIEWER_ROLES: "correctness",
      ALLOWED_GITHUB_REPOSITORY_IDS: "1",
    });
    const store = new JobStore(openDb(":memory:"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rawBody = JSON.stringify(prPayload());
    const result = await handleGithubWebhook({
      config,
      store,
      request: {
        event: "pull_request",
        deliveryId: "d-unauth-repo",
        signature: sign(secret, rawBody),
        rawBody,
      },
    });
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ ok: true, ignored: true, reason: "unauthorized repository" });
    expect(result.enqueue).toBeUndefined();
    expect(store.listJobs()).toEqual([]);
    warn.mockRestore();
  });

  it("fails closed when an allowlist is set but the payload omits the numeric id", async () => {
    const secret = "s3cret";
    const config = loadConfig({
      GITHUB_WEBHOOK_SECRET: secret,
      REVIEWER_ROLES: "correctness",
      ALLOWED_GITHUB_ACCOUNT_IDS: "1001",
    });
    const store = new JobStore(openDb(":memory:"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rawBody = JSON.stringify(
      prPayload({
        installation: { id: 42 },
        repository: { id: 2002, full_name: "acme/widgets", name: "widgets", owner: { login: "acme" } },
      }),
    );
    const result = await handleGithubWebhook({
      config,
      store,
      request: {
        event: "pull_request",
        deliveryId: "d-missing-account",
        signature: sign(secret, rawBody),
        rawBody,
      },
    });
    expect(result.status).toBe(202);
    expect(result.body.ignored).toBe(true);
    expect(result.body.reason).toBe("missing account id");
    expect(store.listJobs()).toEqual([]);
    warn.mockRestore();
  });

  it("rate-limits extra deliveries for the same repository id before enqueue", async () => {
    const secret = "s3cret";
    const config = loadConfig({
      GITHUB_WEBHOOK_SECRET: secret,
      REVIEWER_ROLES: "correctness",
      REPO_RATE_LIMIT_PER_WINDOW: "1",
      REPO_RATE_WINDOW_MS: "60000",
    });
    const store = new JobStore(openDb(":memory:"));
    const limiter = new RepoRateLimiter();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const firstBody = JSON.stringify(prPayload());
    const first = await handleGithubWebhook({
      config,
      store,
      rateLimiter: limiter,
      request: {
        event: "pull_request",
        deliveryId: "d-rate-1",
        signature: sign(secret, firstBody),
        rawBody: firstBody,
      },
    });
    expect(first.body.created).toBe(true);

    const secondBody = JSON.stringify(
      prPayload({
        pull_request: { ...prPayload().pull_request, head: { sha: "head-other", ref: "feature" }, number: 8 },
      }),
    );
    const second = await handleGithubWebhook({
      config,
      store,
      rateLimiter: limiter,
      request: {
        event: "pull_request",
        deliveryId: "d-rate-2",
        signature: sign(secret, secondBody),
        rawBody: secondBody,
      },
    });
    expect(second.status).toBe(202);
    expect(second.body).toEqual({ ok: true, ignored: true, reason: "rate limited" });
    expect(second.enqueue).toBeUndefined();
    expect(store.listJobs()).toHaveLength(1);
    const log = String(warn.mock.calls[0]?.[0]);
    expect(log).toContain("rate limited");
    expect(log).toContain('"msg":"github rate limited"');
    expect(log).not.toContain("github authorization rejected");
    warn.mockRestore();
  });

  it("ignores signed payloads that omit repository.id when rate limiting is enabled", async () => {
    const secret = "s3cret";
    const config = loadConfig({
      GITHUB_WEBHOOK_SECRET: secret,
      REVIEWER_ROLES: "correctness",
      REPO_RATE_LIMIT_PER_WINDOW: "1",
      REPO_RATE_WINDOW_MS: "60000",
    });
    const store = new JobStore(openDb(":memory:"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { id: _omitted, ...repository } = prPayload().repository as { id: number } & Record<string, unknown>;
    const rawBody = JSON.stringify(prPayload({ repository }));
    const result = await handleGithubWebhook({
      config,
      store,
      rateLimiter: new RepoRateLimiter(),
      request: {
        event: "pull_request",
        deliveryId: "d-missing-repo-id",
        signature: sign(secret, rawBody),
        rawBody,
      },
    });
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ ok: true, ignored: true, reason: "missing repository id" });
    expect(result.enqueue).toBeUndefined();
    expect(store.listJobs()).toEqual([]);
    warn.mockRestore();
  });

  it("does not consume rate-limit quota for duplicate deliveries", async () => {
    const secret = "s3cret";
    const config = loadConfig({
      GITHUB_WEBHOOK_SECRET: secret,
      REVIEWER_ROLES: "correctness",
      REPO_RATE_LIMIT_PER_WINDOW: "2",
      REPO_RATE_WINDOW_MS: "60000",
    });
    const store = new JobStore(openDb(":memory:"));
    const limiter = new RepoRateLimiter();
    const firstBody = JSON.stringify(prPayload());
    const first = await handleGithubWebhook({
      config,
      store,
      rateLimiter: limiter,
      request: {
        event: "pull_request",
        deliveryId: "d-dup-1",
        signature: sign(secret, firstBody),
        rawBody: firstBody,
      },
    });
    expect(first.body.created).toBe(true);

    const dup = await handleGithubWebhook({
      config,
      store,
      rateLimiter: limiter,
      request: {
        event: "pull_request",
        deliveryId: "d-dup-2",
        signature: sign(secret, firstBody),
        rawBody: firstBody,
      },
    });
    expect(dup.body.created).toBe(false);

    const secondBody = JSON.stringify(
      prPayload({
        pull_request: { ...prPayload().pull_request, head: { sha: "head-other", ref: "feature" }, number: 8 },
      }),
    );
    const second = await handleGithubWebhook({
      config,
      store,
      rateLimiter: limiter,
      request: {
        event: "pull_request",
        deliveryId: "d-dup-3",
        signature: sign(secret, secondBody),
        rawBody: secondBody,
      },
    });
    expect(second.body.created).toBe(true);

    const thirdBody = JSON.stringify(
      prPayload({
        pull_request: { ...prPayload().pull_request, head: { sha: "head-third", ref: "feature" }, number: 9 },
      }),
    );
    const third = await handleGithubWebhook({
      config,
      store,
      rateLimiter: limiter,
      request: {
        event: "pull_request",
        deliveryId: "d-dup-4",
        signature: sign(secret, thirdBody),
        rawBody: thirdBody,
      },
    });
    expect(third.status).toBe(202);
    expect(third.body).toEqual({ ok: true, ignored: true, reason: "rate limited" });
    expect(store.listJobs()).toHaveLength(2);
  });
});
