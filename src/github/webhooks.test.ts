import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
import { JobStore } from "../jobs/store.js";
import { loadConfig } from "../config.js";
import { handleGithubWebhook, parsePullRequestPayload, shouldHandlePullRequest } from "./webhooks.js";
import { RepoRateLimiter } from "./rate-limit.js";
import type { GithubPort, RepoPermission, ReviewThread } from "./client.js";

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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
    warn.mockRestore();
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
        body: "<!-- maomao-escalation id=x provider=github instance=github.com repo=acme/widgets pr=7 sha=head222 job=1 target=mention:@acme status=dispatched -->\n@maomao escalate",
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
      github: githubForCommands({ permission: "none" }),
      request: { event: "issue_comment", deliveryId: "c3", signature: sign(secret, okBody), rawBody: okBody },
    });
    expect(ok.dispatchJobId).toBe(jobId);
    expect(store.getJob(jobId!)?.manual_escalate_requested).toBe(1);
    // The escalate path claims its own result — the deliveries log shows
    // "escalate", not a boundary-recorded bare "ok".
    expect(store.listWebhookDeliveries({}).find((d) => d.delivery_id === "c3")?.result).toBe("escalate");

    store.patchJob(jobId!, { manual_escalate_requested: 0 });
    const memberBody = JSON.stringify({
      action: "created",
      installation: { id: 42 },
      repository: { full_name: "acme/widgets", name: "widgets", owner: { login: "acme" } },
      issue: { number: 7, pull_request: { url: "https://github.com/acme/widgets/pull/7" } },
      comment: {
        body: "@maomao escalate",
        user: { login: "member", type: "User" },
        author_association: "MEMBER",
      },
    });
    const memberNone = await handleGithubWebhook({
      config,
      store,
      github: githubForCommands({ permission: "none" }),
      request: { event: "issue_comment", deliveryId: "c4", signature: sign(secret, memberBody), rawBody: memberBody },
    });
    expect(memberNone.body.reason).toMatch(/not authorized/i);
    expect(store.getJob(jobId!)?.manual_escalate_requested).toBe(0);

    const memberWrite = await handleGithubWebhook({
      config,
      store,
      github: githubForCommands({ permission: "write" }),
      request: { event: "issue_comment", deliveryId: "c5", signature: sign(secret, memberBody), rawBody: memberBody },
    });
    expect(memberWrite.dispatchJobId).toBe(jobId);
    expect(store.getJob(jobId!)?.manual_escalate_requested).toBe(1);
  });
});

function githubForCommands(overrides: {
  permission?: RepoPermission;
  threads?: ReviewThread[];
  resolved?: string[];
  unresolved?: string[];
} = {}): GithubPort {
  const resolved = overrides.resolved ?? [];
  const unresolved = overrides.unresolved ?? [];
  return {
    getInstallationToken: async () => "t",
    getPullDiff: async () => "",
    listReviews: async () => [],
    createCommentReview: async () => ({ id: "1", url: "u" }),
    listReviewThreads: async () => overrides.threads ?? [maomaoThread()],
    resolveReviewThread: async (_id, threadId) => {
      resolved.push(threadId);
    },
    unresolveReviewThread: async (_id, threadId) => {
      unresolved.push(threadId);
    },
    getCollaboratorPermission: async () => overrides.permission ?? "write",
  };
}

function maomaoThread() {
  return {
    id: "PRRT_1",
    isResolved: false,
    path: "src/a.ts",
    line: 4,
    comments: [
      {
        id: "n1",
        databaseId: 11,
        body: "<!-- maomao-finding id=deadbeefdeadbeef sha=abc -->\n**high**: leak",
        path: "src/a.ts",
        line: 4,
        authorLogin: "maomao[bot]",
      },
    ],
  };
}

function reviewCommentBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    action: "created",
    installation: { id: 42 },
    repository: { full_name: "acme/widgets", name: "widgets", owner: { login: "acme" } },
    pull_request: { number: 7, head: { sha: "head222" } },
    comment: {
      id: 99,
      body: "@maomao bury",
      path: "src/a.ts",
      in_reply_to_id: 11,
      user: { login: "octocat" },
      author_association: "MEMBER",
      ...((overrides.comment as object) ?? {}),
    },
    ...overrides,
  });
}

describe("review thread override commands", () => {
  const secret = "s3cret";

  async function post(rawBody: string, extra: { deliveryId?: string; github?: ReturnType<typeof githubForCommands> } = {}) {
    const config = loadConfig({
      GITHUB_WEBHOOK_SECRET: secret,
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "k",
      GITHUB_APP_SLUG: "maomao",
      REVIEWER_ROLES: "correctness",
    });
    const store = extra.github
      ? undefined
      : new JobStore(openDb(":memory:"));
    const dbStore = extra.github ? new JobStore(openDb(":memory:")) : store!;
    const result = await handleGithubWebhook({
      config,
      store: dbStore,
      github: extra.github ?? githubForCommands(),
      request: {
        event: "pull_request_review_comment",
        deliveryId: extra.deliveryId ?? "cmd-1",
        signature: sign(secret, rawBody),
        rawBody,
      },
    });
    return { result, store: dbStore };
  }

  it("buries ignore/bury/seedling replies from authorized users", async () => {
    for (const [delivery, body] of [
      ["d-ignore", "@maomao ignore"],
      ["d-bury", "@maomao bury"],
      ["d-seed", "🌱"],
    ] as const) {
      const resolved: string[] = [];
      const { result, store } = await post(reviewCommentBody({ comment: { id: Date.now(), body, in_reply_to_id: 11, user: { login: "octocat" } } }), {
        deliveryId: delivery,
        github: githubForCommands({ resolved }),
      });
      expect(result.status).toBe(200);
      expect(result.body.command).toBe("dismiss");
      expect(resolved).toEqual(["PRRT_1"]);
      expect(store.getFinding("acme/widgets", 7, "deadbeefdeadbeef")?.status).toBe("dismissed");
    }
  });

  it("rejects unauthorized users and never resolves human threads", async () => {
    const resolved: string[] = [];
    const unauthorized = await post(reviewCommentBody(), {
      deliveryId: "unauth",
      github: githubForCommands({ permission: "read", resolved }),
    });
    expect(unauthorized.result.body.reason).toBe("unauthorized");
    expect(resolved).toEqual([]);

    const ownerRead = await post(
      reviewCommentBody({
        comment: {
          id: 199,
          body: "@maomao bury",
          path: "src/a.ts",
          in_reply_to_id: 11,
          user: { login: "octocat" },
          author_association: "OWNER",
        },
      }),
      {
        deliveryId: "owner-read",
        github: githubForCommands({ permission: "read", resolved }),
      },
    );
    expect(ownerRead.result.body.reason).toBe("unauthorized");
    expect(resolved).toEqual([]);

    const memberNone = await post(
      reviewCommentBody({
        comment: {
          id: 200,
          body: "@maomao bury",
          path: "src/a.ts",
          in_reply_to_id: 11,
          user: { login: "octocat" },
          author_association: "MEMBER",
        },
      }),
      {
        deliveryId: "member-404",
        github: githubForCommands({ permission: "none", resolved }),
      },
    );
    expect(memberNone.result.body.reason).toBe("unauthorized");
    expect(resolved).toEqual([]);

    const human = await post(reviewCommentBody(), {
      deliveryId: "human",
      github: githubForCommands({
        resolved,
        threads: [
          {
            id: "PRRT_human",
            isResolved: false,
            comments: [{ id: "h", databaseId: 11, body: "please fix", path: "a.ts", line: 1, authorLogin: "human" }],
          },
        ],
      }),
    });
    expect(human.result.body.reason).toBe("not a Maomao review thread");
    expect(resolved).toEqual([]);
  });

  it("accepts a personal-repo OWNER when the collaborator API 404s as none", async () => {
    const resolved: string[] = [];
    const { result, store } = await post(
      reviewCommentBody({
        comment: {
          id: 201,
          body: "@maomao bury",
          path: "src/a.ts",
          in_reply_to_id: 11,
          user: { login: "octocat" },
          author_association: "OWNER",
        },
      }),
      {
        deliveryId: "owner-none",
        github: githubForCommands({ permission: "none", resolved }),
      },
    );
    expect(result.status).toBe(200);
    expect(result.body.command).toBe("dismiss");
    expect(resolved).toEqual(["PRRT_1"]);
    expect(store.getFinding("acme/widgets", 7, "deadbeefdeadbeef")?.status).toBe("dismissed");
  });

  it("finds the Maomao marker when it is not the first comment in the thread", async () => {
    const resolved: string[] = [];
    const { result, store } = await post(reviewCommentBody(), {
      deliveryId: "marker-later",
      github: githubForCommands({
        resolved,
        threads: [
          {
            id: "PRRT_1",
            isResolved: false,
            comments: [
              { id: "reply", databaseId: 99, body: "looks fine", path: "src/a.ts", line: 4, authorLogin: "octocat" },
              {
                id: "n1",
                databaseId: 11,
                body: "<!-- maomao-finding id=deadbeefdeadbeef sha=abc -->\n**high**: leak",
                path: "src/a.ts",
                line: 4,
                authorLogin: "maomao[bot]",
              },
            ],
          },
        ],
      }),
    });
    expect(result.status).toBe(200);
    expect(result.body.command).toBe("dismiss");
    expect(resolved).toEqual(["PRRT_1"]);
    expect(store.getFinding("acme/widgets", 7, "deadbeefdeadbeef")?.status).toBe("dismissed");
  });

  it("is idempotent for duplicate deliveries and repeated commands", async () => {
    const resolved: string[] = [];
    const github = githubForCommands({ resolved });
    const config = loadConfig({
      GITHUB_WEBHOOK_SECRET: secret,
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "k",
      REVIEWER_ROLES: "correctness",
    });
    const store = new JobStore(openDb(":memory:"));
    const rawBody = reviewCommentBody();
    const first = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request_review_comment", deliveryId: "same", signature: sign(secret, rawBody), rawBody },
    });
    const dup = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request_review_comment", deliveryId: "same", signature: sign(secret, rawBody), rawBody },
    });
    expect(first.body.changed).toBe(true);
    expect(dup.body.duplicate).toBe(true);
    expect(resolved).toEqual(["PRRT_1"]);

    const repeatBody = reviewCommentBody({ comment: { id: 100, body: "@maomao bury", in_reply_to_id: 11, user: { login: "octocat" } } });
    const repeat = await handleGithubWebhook({
      config,
      store,
      github,
      request: {
        event: "pull_request_review_comment",
        deliveryId: "other",
        signature: sign(secret, repeatBody),
        rawBody: repeatBody,
      },
    });
    expect(repeat.body.changed).toBe(false);
    expect(store.getFinding("acme/widgets", 7, "deadbeefdeadbeef")?.status).toBe("dismissed");
  });

  it("reopens a dismissed finding", async () => {
    const unresolved: string[] = [];
    const github = githubForCommands({ unresolved });
    const { store } = await post(reviewCommentBody(), { deliveryId: "bury-first", github });
    const reopenBody = reviewCommentBody({
      comment: { id: 101, body: "@maomao reopen", in_reply_to_id: 11, user: { login: "octocat" } },
    });
    const reopen = await handleGithubWebhook({
      config: loadConfig({
        GITHUB_WEBHOOK_SECRET: secret,
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "k",
        REVIEWER_ROLES: "correctness",
      }),
      store,
      github,
      request: {
        event: "pull_request_review_comment",
        deliveryId: "reopen",
        signature: sign(secret, reopenBody),
        rawBody: reopenBody,
      },
    });
    expect(reopen.body.command).toBe("reopen");
    expect(unresolved).toEqual(["PRRT_1"]);
    expect(store.getFinding("acme/widgets", 7, "deadbeefdeadbeef")?.status).toBe("open");
  });
});

