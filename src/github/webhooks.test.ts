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