describe("pull_request.closed merge cancellation", () => {
  const secret = "s3cret";
  const baseConfig = {
    GITHUB_WEBHOOK_SECRET: secret,
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "k",
    REVIEWER_ROLES: "correctness",
  };

  async function postClosed(
    store: JobStore,
    overrides: {
      merged?: boolean | null;
      omitMerged?: boolean;
      deliveryId?: string;
      prNumber?: number;
      dropRepo?: boolean;
      env?: Record<string, string>;
    } = {},
  ) {
    const pull: Record<string, unknown> = { number: overrides.prNumber ?? 7 };
    if (!overrides.omitMerged) pull.merged = overrides.merged ?? true;
    const payload: Record<string, unknown> = {
      action: "closed",
      installation: { id: 42, account: { id: 1001 } },
      repository: {
        id: 2002,
        full_name: "acme/widgets",
        name: "widgets",
        owner: { login: "acme", id: 1001 },
      },
      pull_request: pull,
    };
    if (overrides.dropRepo) delete payload.repository;
    const rawBody = JSON.stringify(payload);
    return handleGithubWebhook({
      config: loadConfig({ ...baseConfig, ...(overrides.env ?? {}) }),
      store,
      request: {
        event: "pull_request",
        deliveryId: overrides.deliveryId ?? "close-1",
        signature: sign(secret, rawBody),
        rawBody,
      },
    });
  }

  async function seedActiveJob(
    store: JobStore,
    state: "queued" | "reviewing" = "reviewing",
    prNumber = 7,
  ) {
    const created = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 42,
      prNumber,
      prTitle: "t",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "a",
      baseSha: "base111",
      headSha: `head-${prNumber}`,
      baseRef: "main",
      headRef: "f",
      reviewers: [{ role: "correctness", title: "Correctness" }],
    });
    if (state === "reviewing") store.setJobState(created.job.id, "reviewing");
    return created.job.id;
  }

  it("cancels every non-terminal job for the merged pull with reason pr_merged", async () => {
    const store = new JobStore(openDb(":memory:"));
    const jobId = await seedActiveJob(store, "reviewing", 7);
    const otherPull = await seedActiveJob(store, "queued", 9);

    const result = await postClosed(store, { prNumber: 7, deliveryId: "close-1" });
    expect(result.status).toBe(200);
    expect(result.body.cancelled).toBe(1);
    expect(result.body.cancelledJobIds).toEqual([jobId]);
    const job = store.getJob(jobId);
    expect(job?.state).toBe("cancelled");
    expect(job?.cancelled_reason).toBe("pr_merged");
    expect(job?.cancelled_by).toBeNull();
    expect(store.listLogs(jobId).some((line) => line.message.includes("Cancelled (pr_merged)") && line.message.includes("close-1"))).toBe(true);
    expect(store.getJob(otherPull)?.state).toBe("queued");
  });

  it("is idempotent for duplicate deliveries", async () => {
    const store = new JobStore(openDb(":memory:"));
    await seedActiveJob(store);
    const first = await postClosed(store, { deliveryId: "close-dup" });
    expect(first.body.cancelled).toBe(1);
    const second = await postClosed(store, { deliveryId: "close-dup" });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.cancelled).toBeUndefined();
    expect(store.listJobs().filter((job) => job.state === "cancelled")).toHaveLength(1);
  });

  it("ignores a closed pull without merge and never infers one", async () => {
    const store = new JobStore(openDb(":memory:"));
    const jobId = await seedActiveJob(store);
    const result = await postClosed(store, { merged: false });
    expect(result.status).toBe(202);
    expect(result.body.ignored).toBe(true);
    expect(store.getJob(jobId)?.state).toBe("reviewing");

    const uncertain = await postClosed(store, { omitMerged: true });
    expect(uncertain.status).toBe(202);
    expect(uncertain.body.ignored).toBe(true);
    expect(store.getJob(jobId)?.state).toBe("reviewing");
  });

  it("fails safe when the payload lacks repository context", async () => {
    const store = new JobStore(openDb(":memory:"));
    const jobId = await seedActiveJob(store);
    const result = await postClosed(store, { dropRepo: true });
    expect(result.status).toBe(202);
    expect(result.body.ignored).toBe(true);
    expect(store.getJob(jobId)?.state).toBe("reviewing");
  });

  it("never cancels jobs for an unauthorized installation", async () => {
    const store = new JobStore(openDb(":memory:"));
    const jobId = await seedActiveJob(store);
    const result = await postClosed(store, { env: { ALLOWED_GITHUB_ACCOUNT_IDS: "9999" } });
    expect(result.status).toBe(202);
    expect(result.body.ignored).toBe(true);
    expect(store.getJob(jobId)?.state).toBe("reviewing");
  });

  it("reports zero cancellations for a pull with no maomao jobs", async () => {
    const store = new JobStore(openDb(":memory:"));
    const result = await postClosed(store);
    expect(result.status).toBe(200);
    expect(result.body.cancelled).toBe(0);
    expect(result.body.cancelledJobIds).toEqual([]);
  });
});

describe("merge-cancellation hardening", () => {
  const secret = "s3cret";

  function activeJob(store: JobStore, headSha = "head222", prNumber = 7) {
    const created = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 42,
      prNumber,
      prTitle: "t",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "a",
      baseSha: "base111",
      headSha,
      baseRef: "main",
      headRef: "f",
      reviewers: [{ role: "correctness", title: "Correctness" }],
    });
    return created.job.id;
  }

  it("rejects an invalid signature on closed deliveries before touching queue state", async () => {
    const store = new JobStore(openDb(":memory:"));
    const jobId = activeJob(store);
    const rawBody = JSON.stringify({
      action: "closed",
      installation: { id: 42 },
      repository: { id: 2002, full_name: "acme/widgets", name: "widgets", owner: { login: "acme" } },
      pull_request: { number: 7, merged: true },
    });
    const result = await handleGithubWebhook({
      config: loadConfig({ GITHUB_WEBHOOK_SECRET: secret, REVIEWER_ROLES: "correctness" }),
      store,
      request: {
        event: "pull_request",
        deliveryId: "bad-sig",
        signature: "sha256=deadbeef",
        rawBody,
      },
    });
    expect(result.status).toBe(401);
    expect(store.getJob(jobId)?.state).toBe("queued");
  });

  it("refuses to enqueue new work for a pull whose merge already cancelled a job", async () => {
    const store = new JobStore(openDb(":memory:"));
    const jobId = activeJob(store);
    const config = loadConfig({
      GITHUB_WEBHOOK_SECRET: secret,
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "k",
      REVIEWER_ROLES: "correctness",
    });
    const closedBody = JSON.stringify({
      action: "closed",
      installation: { id: 42, account: { id: 1001 } },
      repository: { id: 2002, full_name: "acme/widgets", name: "widgets", owner: { login: "acme", id: 1001 } },
      pull_request: { number: 7, merged: true },
    });
    const closed = await handleGithubWebhook({
      config,
      store,
      request: { event: "pull_request", deliveryId: "close-1", signature: sign(secret, closedBody), rawBody: closedBody },
    });
    expect(closed.body.cancelled).toBe(1);
    expect(store.hasMergedPull("acme/widgets", 7)).toBe(true);

    // A delayed synchronize (push raced the merge button) arrives after the close.
    const latePushBody = JSON.stringify({
      action: "synchronize",
      installation: { id: 42, account: { id: 1001 } },
      repository: { id: 2002, full_name: "acme/widgets", name: "widgets", owner: { login: "acme", id: 1001 } },
      pull_request: {
        number: 7,
        user: { login: "dev" },
        base: { sha: "base111", ref: "main" },
        head: { sha: "late-push", ref: "feature" },
      },
    });
    const late = await handleGithubWebhook({
      config,
      store,
      request: { event: "pull_request", deliveryId: "late-push", signature: sign(secret, latePushBody), rawBody: latePushBody },
    });
    expect(late.status).toBe(202);
    expect(late.body.ignored).toBe(true);
    expect(store.findLatestJobForPull("acme/widgets", 7, "late-push")).toBeUndefined();
    expect(store.getJob(jobId)?.state).toBe("cancelled");
  });
});

describe("merged-pull marker with no active jobs", () => {
  const secret = "s3cret";
  const config = loadConfig({
    GITHUB_WEBHOOK_SECRET: secret,
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "k",
    REVIEWER_ROLES: "correctness",
  });

  function payload(action: string, pr: Record<string, unknown>) {
    return JSON.stringify({
      action,
      installation: { id: 42, account: { id: 1001 } },
      repository: { id: 2002, full_name: "acme/widgets", name: "widgets", owner: { login: "acme", id: 1001 } },
      pull_request: pr,
    });
  }

  async function deliver(store: JobStore, rawBody: string, deliveryId: string) {
    return handleGithubWebhook({
      config,
      store,
      request: { event: "pull_request", deliveryId, signature: sign(secret, rawBody), rawBody },
    });
  }

  it("marks the pull merged even when every job was already completed", async () => {
    const store = new JobStore(openDb(":memory:"));
    const jobId = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 42,
      prNumber: 7,
      prTitle: "t",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "a",
      baseSha: "base111",
      headSha: "head222",
      baseRef: "main",
      headRef: "f",
      reviewers: [{ role: "correctness", title: "Correctness" }],
    }).job.id;
    store.setJobState(jobId, "reviewing");
    store.setJobState(jobId, "completed");

    const closeResult = await deliver(store, payload("closed", { number: 7, merged: true }), "close-done");
    expect(closeResult.status).toBe(200);
    expect(closeResult.body.cancelled).toBe(0);
    expect(store.hasMergedPull("acme/widgets", 7)).toBe(true);

    // A late synchronize for a SHA that never produced a job must not enqueue.
    const late = await deliver(
      store,
      payload("synchronize", {
        number: 7,
        user: { login: "dev" },
        base: { sha: "base111", ref: "main" },
        head: { sha: "late-2", ref: "feature" },
      }),
      "late-2",
    );
    expect(late.body.ignored).toBe(true);
    expect(store.findLatestJobForPull("acme/widgets", 7, "late-2")).toBeUndefined();
  });

  it("marks the pull merged when it has no maomao jobs at all", async () => {
    const store = new JobStore(openDb(":memory:"));
    const closeResult = await deliver(store, payload("closed", { number: 11, merged: true }), "close-empty");
    expect(closeResult.status).toBe(200);
    expect(closeResult.body.cancelled).toBe(0);
    expect(store.hasMergedPull("acme/widgets", 11)).toBe(true);
    const late = await deliver(
      store,
      payload("synchronize", {
        number: 11,
        user: { login: "dev" },
        base: { sha: "base111", ref: "main" },
        head: { sha: "late-3", ref: "feature" },
      }),
      "late-3",
    );
    expect(late.body.ignored).toBe(true);
    expect(store.findLatestJobForPull("acme/widgets", 11, "late-3")).toBeUndefined();
  });

  it("does not let a manually cancelled job block later reviews (marker is merge-only)", async () => {
    const store = new JobStore(openDb(":memory:"));
    const jobId = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 42,
      prNumber: 12,
      prTitle: "t",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "a",
      baseSha: "base111",
      headSha: "head222",
      baseRef: "main",
      headRef: "f",
      reviewers: [{ role: "correctness", title: "Correctness" }],
    }).job.id;
    store.cancelJobs({ jobId }, "manual_dequeue", "octocat");
    expect(store.hasMergedPull("acme/widgets", 12)).toBe(false);
  });

  it("refuses an escalate command aimed at a cancelled job", async () => {
    const store = new JobStore(openDb(":memory:"));
    const jobId = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 42,
      prNumber: 7,
      prTitle: "t",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "a",
      baseSha: "base111",
      headSha: "head222",
      baseRef: "main",
      headRef: "f",
      reviewers: [{ role: "correctness", title: "Correctness" }],
    }).job.id;
    store.cancelJobs({ jobId }, "pr_merged", null);

    const escalateBody = JSON.stringify({
      action: "created",
      installation: { id: 42 },
      repository: { full_name: "acme/widgets", name: "widgets", owner: { login: "acme" } },
      issue: { number: 7, pull_request: { url: "https://github.com/acme/widgets/pull/7" } },
      comment: {
        id: 9001,
        body: "@maomao escalate",
        user: { login: "octocat", type: "User" },
        author_association: "CONTRIBUTOR",
      },
    });
    const github = {
      getCollaboratorPermission: async () => "write",
    } as unknown as GithubPort;
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "esc-1", signature: sign(secret, escalateBody), rawBody: escalateBody },
    });
    expect(result.status).toBe(202);
    expect(result.body.ignored).toBe(true);
    expect(result.body.reason).toContain("cancelled");
    expect(store.getJob(jobId)?.manual_escalate_requested).toBeFalsy();
  });
});

// ---- Timed review pause + deterministic stack commands (issue #99) ----

function commentPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "created",
    installation: { id: 42, account: { id: 1001 } },
    repository: { id: 2002, full_name: "acme/widgets", name: "widgets", owner: { login: "acme", id: 1001 } },
    issue: { number: 42, pull_request: { url: "https://github.com/acme/widgets/pull/42" } },
    comment: {
      id: 9001,
      body: "issue 1 of 2 in stack ship-it",
      user: { login: "alice", type: "User" },
      author_association: "OWNER",
    },
    ...overrides,
  };
}

function resolvedStackPull(prNumber: number, overrides: Record<string, unknown> = {}) {
  return {
    installationId: 42,
    accountId: 1001,
    repositoryId: 2002,
    repoOwner: "acme",
    repoName: "widgets",
    repoFullName: "acme/widgets",
    prNumber,
    prTitle: `PR ${prNumber}`,
    prBody: "",
    prHtmlUrl: `https://github.com/acme/widgets/pull/${prNumber}`,
    prAuthor: "alice",
    baseSha: `base${prNumber}`,
    headSha: `head${prNumber}`,
    baseRef: "main",
    headRef: `feat-${prNumber}`,
    headRepoFullName: "acme/widgets",
    draft: false,
    ...overrides,
  };
}

function stackGithub(overrides: {
  permission?: RepoPermission;
  pulls?: Record<number, ReturnType<typeof resolvedStackPull> | undefined>;
  comments?: { pullNumber: number; body: string }[];
  openPulls?: ReturnType<typeof resolvedStackPull>[];
} = {}) {
  const comments = overrides.comments ?? [];
  const github = {
    ...githubForCommands({ permission: overrides.permission ?? "write" }),
    listOpenPulls: async () => overrides.openPulls ?? [],
    listIssueComments: async (_i: number, _o: string, _r: string, pullNumber: number) =>
      comments
        .map((c, index) => ({ id: index + 1, body: c.body, pullNumber: c.pullNumber }))
        .filter((c) => c.pullNumber === pullNumber)
        .map((c) => ({ id: c.id, body: c.body })),
    createIssueComment: async (input: { pullNumber: number; body: string }) => {
      comments.push({ pullNumber: input.pullNumber, body: input.body });
      return { id: `${comments.length}`, url: "u" };
    },
    updateIssueComment: async (input: { commentId: number; body: string }) => {
      const target = comments[input.commentId - 1];
      if (!target) throw new Error(`no comment ${input.commentId}`);
      target.body = input.body;
      return { id: String(input.commentId), url: "u" };
    },
    getPull: async (_installationId: number, _owner: string, _repo: string, n: number) => {
      const pull = overrides.pulls?.[n];
      if (!pull) throw new Error(`no pull #${n}`);
      return pull;
    },
  };
  return { github: github as unknown as GithubPort, comments };
}

describe("timed review pause (issue #99)", () => {
  it("skips automatic pull_request deliveries while paused and resumes after expiry", async () => {
    const secret = "s3cret";
    const config = loadConfig({
      GITHUB_WEBHOOK_SECRET: secret,
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "k",
      REVIEWER_ROLES: "correctness",
    });
    const store = new JobStore(openDb(":memory:"));
    store.createPause({ repoFullName: "acme/widgets", actor: "alice", durationMs: 60_000 });

    const body = JSON.stringify(prPayload());
    const paused = await handleGithubWebhook({
      config,
      store,
      request: { event: "pull_request", deliveryId: "p1", signature: sign(secret, body), rawBody: body },
    });
    expect(paused.status).toBe(202);
    expect(paused.body.ignored).toBe(true);
    expect(String(paused.body.reason)).toMatch(/paused/i);
    expect(store.listJobs(10)).toHaveLength(0);
    // The skip is claimed on the delivery row — a retry cannot slip a job in.
    expect(store.hasWebhookDelivery("p1")).toBe(true);
    const dup = await handleGithubWebhook({
      config,
      store,
      request: { event: "pull_request", deliveryId: "p1", signature: sign(secret, body), rawBody: body },
    });
    expect(dup.body.duplicate ?? dup.body.ignored).toBeTruthy();
    expect(store.listJobs(10)).toHaveLength(0);

    // An expired pause stops matching with no backfill — a NEW delivery
    // enqueues normally; the skipped delivery is never replayed.
    store.createPause({ repoFullName: "acme/widgets", actor: "alice", durationMs: -1 });
    const expired = await handleGithubWebhook({
      config,
      store,
      request: { event: "pull_request", deliveryId: "p2", signature: sign(secret, body), rawBody: body },
    });
    expect(expired.body.created).toBe(true);
    expect(store.listJobs(10)).toHaveLength(1);
  });

  it("skips every pull_request delivery while the global pause switch is on", async () => {
    const secret = "s3cret";
    const config = loadConfig({
      GITHUB_WEBHOOK_SECRET: secret,
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "k",
      REVIEWER_ROLES: "correctness",
    });
    const store = new JobStore(openDb(":memory:"));
    store.setGlobalPause("alice");

    const body = JSON.stringify(prPayload());
    const paused = await handleGithubWebhook({
      config,
      store,
      request: { event: "pull_request", deliveryId: "g1", signature: sign(secret, body), rawBody: body },
    });
    expect(paused.body.ignored).toBe(true);
    expect(String(paused.body.reason)).toMatch(/paused globally/);
    expect(store.listJobs(10)).toHaveLength(0);
    expect(store.hasWebhookDelivery("g1")).toBe(true);

    // A different repo is skipped the same way — the switch is instance-wide.
    const other = JSON.stringify(prPayload({ repository: { full_name: "acme/other", name: "other", owner: { login: "acme" } } }));
    const second = await handleGithubWebhook({
      config,
      store,
      request: { event: "pull_request", deliveryId: "g2", signature: sign(secret, other), rawBody: other },
    });
    expect(second.body.ignored).toBe(true);
    expect(store.listJobs(10)).toHaveLength(0);

    // Resuming restores normal handling of new deliveries.
    store.endGlobalPause("alice");
    const resumed = await handleGithubWebhook({
      config,
      store,
      request: { event: "pull_request", deliveryId: "g3", signature: sign(secret, body), rawBody: body },
    });
    expect(resumed.body.created).toBe(true);
    expect(store.listJobs(10)).toHaveLength(1);
  });
});

describe("stack commands (issue #99)", () => {
  const stackConfig = (secret: string, extra: Record<string, string> = {}) =>
    loadConfig({
      GITHUB_WEBHOOK_SECRET: secret,
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "k",
      REVIEWER_ROLES: "correctness",
      ...extra,
    });

  it("records a declaration for an authorized human and answers on the PR", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    const { github, comments } = stackGithub();
    const body = JSON.stringify(commentPayload());
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "c1", signature: sign(secret, body), rawBody: body },
    });
    expect(result.status).toBe(200);
    const decls = store.listStackDeclarations("acme/widgets", "ship-it");
    expect(decls).toHaveLength(1);
    expect(decls[0]?.pr_number).toBe(42);
    expect(decls[0]?.position).toBe(1);
    // Success posts no reply — the marker comment is the only trace.
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("maomao-stack:ship-it");
  });

  it("ignores a non-allowlisted bot and accepts one from MAOMAO_STACK_AUTHORS", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret, { MAOMAO_STACK_AUTHORS: "ci-bot[bot]" });
    const store = new JobStore(openDb(":memory:"));
    const botComment = (id: number, login: string) =>
      JSON.stringify(
        commentPayload({
          comment: { id, body: "issue 1 of 2 in stack ship-it", user: { login, type: "Bot" }, author_association: "NONE" },
        }),
      );
    const denied = await handleGithubWebhook({
      config,
      store,
      github: stackGithub().github,
      request: { event: "issue_comment", deliveryId: "b1", signature: sign(secret, botComment(1, "other[bot]")), rawBody: botComment(1, "other[bot]") },
    });
    expect(denied.body.ignored).toBe(true);
    expect(store.listStackDeclarations("acme/widgets", "ship-it")).toHaveLength(0);

    const { github, comments } = stackGithub();
    const allowed = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "b2", signature: sign(secret, botComment(2, "ci-bot[bot]")), rawBody: botComment(2, "ci-bot[bot]") },
    });
    expect(allowed.status).toBe(200);
    expect(store.listStackDeclarations("acme/widgets", "ship-it")).toHaveLength(1);
    expect(comments.length).toBe(1);
    expect(comments.filter((c) => c.body.includes("maomao-stack:ship-it"))).toHaveLength(1);
  });

  it("validates the whole stack and enqueues exactly one stack_review job", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackDeclaration({ repoFullName: "acme/widgets", stackId: "ship-it", prNumber: 41, position: 1, expectedCount: 2, actor: "alice" });
    store.upsertStackDeclaration({ repoFullName: "acme/widgets", stackId: "ship-it", prNumber: 42, position: 2, expectedCount: 2, actor: "alice" });

    const pulls = {
      41: resolvedStackPull(41, { baseRef: "main", headRef: "feat-a", baseSha: "m0", headSha: "h41" }),
      42: resolvedStackPull(42, { baseRef: "feat-a", headRef: "feat-b", baseSha: "h41", headSha: "h42" }),
    };
    const { github, comments } = stackGithub({ pulls });
    const topBody = JSON.stringify(
      commentPayload({ comment: { id: 42, body: "@maomao top of stack ship-it: #41, #42", user: { login: "alice", type: "User" }, author_association: "OWNER" } }),
    );
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "t1", signature: sign(secret, topBody), rawBody: topBody },
    });
    expect(result.status).toBe(200);
    expect(result.body.enqueued).toBe(true);
    const jobs = store.listJobs(10).filter((j) => j.job_type === "stack_review");
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.dedup_key).toMatch(/^stack:ship-it@[0-9a-f]{12}$/);
    expect(job.pr_number).toBe(42);
    const members = store.listStackMembers(job.id);
    expect(members.map((m) => m.pr_number)).toEqual([41, 42]);
    expect(members[1]?.head_sha).toBe("h42");
    // No reply chatter — just the edited marker comment on each member.
    const markers = comments.filter((c) => c.body.includes("maomao-stack:ship-it"));
    expect(markers.map((c) => c.pullNumber).sort()).toEqual([41, 42]);
    expect(comments).toHaveLength(2);

    // A re-trigger dedups on the same SHA vector — still exactly one job.
    const again = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "t2", signature: sign(secret, topBody.replace('"id":42,"body"', '"id":43,"body"')), rawBody: topBody.replace('"id":42,"body"', '"id":43,"body"') },
    });
    expect(again.body.enqueued).toBe(false);
    expect(store.listJobs(10).filter((j) => j.job_type === "stack_review")).toHaveLength(1);
    const commentCountAfter = comments.length;

    // A redelivery of the SAME trigger comment is deduped by comment id: no
    // second reply, no extra work.
    const redelivered = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "t3", signature: sign(secret, topBody), rawBody: topBody },
    });
    expect(redelivered.body.duplicate).toBe(true);
    expect(comments.length).toBe(commentCountAfter);
  });

  it("posts one actionable error comment on an invalid trigger and enqueues nothing", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    const pulls = {
      41: resolvedStackPull(41),
      42: resolvedStackPull(42, { baseRef: "feat-41" }),
    };
    const { github, comments } = stackGithub({ pulls });
    const body = JSON.stringify(
      commentPayload({ comment: { id: 77, body: "top of stack ghost: #41, #42", user: { login: "alice", type: "User" }, author_association: "OWNER" } }),
    );
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "e1", signature: sign(secret, body), rawBody: body },
    });
    expect(result.status).toBe(200);
    expect(result.body.enqueued).toBe(false);
    expect(store.listJobs(10)).toHaveLength(0);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toMatch(/never declared/);
  });

  it("dedupes repeated comment deliveries", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    const { github, comments } = stackGithub();
    const body = JSON.stringify(commentPayload());
    await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "d1", signature: sign(secret, body), rawBody: body },
    });
    const dup = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "d2", signature: sign(secret, body), rawBody: body },
    });
    expect(dup.body.duplicate).toBe(true);
    expect(store.listStackDeclarations("acme/widgets", "ship-it")).toHaveLength(1);
    // One marker comment from the first delivery; the duplicate adds nothing.
    expect(comments).toHaveLength(1);
    expect(comments.filter((c) => c.body.includes("maomao-stack:ship-it"))).toHaveLength(1);
  });

  it("keeps one marker comment per member PR and edits it as the stack grows", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    const { github, comments } = stackGithub();
    const declareOn = (n: number, position: number, commentId: number) =>
      JSON.stringify(
        commentPayload({
          issue: { number: n, pull_request: { url: `https://github.com/acme/widgets/pull/${n}` } },
          comment: {
            id: commentId,
            body: `issue ${position} of 2 in stack ship-it`,
            user: { login: "alice", type: "User" },
            author_association: "OWNER",
          },
        }),
      );

    const first = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "m1", signature: sign(secret, declareOn(41, 1, 1)), rawBody: declareOn(41, 1, 1) },
    });
    expect(first.status).toBe(200);
    const markerOn41 = comments.filter((c) => c.pullNumber === 41 && c.body.includes("maomao-stack:ship-it"));
    expect(markerOn41).toHaveLength(1);
    expect(markerOn41[0]?.body).toContain("issue 1 of 2");

    // A second declaration edits the existing marker comments in place rather
    // than posting new ones — still exactly one marker comment per PR.
    const second = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "m2", signature: sign(secret, declareOn(42, 2, 2)), rawBody: declareOn(42, 2, 2) },
    });
    expect(second.status).toBe(200);
    const markers = comments.filter((c) => c.body.includes("maomao-stack:ship-it"));
    expect(markers.map((c) => c.pullNumber).sort()).toEqual([41, 42]);
    expect(markers.find((c) => c.pullNumber === 41)?.body).toContain("#42");
    expect(markers.find((c) => c.pullNumber === 42)?.body).toContain("issue 2 of 2");
    expect(markers.find((c) => c.pullNumber === 42)?.body).toContain("top of the stack");
  });

  it("writes the pinned SHA vector into every member comment on a valid trigger", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackDeclaration({ repoFullName: "acme/widgets", stackId: "ship-it", prNumber: 41, position: 1, expectedCount: 2, actor: "alice" });
    store.upsertStackDeclaration({ repoFullName: "acme/widgets", stackId: "ship-it", prNumber: 42, position: 2, expectedCount: 2, actor: "alice" });
    const pulls = {
      41: resolvedStackPull(41, { baseRef: "main", headRef: "feat-a", baseSha: "m0", headSha: "h41" }),
      42: resolvedStackPull(42, { baseRef: "feat-a", headRef: "feat-b", baseSha: "h41", headSha: "h42" }),
    };
    const { github, comments } = stackGithub({ pulls });
    const body = JSON.stringify(
      commentPayload({ comment: { id: 42, body: "top of stack ship-it: #41, #42", user: { login: "alice", type: "User" }, author_association: "OWNER" } }),
    );
    await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "t1", signature: sign(secret, body), rawBody: body },
    });
    const markers = comments.filter((c) => c.body.includes("maomao-stack:ship-it"));
    expect(markers.map((c) => c.pullNumber).sort()).toEqual([41, 42]);
    expect(markers.find((c) => c.pullNumber === 41)?.body).toContain("h41");
    expect(markers.find((c) => c.pullNumber === 42)?.body).toContain("h42");
  });

  const chainPulls = () => [
    resolvedStackPull(41, { baseRef: "main", headRef: "feat-a", baseSha: "m0", headSha: "h41" }),
    resolvedStackPull(42, { baseRef: "feat-a", headRef: "feat-b", baseSha: "h41", headSha: "h42" }),
    resolvedStackPull(43, { baseRef: "feat-b", headRef: "feat-c", baseSha: "h42", headSha: "h43" }),
  ];
  const stackCommentOn = (n: number, body: string, commentId = 9001) =>
    JSON.stringify(
      commentPayload({
        issue: { number: n, pull_request: { url: `https://github.com/acme/widgets/pull/${n}` } },
        comment: { id: commentId, body, user: { login: "alice", type: "User" }, author_association: "OWNER" },
      }),
    );

  it("marks the stack base with 'start of stack' and a pending marker comment", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    const { github, comments } = stackGithub();
    const body = stackCommentOn(41, "@maomao start of stack u1");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "s1", signature: sign(secret, body), rawBody: body },
    });
    expect(result.status).toBe(200);
    expect(store.getStackStart("acme/widgets", "u1")?.pr_number).toBe(41);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.pullNumber).toBe(41);
    expect(comments[0]?.body).toContain("maomao-stack:u1");
    expect(comments[0]?.body).toContain("base of review stack");
  });

  it("resolves a start/end stack by branch layout and enqueues one review", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const { github, comments } = stackGithub({ openPulls: chainPulls() });
    const body = stackCommentOn(43, "@maomao end of stack u1");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "e1", signature: sign(secret, body), rawBody: body },
    });
    expect(result.status).toBe(200);
    expect(result.body.enqueued).toBe(true);
    const jobs = store.listJobs(10).filter((j) => j.job_type === "stack_review");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.dedup_key).toMatch(/^stack:u1@[0-9a-f]{12}$/);;
    expect(store.listStackMembers(jobs[0]!.id).map((m) => m.pr_number)).toEqual([41, 42, 43]);
    // Resolved members are recorded as declarations too.
    expect(store.listStackDeclarations("acme/widgets", "u1").map((d) => d.pr_number)).toEqual([41, 42, 43]);
    const markers = comments.filter((c) => c.body.includes("maomao-stack:u1"));
    expect(markers.map((c) => c.pullNumber).sort()).toEqual([41, 42, 43]);
    expect(markers.find((c) => c.pullNumber === 41)?.body).toContain("issue 1 of 3");
    expect(markers.find((c) => c.pullNumber === 43)?.body).toContain("top of the stack");
  });

  it("infers the stack id on a bare 'end of stack' from the start marker at the chain base", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const { github } = stackGithub({ openPulls: chainPulls() });
    const body = stackCommentOn(43, "end of stack");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "e2", signature: sign(secret, body), rawBody: body },
    });
    expect(result.body.enqueued).toBe(true);
    expect(store.listJobs(10)[0]?.dedup_key).toMatch(/^stack:u1@[0-9a-f]{12}$/);;
  });

  it("errors on 'end of stack' with no start marker or a broken chain", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    const { github, comments } = stackGithub({ openPulls: chainPulls() });
    const body = stackCommentOn(43, "end of stack ghost");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "e3", signature: sign(secret, body), rawBody: body },
    });
    expect(result.body.enqueued).toBe(false);
    expect(comments[0]?.body).toMatch(/no "start of stack/);
    expect(store.listJobs(10)).toHaveLength(0);
  });

  it("replies with usage on a malformed stack command but stays silent for unauthorized actors", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    const { github, comments } = stackGithub();
    const body = stackCommentOn(42, "@maomao top of stack : broken words");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "x1", signature: sign(secret, body), rawBody: body },
    });
    expect(result.status).toBe(200);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toMatch(/Not a stack command/);
    expect(comments[0]?.body).toContain("start of stack");

    const botBody = stackCommentOn(42, "top of stack : also broken", 9002).replace('"login":"alice"', '"login":"other[bot]"').replace('"type":"User"', '"type":"Bot"');
    const denied = await handleGithubWebhook({
      config,
      store,
      github: stackGithub().github,
      request: { event: "issue_comment", deliveryId: "x2", signature: sign(secret, botBody), rawBody: botBody },
    });
    expect(denied.body.ignored).toBe(true);
  });

  const markedPr = (bodyText: string, prOverrides: Record<string, unknown> = {}) =>
    JSON.stringify(
      prPayload({ pull_request: { ...prPayload().pull_request, body: bodyText, ...prOverrides } }),
    );

  it("suppresses automatic review when the PR body carries a 'part of stack' marker", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    const { github } = stackGithub();
    const rawBody = markedPr("Adds the thing.\n\n<!-- part of stack u1 -->\n");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "m1", signature: sign(secret, rawBody), rawBody },
    });
    expect(result.status).toBe(200);
    expect(result.body.ignored).toBe(true);
    expect(result.body.reason).toContain("part of stack");
    expect(store.listJobs(10)).toHaveLength(0);
  });

  it("records a start marker from the PR body and leaves a pending marker comment", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    const { github, comments } = stackGithub();
    const rawBody = markedPr("Adds the base.\n\n<!-- start of stack u1 -->");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "m2", signature: sign(secret, rawBody), rawBody },
    });
    expect(result.status).toBe(200);
    expect(store.getStackStart("acme/widgets", "u1")?.pr_number).toBe(7);
    expect(comments[0]?.body).toContain("maomao-stack:u1");
    expect(store.listJobs(10)).toHaveLength(0);
  });

  it("resolves 'end of stack' from the PR body and enqueues the stack review", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const { github } = stackGithub({ openPulls: chainPulls() });
    const rawBody = markedPr("Adds the top.\n\n<!-- end of stack u1 -->", {
      number: 43,
      base: { sha: "h42", ref: "feat-b" },
      head: { sha: "h43", ref: "feat-c" },
    });
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "m3", signature: sign(secret, rawBody), rawBody },
    });
    expect(result.status).toBe(200);
    expect(result.body.enqueued).toBe(true);
    const jobs = store.listJobs(10).filter((j) => j.job_type === "stack_review");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.dedup_key).toMatch(/^stack:u1@[0-9a-f]{12}$/);;
    expect(store.listStackMembers(jobs[0]!.id).map((m) => m.pr_number)).toEqual([41, 42, 43]);
  });

  it("reviews normally when the body marker's author is not authorized", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    // "read" is explicit and weaker than write — never upgraded.
    const { github } = stackGithub({ permission: "read" });
    const rawBody = markedPr("@maomao part of stack u1");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "m4", signature: sign(secret, rawBody), rawBody },
    });
    expect(result.body.created).toBe(true);
    expect(store.listJobs(10)).toHaveLength(1);
  });

  it("posts usage but still reviews a PR whose body has a malformed stack marker", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    const { github, comments } = stackGithub();
    const rawBody = markedPr("Adds the thing.\n\n<!-- end of stack : misconfigured -->\n");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "m5", signature: sign(secret, rawBody), rawBody },
    });
    expect(result.body.created).toBe(true);
    expect(comments.some((c) => c.body.includes("Not a stack command"))).toBe(true);
    expect(store.listJobs(10)).toHaveLength(1);
  });

  it("reuses the existing stack id on a repeated bare 'start' body marker", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    const { github } = stackGithub();
    const rawBody = markedPr("<!-- start of stack -->");
    for (const [i, action] of ["opened", "synchronize"].entries()) {
      await handleGithubWebhook({
        config,
        store,
        github,
        request: {
          event: "pull_request",
          deliveryId: `m6-${i}`,
          signature: sign(secret, JSON.stringify({ ...JSON.parse(rawBody), action })),
          rawBody: JSON.stringify({ ...JSON.parse(rawBody), action }),
        },
      });
    }
    const starts = store.listStackStartsForPull("acme/widgets", 7);
    expect(starts).toHaveLength(1);
    expect(starts[0]!.stack_id).toMatch(/^stack-[0-9a-f]{8}$/);
  });

  it("resolves the chain through the payload copy when the API has not listed the trigger PR", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    // openPulls lacks #43 — the payload's ResolvedPull must splice in.
    const { github } = stackGithub({ openPulls: chainPulls().slice(0, 2) });
    const rawBody = markedPr("<!-- end of stack u1 -->", {
      number: 43,
      base: { sha: "h42", ref: "feat-b" },
      head: { sha: "h43", ref: "feat-c" },
    });
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "m7", signature: sign(secret, rawBody), rawBody },
    });
    expect(result.body.enqueued).toBe(true);
    expect(store.listStackMembers(store.listJobs(10)[0]!.id).map((m) => m.pr_number)).toEqual([41, 42, 43]);
  });

  it("pins the payload SHA over a stale API listing on synchronize", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const stale = chainPulls().map((p) => (p.prNumber === 43 ? { ...p, headSha: "stale43" } : p));
    const { github } = stackGithub({ openPulls: stale });
    const rawBody = JSON.stringify({
      ...prPayload({ pull_request: { ...prPayload().pull_request, number: 43, base: { sha: "h42", ref: "feat-b" }, head: { sha: "fresh43", ref: "feat-c" }, body: "<!-- end of stack u1 -->" } }),
      action: "synchronize",
    });
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "m8", signature: sign(secret, rawBody), rawBody },
    });
    expect(result.body.enqueued).toBe(true);
    expect(result.enqueue?.job.head_sha).toBe("fresh43");
  });

  it("rejects an 'end of stack' that is not the top of its chain", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const above = resolvedStackPull(44, { baseRef: "feat-c", headRef: "feat-d", headSha: "h44" });
    const { github, comments } = stackGithub({ openPulls: [...chainPulls(), above] });
    const body = stackCommentOn(43, "end of stack u1");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "m9", signature: sign(secret, body), rawBody: body },
    });
    expect(result.body.enqueued).toBe(false);
    expect(comments[0]?.body).toMatch(/not the top/);
    expect(store.listJobs(10)).toHaveLength(0);
  });

  it("honors the repo pause and rate limiter for 'end of stack' body markers", async () => {
    const secret = "s3cret";
    const paused = stackConfig(secret);
    const pausedStore = new JobStore(openDb(":memory:"));
    pausedStore.createPause({ repoFullName: "acme/widgets", actor: "alice", durationMs: 60_000 });
    pausedStore.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const { github: pausedGithub, comments: pausedComments } = stackGithub({ openPulls: chainPulls() });
    const pausedBody = markedPr("<!-- end of stack u1 -->", {
      number: 43,
      base: { sha: "h42", ref: "feat-b" },
      head: { sha: "h43", ref: "feat-c" },
    });
    const pausedResult = await handleGithubWebhook({
      config: paused,
      store: pausedStore,
      github: pausedGithub,
      request: { event: "pull_request", deliveryId: "m10", signature: sign(secret, pausedBody), rawBody: pausedBody },
    });
    // The pause still blocks both the stack trigger and the fall-through
    // review — quietly: automatic denies claim+log, no PR comment (#130).
    expect(pausedResult.body.created).not.toBe(true);
    expect(pausedComments).toHaveLength(0);
    expect(pausedStore.listJobs(10)).toHaveLength(0);

    // Rate limit: burn the single slot on an unmarked PR, then the end marker
    // must be limited instead of enqueueing a stack review.
    const limited = stackConfig(secret, { REPO_RATE_LIMIT_PER_WINDOW: "1", REPO_RATE_WINDOW_MS: "60000" });
    const limitedStore = new JobStore(openDb(":memory:"));
    limitedStore.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const limiter = new RepoRateLimiter();
    const { github: limitedGithub, comments: limitedComments } = stackGithub({ openPulls: chainPulls() });
    const burn = JSON.stringify(prPayload());
    await handleGithubWebhook({
      config: limited,
      store: limitedStore,
      github: limitedGithub,
      rateLimiter: limiter,
      request: { event: "pull_request", deliveryId: "m11", signature: sign(secret, burn), rawBody: burn },
    });
    const limitedBody = markedPr("<!-- end of stack u1 -->", {
      number: 43,
      base: { sha: "h42", ref: "feat-b" },
      head: { sha: "h43", ref: "feat-c" },
    });
    const limitedResult = await handleGithubWebhook({
      config: limited,
      store: limitedStore,
      github: limitedGithub,
      rateLimiter: limiter,
      request: { event: "pull_request", deliveryId: "m12", signature: sign(secret, limitedBody), rawBody: limitedBody },
    });
    // Rate limit still blocks: stack trigger errors and the fall-through
    // review hits the same limiter in the normal path — both quietly (#130).
    expect(limitedResult.body.created).not.toBe(true);
    expect(limitedComments).toHaveLength(0);
    expect(limitedStore.listJobs(10).filter((j) => j.job_type === "stack_review")).toHaveLength(0);
  });

  it("charges a stack once per window — same-stack re-triggers supersede for free", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret, { REPO_RATE_LIMIT_PER_WINDOW: "1", REPO_RATE_WINDOW_MS: "60000" });
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u2", prNumber: 41, actor: "alice" });
    const limiter = new RepoRateLimiter();
    const { github, comments } = stackGithub({ openPulls: chainPulls() });
    const send = async (rawBody: string, deliveryId: string) =>
      handleGithubWebhook({
        config,
        store,
        github,
        rateLimiter: limiter,
        request: { event: "pull_request", deliveryId, signature: sign(secret, rawBody), rawBody },
      });

    // First stack enqueue charges the repo slot once.
    const endBody = markedPr("<!-- end of stack u1 -->", {
      number: 43,
      base: { sha: "h42", ref: "feat-b" },
      head: { sha: "h43", ref: "feat-c" },
    });
    await send(endBody, "m40");
    expect(store.listJobs(10).filter((j) => j.job_type === "stack_review")).toHaveLength(1);

    // The slot is spent: an unmarked PR is rate limited now.
    const burn = JSON.stringify(prPayload());
    const burned = await send(burn, "m41");
    expect(burned.body).toEqual({ ok: true, ignored: true, reason: "rate limited" });

    // A mid push re-triggers the same stack: membership unchanged, the
    // recheck of the still-queued job is free despite the full window (#131
    // re-pins in place — no new row, no stale) — and stays comment-quiet.
    const push = JSON.stringify({
      ...JSON.parse(markedPr("<!-- start of stack u1 -->", { number: 41, base: { sha: "m0", ref: "main" }, head: { sha: "h41b", ref: "feat-a" } })),
      action: "synchronize",
    });
    const retrigger = await send(push, "m42");
    expect(retrigger.body.rechecked).toBe(true);
    const stackJobs = store.listJobs(10).filter((j) => j.job_type === "stack_review");
    expect(stackJobs).toHaveLength(1);
    expect(stackJobs[0]?.state).toBe("queued");
    expect(comments.every((c) => !/rate limited/.test(c.body))).toBe(true);

    // A different stack has no paid marker in the window and is still denied.
    const otherStack = markedPr("<!-- end of stack u2 -->", {
      number: 43,
      base: { sha: "h42", ref: "feat-b" },
      head: { sha: "h43b", ref: "feat-c" },
    });
    await send(otherStack, "m43");
    expect(
      store
        .listJobs(10)
        .filter((j) => j.job_type === "stack_review" && j.dedup_key.startsWith("stack:u2")),
    ).toHaveLength(0);
    expect(comments.every((c) => !/rate limited/.test(c.body))).toBe(true);
  });

  it("records a 'issue X of Y' declaration from the PR body and suppresses the review", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    const { github, comments } = stackGithub();
    const rawBody = markedPr("Adds the base.\n\n<!-- issue 1 of 2 in stack u1 -->", {
      number: 41,
      base: { sha: "m0", ref: "main" },
      head: { sha: "h41", ref: "feat-a" },
    });
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "m20", signature: sign(secret, rawBody), rawBody },
    });
    expect(result.status).toBe(200);
    expect(result.body.command).toBe("declare");
    expect(result.body.recorded).toBe(true);
    expect(store.listStackDeclarations("acme/widgets", "u1").map((d) => d.pr_number)).toEqual([41]);
    expect(comments.some((c) => c.pullNumber === 41 && c.body.includes("maomao-stack:u1"))).toBe(true);
    expect(store.listJobs(10)).toHaveLength(0);
  });

  it("replies and falls back to the normal review on a conflicting body declaration", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackDeclaration({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, position: 2, expectedCount: 2, actor: "alice" });
    const { github, comments } = stackGithub();
    const rawBody = markedPr("<!-- issue 1 of 2 in stack u1 -->", {
      number: 41,
      base: { sha: "m0", ref: "main" },
      head: { sha: "h41", ref: "feat-a" },
    });
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "m21", signature: sign(secret, rawBody), rawBody },
    });
    // The marker failed — the author gets the conflict reply and the PR gets
    // its normal review rather than being suppressed forever.
    expect(result.body.created).toBe(true);
    expect(comments.some((c) => c.pullNumber === 41 && c.body.includes("Could not record stack membership"))).toBe(true);
    expect(store.listJobs(10)).toHaveLength(1);
  });

  it("honors the bot-author allowlist on PR body markers", async () => {
    const secret = "s3cret";
    const botPr = (extra: Record<string, unknown> = {}) =>
      JSON.stringify(
        prPayload({
          pull_request: {
            ...prPayload().pull_request,
            body: "<!-- part of stack u1 -->",
            user: { login: "ci-bot[bot]", type: "Bot" },
            ...extra,
          },
        }),
      );

    // Allowlisted bot: the marker suppresses the review.
    const allowedStore = new JobStore(openDb(":memory:"));
    const allowed = await handleGithubWebhook({
      config: stackConfig(secret, { MAOMAO_STACK_AUTHORS: "ci-bot[bot]" }),
      store: allowedStore,
      github: stackGithub().github,
      request: { event: "pull_request", deliveryId: "m22", signature: sign(secret, botPr()), rawBody: botPr() },
    });
    expect(allowed.body.ignored).toBe(true);
    expect(allowed.body.reason).toContain("part of stack");
    expect(allowedStore.listJobs(10)).toHaveLength(0);

    // Non-allowlisted bot: the marker is ignored and the review runs.
    const deniedStore = new JobStore(openDb(":memory:"));
    const denied = await handleGithubWebhook({
      config: stackConfig(secret),
      store: deniedStore,
      github: stackGithub().github,
      request: { event: "pull_request", deliveryId: "m23", signature: sign(secret, botPr()), rawBody: botPr() },
    });
    expect(denied.body.created).toBe(true);
    expect(deniedStore.listJobs(10)).toHaveLength(1);
  });

  it("re-runs the stack review on a member push after 'end of stack' resolved", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const { github, comments } = stackGithub({ openPulls: chainPulls() });
    const endBody = markedPr("<!-- end of stack u1 -->", {
      number: 43,
      base: { sha: "h42", ref: "feat-b" },
      head: { sha: "h43", ref: "feat-c" },
    });
    await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "m24", signature: sign(secret, endBody), rawBody: endBody },
    });
    const firstJob = store.listJobs(10).find((j) => j.job_type === "stack_review");
    expect(firstJob).toBeDefined();

    // A synchronize on the marked base PR re-resolves the chain and rechecks
    // the still-queued stack job in place (issue #131) — re-pinned to the new
    // head, no fresh row, no stale.
    const basePush = JSON.stringify({
      ...JSON.parse(markedPr("<!-- start of stack u1 -->", { number: 41, base: { sha: "m0", ref: "main" }, head: { sha: "h41b", ref: "feat-a" } })),
      action: "synchronize",
    });
    const resumed = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "m25", signature: sign(secret, basePush), rawBody: basePush },
    });
    expect(resumed.body.rechecked).toBe(true);
    expect(resumed.body.enqueued).toBe(false);
    expect(store.listJobs(10).filter((j) => j.job_type === "stack_review")).toHaveLength(1);
    expect(store.getJob(firstJob!.id)?.state).toBe("queued");
    expect(store.listStackMembers(firstJob!.id).find((m) => m.pr_number === 41)?.head_sha).toBe("h41b");
    // The base PR's marker keeps the resolved member list — the pending
    // placeholder is never reposted.
    const baseComments = comments.filter((c) => c.pullNumber === 41 && c.body.includes("maomao-stack:u1"));
    expect(baseComments).toHaveLength(1);
    expect(baseComments[0]?.body).toContain("issue 1 of 3");
    expect(baseComments[0]?.body).not.toContain("awaiting end of stack");
  });

  it("fails closed on an 'end of stack' whose chain includes a draft member", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const chain = chainPulls().map((p) => (p.prNumber === 42 ? { ...p, draft: true } : p));
    const { github, comments } = stackGithub({ openPulls: chain });
    const body = stackCommentOn(43, "end of stack u1");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "m26", signature: sign(secret, body), rawBody: body },
    });
    expect(result.body.enqueued).toBe(false);
    expect(comments.some((c) => c.body.includes("still draft"))).toBe(true);
    expect(store.listJobs(10).filter((j) => j.job_type === "stack_review")).toHaveLength(0);
  });

  it("fails closed when a rate-limited repo sends a body 'end of stack' without a repository id", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret, { REPO_RATE_LIMIT_PER_WINDOW: "1", REPO_RATE_WINDOW_MS: "60000" });
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const { github, comments } = stackGithub({ openPulls: chainPulls() });
    const payload = prPayload({
      pull_request: {
        ...prPayload().pull_request,
        number: 43,
        base: { sha: "h42", ref: "feat-b" },
        head: { sha: "h43", ref: "feat-c" },
        body: "<!-- end of stack u1 -->",
      },
    });
    delete (payload.repository as Record<string, unknown>).id;
    const rawBody = JSON.stringify(payload);
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      rateLimiter: new RepoRateLimiter(),
      request: { event: "pull_request", deliveryId: "m27", signature: sign(secret, rawBody), rawBody },
    });
    // Without a repository id the marker cannot even be verified — the
    // delivery degrades to the normal path's own missing-id handling (no
    // job, no reply), never to an unguarded stack run.
    expect(result.body.ignored).toBe(true);
    expect(result.body.reason).toBe("missing repository id");
    expect(store.listJobs(10)).toHaveLength(0);
  });

  it("does not re-post the usage reply on a redelivered marker event", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    const { github, comments } = stackGithub();
    const rawBody = markedPr("<!-- end of stack : misconfigured -->");
    for (const i of [0, 1]) {
      const result = await handleGithubWebhook({
        config,
        store,
        github,
        request: { event: "pull_request", deliveryId: "m30", signature: sign(secret, rawBody), rawBody },
      });
      if (i === 1) expect(result.body.duplicate).toBe(true);
    }
    expect(comments.filter((c) => c.body.includes("Not a stack command"))).toHaveLength(1);
    expect(store.listJobs(10)).toHaveLength(1);
  });

  it("falls back to the normal review when 'end of stack' cannot list open PRs", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    const github = {
      ...githubForCommands({ permission: "write" }),
      createIssueComment: async () => ({ id: "1", url: "u" }),
    };
    const rawBody = markedPr("<!-- end of stack u1 -->");
    const result = await handleGithubWebhook({
      config,
      store,
      github: github as unknown as GithubPort,
      request: { event: "pull_request", deliveryId: "m31", signature: sign(secret, rawBody), rawBody },
    });
    expect(result.body.created).toBe(true);
    expect(store.listJobs(10)).toHaveLength(1);
  });

  it("infers the stack id on a bare 'top of stack' from the PR's declaration", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackDeclaration({ repoFullName: "acme/widgets", stackId: "ship-it", prNumber: 41, position: 1, expectedCount: 2, actor: "alice" });
    store.upsertStackDeclaration({ repoFullName: "acme/widgets", stackId: "ship-it", prNumber: 42, position: 2, expectedCount: 2, actor: "alice" });
    const { github } = stackGithub({ pulls: { 41: resolvedStackPull(41), 42: resolvedStackPull(42, { baseRef: "feat-41" }) } });
    const body = stackCommentOn(42, "top of stack : #41, #42");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "m13", signature: sign(secret, body), rawBody: body },
    });
    expect(result.body.enqueued).toBe(true);
    expect(store.listJobs(10)[0]?.dedup_key).toMatch(/^stack:ship-it@[0-9a-f]{12}$/);
  });

  it("errors on a bare 'top of stack' with zero or ambiguous declarations", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    const { github, comments } = stackGithub();
    const body = stackCommentOn(42, "top of stack : #41, #42");
    const none = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "m14", signature: sign(secret, body), rawBody: body },
    });
    expect(none.body.enqueued).toBe(false);
    expect(comments[0]?.body).toMatch(/not declared in any stack/);

    store.upsertStackDeclaration({ repoFullName: "acme/widgets", stackId: "a", prNumber: 42, position: 1, expectedCount: 2, actor: "alice" });
    store.upsertStackDeclaration({ repoFullName: "acme/widgets", stackId: "b", prNumber: 42, position: 1, expectedCount: 2, actor: "alice" });
    const ambiguous = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "m15", signature: sign(secret, stackCommentOn(42, "top of stack : #41, #42", 9003)), rawBody: stackCommentOn(42, "top of stack : #41, #42", 9003) },
    });
    expect(ambiguous.body.enqueued).toBe(false);
    expect(comments[1]?.body).toMatch(/declared in 2 stacks/);
  });

  it("rejects 'start of stack' on a different PR than the recorded base", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    const { github, comments } = stackGithub();
    const first = stackCommentOn(41, "start of stack u1");
    await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "m16", signature: sign(secret, first), rawBody: first },
    });
    const second = stackCommentOn(42, "start of stack u1", 9002);
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "m17", signature: sign(secret, second), rawBody: second },
    });
    expect(result.body.recorded).toBe(false);
    expect(comments[1]?.body).toMatch(/already starts at PR #41/);
    expect(store.getStackStart("acme/widgets", "u1")?.pr_number).toBe(41);
    expect(store.listJobs(10)).toHaveLength(0);
  });

  it("corrects a stale declaration when 'end of stack' re-resolves the chain", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    // A stale row (wrong position and count from an earlier resolution or a
    // mistaken manual declare) must not deadlock re-resolution — the branch
    // layout is authoritative.
    store.upsertStackDeclaration({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 42, position: 9, expectedCount: 9, actor: "alice" });
    const { github } = stackGithub({ openPulls: chainPulls() });
    const body = stackCommentOn(43, "end of stack u1");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "m18", signature: sign(secret, body), rawBody: body },
    });
    expect(result.body.enqueued).toBe(true);
    const decls = store.listStackDeclarations("acme/widgets", "u1");
    expect(decls).toHaveLength(3);
    expect(decls.find((d) => d.pr_number === 42)).toMatchObject({ position: 2, expected_count: 3 });
  });

  it("blocks an 'end of stack' comment while reviews are paused globally", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.setGlobalPause("alice");
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const { github, comments } = stackGithub({ openPulls: chainPulls() });
    const body = stackCommentOn(43, "end of stack u1");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "m19", signature: sign(secret, body), rawBody: body },
    });
    expect(result.body.enqueued).toBe(false);
    expect(comments[0]?.body).toMatch(/paused globally/);
    expect(store.listJobs(10)).toHaveLength(0);
  });

  it("ignores fork PRs when walking the branch chain", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    // A fork PR whose head branch is also "feat-b" must not make the chain
    // ambiguous, and must never be spliced in as a member.
    const fork = resolvedStackPull(77, {
      baseRef: "main",
      headRef: "feat-b",
      headSha: "evil77",
      headRepoFullName: "mallory/widgets",
    });
    const { github } = stackGithub({ openPulls: [...chainPulls(), fork] });
    const body = stackCommentOn(43, "end of stack u1");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "f1", signature: sign(secret, body), rawBody: body },
    });
    expect(result.body.enqueued).toBe(true);
    const members = store.listStackMembers(store.listJobs(10)[0]!.id);
    expect(members.map((m) => m.pr_number)).toEqual([41, 42, 43]);
    expect(members.every((m) => m.head_sha !== "evil77")).toBe(true);
  });

  it("resolves a valid marker after a malformed marked line in the body", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const { github } = stackGithub({ openPulls: chainPulls() });
    // The first marked line fails the grammar; the real end marker below
    // must still win instead of being masked by the usage reply.
    const rawBody = markedPr("Adds the top.\n\n<!-- end of stack: see docs -->\n<!-- end of stack u1 -->", {
      number: 43,
      base: { sha: "h42", ref: "feat-b" },
      head: { sha: "h43", ref: "feat-c" },
    });
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "f2", signature: sign(secret, rawBody), rawBody },
    });
    expect(result.body.enqueued).toBe(true);
    expect(store.listJobs(10).filter((j) => j.job_type === "stack_review")).toHaveLength(1);
  });

  it("falls back to the normal review when a grammar-valid 'end of stack' fails", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    const { github, comments } = stackGithub({ openPulls: chainPulls() });
    // No start marker for "typo-id" — the failed command must not suppress review.
    const rawBody = markedPr("<!-- end of stack typo-id -->", {
      number: 43,
      base: { sha: "h42", ref: "feat-b" },
      head: { sha: "h43", ref: "feat-c" },
    });
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "f3", signature: sign(secret, rawBody), rawBody },
    });
    expect(result.body.created).toBe(true);
    expect(store.listJobs(10).filter((j) => j.job_type === "stack_review")).toHaveLength(0);
    expect(store.listJobs(10)).toHaveLength(1);
    expect(comments.some((c) => c.pullNumber === 43 && c.body.includes("no \"start of stack typo-id\""))).toBe(true);
  });

  it("does not resume a stack that only has a start marker and declarations", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    store.upsertStackDeclaration({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, position: 1, expectedCount: 2, actor: "alice" });
    store.upsertStackDeclaration({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 42, position: 2, expectedCount: 2, actor: "alice" });
    const { github } = stackGithub({ openPulls: chainPulls() });
    // No end/top ever ran — a member push must stay suppressed, not spend.
    const push = JSON.stringify({
      ...JSON.parse(markedPr("<!-- part of stack u1 -->", { number: 42, base: { sha: "h41", ref: "feat-a" }, head: { sha: "h42b", ref: "feat-b" } })),
      action: "synchronize",
    });
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "f4", signature: sign(secret, push), rawBody: push },
    });
    expect(result.body.ignored).toBe(true);
    expect(store.listJobs(10)).toHaveLength(0);
  });

  it("replies on a comment 'end of stack' when the port cannot list open PRs", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const comments: { pullNumber: number; body: string }[] = [];
    const github = {
      ...githubForCommands({ permission: "write" }),
      createIssueComment: async (input: { pullNumber: number; body: string }) => {
        comments.push({ pullNumber: input.pullNumber, body: input.body });
        return { id: "1", url: "u" };
      },
    };
    const body = stackCommentOn(43, "end of stack u1");
    const result = await handleGithubWebhook({
      config,
      store,
      github: github as unknown as GithubPort,
      request: { event: "issue_comment", deliveryId: "f5", signature: sign(secret, body), rawBody: body },
    });
    expect(result.status).toBe(200);
    expect(comments.some((c) => c.pullNumber === 43 && c.body.includes("top of stack <id>"))).toBe(true);
  });

  it("does not let a fork PR block 'end of stack' via the top boundary", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    // A fork PR BASED ON the stack top's head branch lives outside the
    // same-repo chain — it must not make the end PR 'not the top'.
    const forkOnTop = resolvedStackPull(78, {
      baseRef: "feat-c",
      headRef: "fork-x",
      headSha: "x78",
      headRepoFullName: "mallory/widgets",
    });
    const { github } = stackGithub({ openPulls: [...chainPulls(), forkOnTop] });
    const body = stackCommentOn(43, "end of stack u1");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "f6", signature: sign(secret, body), rawBody: body },
    });
    expect(result.body.enqueued).toBe(true);
    const members = store.listStackMembers(store.listJobs(10).filter((j) => j.job_type === "stack_review")[0]!.id);
    expect(members.map((m) => m.pr_number)).toEqual([41, 42, 43]);
  });

  it("excludes a PR whose head repo was deleted from chain matching", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    // Deleted-fork PR (head.repo = null) sharing the chain's middle head —
    // without exclusion it makes 'feat-b' ambiguous.
    const ghost = resolvedStackPull(79, { baseRef: "main", headRef: "feat-b", headSha: "g79", headRepoFullName: null });
    const { github } = stackGithub({ openPulls: [...chainPulls(), ghost] });
    const body = stackCommentOn(43, "end of stack u1");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "f7", signature: sign(secret, body), rawBody: body },
    });
    expect(result.body.enqueued).toBe(true);
    const members = store.listStackMembers(store.listJobs(10).filter((j) => j.job_type === "stack_review")[0]!.id);
    expect(members.map((m) => m.pr_number)).toEqual([41, 42, 43]);
  });

  it("stops a bare 'end of stack' walk at the declared start, not the natural base", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    // An unrelated PR whose head IS the stack's base branch sits below the
    // declared start — the walk must stop at the marker, not splice it in.
    const foreign = resolvedStackPull(80, { baseRef: "release", headRef: "main", headSha: "h80" });
    const { github } = stackGithub({ openPulls: [...chainPulls(), foreign] });
    const body = stackCommentOn(43, "end of stack");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "f8", signature: sign(secret, body), rawBody: body },
    });
    expect(result.body.enqueued).toBe(true);
    const members = store.listStackMembers(store.listJobs(10).filter((j) => j.job_type === "stack_review")[0]!.id);
    expect(members.map((m) => m.pr_number)).toEqual([41, 42, 43]);
    expect(members.every((m) => m.pr_number !== 80)).toBe(true);
  });

  it("lets a later 'end' marker win over an earlier 'part' marker in the body", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const { github } = stackGithub({ openPulls: chainPulls() });
    const rawBody = markedPr("<!-- part of stack u1 -->\n<!-- end of stack u1 -->", {
      number: 43,
      base: { sha: "h42", ref: "feat-b" },
      head: { sha: "h43", ref: "feat-c" },
    });
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "f9", signature: sign(secret, rawBody), rawBody },
    });
    expect(result.body.enqueued).toBe(true);
    expect(store.listJobs(10).filter((j) => j.job_type === "stack_review")).toHaveLength(1);
  });

  it("re-resolves a stack that grew after the first 'end of stack'", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const pulls = chainPulls();
    const { github } = stackGithub({ openPulls: pulls });
    const first = stackCommentOn(43, "end of stack u1", 9001);
    const firstResult = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "g10", signature: sign(secret, first), rawBody: first },
    });
    expect(firstResult.body.enqueued).toBe(true);
    expect(store.listStackDeclarations("acme/widgets", "u1")).toHaveLength(3);
    // A fourth PR lands on top — the resolution is authoritative, so the
    // stored count of 3 must not deadlock the re-trigger.
    pulls.push(resolvedStackPull(44, { baseRef: "feat-c", headRef: "feat-d", baseSha: "h43", headSha: "h44" }));
    const second = stackCommentOn(44, "end of stack u1", 9002);
    const secondResult = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "g11", signature: sign(secret, second), rawBody: second },
    });
    expect(secondResult.body.enqueued).toBe(true);
    const decls = store.listStackDeclarations("acme/widgets", "u1");
    expect(decls).toHaveLength(4);
    expect(decls.every((d) => d.expected_count === 4)).toBe(true);
    expect(store.listJobs(10).filter((j) => j.job_type === "stack_review")).toHaveLength(2);
  });

  it("stales and aborts an in-flight stack run when a member head moved", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const pulls = chainPulls();
    const { github } = stackGithub({ openPulls: pulls });
    const first = stackCommentOn(43, "end of stack u1", 9010);
    const firstResult = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "g12", signature: sign(secret, first), rawBody: first },
    });
    const firstJob = firstResult.enqueue!.job.id;
    store.setJobState(firstJob, "reviewing");
    // A push moved the top head — the re-trigger must supersede AND abort
    // the in-flight run instead of letting it publish pre-push reviews.
    pulls[2]!.headSha = "h43b";
    const second = stackCommentOn(43, "end of stack u1", 9011);
    const secondResult = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "g13", signature: sign(secret, second), rawBody: second },
    });
    expect(secondResult.body.enqueued).toBe(true);
    expect(store.getJob(firstJob)?.state).toBe("stale");
    expect(secondResult.enqueue?.staleJobIds).toContain(firstJob);
    // The replacement keeps the same membership key (issue #131).
    expect(store.getJob(secondResult.enqueue!.job.id)?.dedup_key).toBe(store.getJob(firstJob)?.dedup_key);
  });

  it("rechecks the same queued stack job on a mid/tip push — re-pin, no new row", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const pulls = chainPulls();
    const { github } = stackGithub({ openPulls: pulls });
    const first = stackCommentOn(43, "end of stack u1", 9020);
    const firstResult = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "g20", signature: sign(secret, first), rawBody: first },
    });
    const jobId = firstResult.enqueue!.job.id;
    const key = store.getJob(jobId)?.dedup_key;

    // Tip push while the job is still queued: same membership → recheck in
    // place — members re-pinned to the new heads, no new row, no stale.
    pulls[2]!.headSha = "h43b";
    const second = stackCommentOn(43, "end of stack u1", 9021);
    const secondResult = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "g21", signature: sign(secret, second), rawBody: second },
    });
    expect(secondResult.body.rechecked).toBe(true);
    expect(secondResult.body.enqueued).toBe(false);
    const job = store.getJob(jobId);
    expect(job?.state).toBe("queued");
    expect(job?.head_sha).toBe("h43b");
    expect(job?.dedup_key).toBe(key);
    expect(store.listJobs(10).filter((j) => j.job_type === "stack_review")).toHaveLength(1);
    expect(store.listStackMembers(jobId).map((m) => m.head_sha)).toEqual(["h41", "h42", "h43b"]);

    // An identical re-trigger (no head move) dedups without churning pins.
    const third = stackCommentOn(43, "end of stack u1", 9022);
    const thirdResult = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "g22", signature: sign(secret, third), rawBody: third },
    });
    expect(thirdResult.body.rechecked).toBe(false);
    expect(store.listJobs(10).filter((j) => j.job_type === "stack_review")).toHaveLength(1);
  });

  it("supersedes the stack job when membership changes — a PR leaving yields a new key", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const pulls = chainPulls();
    const { github } = stackGithub({ openPulls: pulls });
    const first = stackCommentOn(43, "end of stack u1", 9030);
    const firstResult = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "g23", signature: sign(secret, first), rawBody: first },
    });
    const firstJob = firstResult.enqueue!.job.id;
    const firstKey = store.getJob(firstJob)?.dedup_key;

    // #42 leaves the stack (closed/retargeted): the re-resolved chain is
    // 41→43 — a new membership — so the old job supersedes and a fresh row
    // takes its place.
    pulls.splice(1, 1);
    pulls[1]!.baseRef = "feat-a";
    pulls[1]!.baseSha = "h41";
    const second = stackCommentOn(43, "end of stack u1", 9031);
    const secondResult = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "g24", signature: sign(secret, second), rawBody: second },
    });
    expect(secondResult.body.enqueued).toBe(true);
    const secondJob = store.getJob(secondResult.enqueue!.job.id);
    expect(store.getJob(firstJob)?.state).toBe("stale");
    expect(secondJob?.state).toBe("queued");
    expect(secondJob?.dedup_key).not.toBe(firstKey);
    expect(store.listStackMembers(secondJob!.id).map((m) => m.pr_number)).toEqual([41, 43]);
  });

  it("re-queues a child row on the same key when a completed stack job is re-triggered", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const pulls = chainPulls();
    const { github } = stackGithub({ openPulls: pulls });
    const first = stackCommentOn(43, "end of stack u1", 9040);
    const firstResult = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "g25", signature: sign(secret, first), rawBody: first },
    });
    const firstJob = firstResult.enqueue!.job.id;
    store.setJobState(firstJob, "completed");
    const firstKey = store.getJob(firstJob)?.dedup_key;
    const firstHead = store.getJob(firstJob)?.head_sha;

    // Mid push after completion: the completed card is history — a fresh
    // child row on the same membership key runs the recheck; the completed
    // row's SHA history is not rewritten.
    pulls[1]!.headSha = "h42b";
    const second = stackCommentOn(43, "end of stack u1", 9041);
    const secondResult = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "g26", signature: sign(secret, second), rawBody: second },
    });
    expect(secondResult.body.enqueued).toBe(true);
    const original = store.getJob(firstJob);
    expect(original?.state).toBe("completed");
    expect(original?.head_sha).toBe(firstHead);
    const child = store.getJob(secondResult.enqueue!.job.id);
    expect(child?.state).toBe("queued");
    expect(child?.dedup_key).toBe(firstKey);
    expect(store.listJobs(10).filter((j) => j.job_type === "stack_review")).toHaveLength(2);
  });

  it("falls through to the normal review when a member-push resume fails after the top merged", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    const pulls = chainPulls();
    const { github } = stackGithub({ openPulls: pulls });
    const end = stackCommentOn(43, "end of stack u1", 9020);
    await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "g14", signature: sign(secret, end), rawBody: end },
    });
    // The top merged: #43 leaves the open list, so the resume resolution
    // fails — the member push must still get a per-PR review.
    pulls.pop();
    const push = JSON.stringify({
      ...JSON.parse(markedPr("<!-- part of stack u1 -->", { number: 41, base: { sha: "m0", ref: "main" }, head: { sha: "h41b", ref: "feat-a" } })),
      action: "synchronize",
    });
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "g15", signature: sign(secret, push), rawBody: push },
    });
    expect(result.body.created).toBe(true);
    expect(store.listJobs(10).some((j) => j.job_type === "pr_review" && j.pr_number === 41)).toBe(true);
  });

  it("posts a visible suppression note for a 'part of stack' body marker", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    const { github, comments } = stackGithub();
    const rawBody = markedPr("Adds the thing.\n\n<!-- part of stack u1 -->\n");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "g16", signature: sign(secret, rawBody), rawBody },
    });
    expect(result.body.ignored).toBe(true);
    expect(comments.some((c) => c.pullNumber === 7 && c.body.includes("maomao-stack-member:u1"))).toBe(true);
    // A repeat event edits the note in place rather than posting a second one.
    const again = JSON.stringify({ ...JSON.parse(rawBody), action: "synchronize" });
    await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "g17", signature: sign(secret, again), rawBody: again },
    });
    expect(comments.filter((c) => c.pullNumber === 7 && c.body.includes("maomao-stack-member:u1"))).toHaveLength(1);
  });

  it("does not re-post the usage reply on synchronize for a malformed marker", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    const { github, comments } = stackGithub();
    const opened = markedPr("Adds the thing.\n\n<!-- end of stack: see docs -->\n");
    await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "g18", signature: sign(secret, opened), rawBody: opened },
    });
    const usageAfterOpen = comments.filter((c) => c.body.includes("Not a stack command")).length;
    expect(usageAfterOpen).toBe(1);
    // A synchronize carries a new head SHA so the fall-through review is fresh.
    const sync = JSON.stringify({
      ...JSON.parse(markedPr("Adds the thing.\n\n<!-- end of stack: see docs -->\n", { head: { sha: "head333", ref: "feature" } })),
      action: "synchronize",
    });
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "pull_request", deliveryId: "g19", signature: sign(secret, sync), rawBody: sync },
    });
    // The malformed marker still falls through to the normal review —
    // only the repeated usage comment is suppressed.
    expect(result.body.created).toBe(true);
    expect(comments.filter((c) => c.body.includes("Not a stack command"))).toHaveLength(usageAfterOpen);
  });
});

describe("webhook delivery log", () => {
  function loggedDelivery(store: JobStore, deliveryId: string) {
    return store.listWebhookDeliveries({ limit: 20 }).find((row) => row.delivery_id === deliveryId);
  }

  it("records ignored pull_request actions with their reason and context", async () => {
    const secret = "s3cret";
    const config = loadConfig({ GITHUB_WEBHOOK_SECRET: secret, GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k" });
    const store = new JobStore(openDb(":memory:"));
    const rawBody = JSON.stringify(
      prPayload({ action: "edited", sender: { login: "octocat" } }),
    );
    const result = await handleGithubWebhook({
      config,
      store,
      request: { event: "pull_request", deliveryId: "ignored-1", signature: sign(secret, rawBody), rawBody },
    });
    expect(result.body.ignored).toBe(true);

    const row = loggedDelivery(store, "ignored-1");
    expect(row).toBeDefined();
    expect(row!.event).toBe("pull_request");
    expect(row!.action).toBe("edited");
    expect(row!.repo_full_name).toBe("acme/widgets");
    expect(row!.actor).toBe("octocat");
    expect(row!.result).toBe("ignored: ignored action edited");
  });

  it("records unsupported events as ignored deliveries", async () => {
    const secret = "s3cret";
    const config = loadConfig({ GITHUB_WEBHOOK_SECRET: secret });
    const store = new JobStore(openDb(":memory:"));
    const rawBody = JSON.stringify(prPayload({ sender: { login: "octocat" } }));
    const result = await handleGithubWebhook({
      config,
      store,
      request: { event: "check_run", deliveryId: "ev-1", signature: sign(secret, rawBody), rawBody },
    });
    expect(result.body.ignored).toBe(true);
    const row = loggedDelivery(store, "ev-1");
    expect(row?.result).toBe("ignored: event check_run");
  });

  it("records pings and keeps the specific result on already-claimed deliveries", async () => {
    const secret = "s3cret";
    const config = loadConfig({ GITHUB_WEBHOOK_SECRET: secret, GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k" });
    const store = new JobStore(openDb(":memory:"));
    const ping = await handleGithubWebhook({
      config,
      store,
      request: { event: "ping", deliveryId: "ping-1", signature: sign(secret, "{}"), rawBody: "{}" },
    });
    expect(ping.status).toBe(200);
    expect(loggedDelivery(store, "ping-1")?.result).toBe("ok: ping");

    // A merged close claims with its own result before the boundary wrapper
    // runs; the wrapper only backfills context, never rewrites the result.
    const rawBody = JSON.stringify(
      prPayload({ action: "closed", pull_request: { ...prPayload().pull_request, merged: true }, sender: { login: "octocat" } }),
    );
    await handleGithubWebhook({
      config,
      store,
      request: { event: "pull_request", deliveryId: "close-1", signature: sign(secret, rawBody), rawBody },
    });
    const row = loggedDelivery(store, "close-1");
    expect(row?.result).toBe("pr_merged_cancel");
    expect(row?.ignored).toBe(0);
    expect(row?.repo_full_name).toBe("acme/widgets");
    expect(row?.actor).toBe("octocat");
  });

  it("answers a redelivered merge close as duplicate without disturbing the recorded row", async () => {
    const secret = "s3cret";
    const config = loadConfig({ GITHUB_WEBHOOK_SECRET: secret, GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k" });
    const store = new JobStore(openDb(":memory:"));
    const rawBody = JSON.stringify(
      prPayload({ action: "closed", pull_request: { ...prPayload().pull_request, merged: true }, sender: { login: "octocat" } }),
    );
    const request = { event: "pull_request", deliveryId: "dup-1", signature: sign(secret, rawBody), rawBody };
    await handleGithubWebhook({ config, store, request });

    const second = await handleGithubWebhook({ config, store, request });
    expect(second.body.duplicate).toBe(true);

    // The boundary's "duplicate" claim must not overwrite the real result —
    // the row stays pr_merged_cancel and keeps its context.
    const row = loggedDelivery(store, "dup-1");
    expect(row?.result).toBe("pr_merged_cancel");
    expect(row?.ignored).toBe(0);
    expect(row?.repo_full_name).toBe("acme/widgets");
    expect(row?.actor).toBe("octocat");
  });

  it("records non-command issue comments and falls back to the comment author", async () => {
    const secret = "s3cret";
    const config = loadConfig({ GITHUB_WEBHOOK_SECRET: secret });
    const store = new JobStore(openDb(":memory:"));
    // No sender: the comment's author is the actor-context fallback.
    const rawBody = JSON.stringify(
      commentPayload({
        comment: {
          id: 9100,
          body: "lgtm",
          user: { login: "alice", type: "User" },
          author_association: "OWNER",
        },
      }),
    );
    const result = await handleGithubWebhook({
      config,
      store,
      request: { event: "issue_comment", deliveryId: "ic-1", signature: sign(secret, rawBody), rawBody },
    });
    expect(result.body.ignored).toBe(true);
    const row = loggedDelivery(store, "ic-1");
    expect(row?.result).toBe("ignored: not an escalate command");
    expect(row?.ignored).toBe(1);
    expect(row?.actor).toBe("alice");
    expect(row?.repo_full_name).toBe("acme/widgets");
  });

  it("records a contextless row when the payload carries no repo or actor", async () => {
    const secret = "s3cret";
    const config = loadConfig({ GITHUB_WEBHOOK_SECRET: secret });
    const store = new JobStore(openDb(":memory:"));
    const rawBody = JSON.stringify({ action: "edited" });
    await handleGithubWebhook({
      config,
      store,
      request: { event: "pull_request", deliveryId: "ctx-0", signature: sign(secret, rawBody), rawBody },
    });
    const row = loggedDelivery(store, "ctx-0");
    expect(row?.result).toBe("ignored: ignored action edited");
    expect(row?.repo_full_name).toBeNull();
    expect(row?.actor).toBeNull();
  });

  it("does not record unverified deliveries", async () => {
    const config = loadConfig({ GITHUB_WEBHOOK_SECRET: "s3cret" });
    const store = new JobStore(openDb(":memory:"));
    const result = await handleGithubWebhook({
      config,
      store,
      request: { event: "pull_request", deliveryId: "bad-1", signature: "sha256=deadbeef", rawBody: "{}" },
    });
    expect(result.status).toBe(401);
    expect(store.listWebhookDeliveries({})).toHaveLength(0);
  });

  it("claims enqueued and skipped results for pull_request deliveries", async () => {
    const secret = "s3cret";
    const config = loadConfig({
      GITHUB_WEBHOOK_SECRET: secret,
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "k",
      REVIEWER_ROLES: "correctness",
    });
    const store = new JobStore(openDb(":memory:"));
    const rawBody = JSON.stringify(prPayload({ sender: { login: "octocat" } }));
    const first = await handleGithubWebhook({
      config,
      store,
      request: { event: "pull_request", deliveryId: "enq-1", signature: sign(secret, rawBody), rawBody },
    });
    expect(first.body.created).toBe(true);
    expect(loggedDelivery(store, "enq-1")?.result).toBe("enqueued");

    // Same head SHA on a new delivery id: the enqueue dedups and the second
    // delivery row records the skip reason.
    const dup = await handleGithubWebhook({
      config,
      store,
      request: { event: "pull_request", deliveryId: "enq-2", signature: sign(secret, rawBody), rawBody },
    });
    expect(dup.body.created).toBe(false);
    expect(loggedDelivery(store, "enq-2")?.result).toMatch(/^skipped: /);
  });
});
