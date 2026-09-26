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
    expect(job.dedup_key).toBe("stack:ship-it");
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
    expect(jobs[0]?.dedup_key).toBe("stack:u1");
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
    expect(store.listJobs(10)[0]?.dedup_key).toBe("stack:u1");
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
    const rawBody = markedPr("Adds the thing.\n\npart of stack u1\n");
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
    const rawBody = markedPr("Adds the top.\n\nend of stack u1", {
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
    expect(jobs[0]?.dedup_key).toBe("stack:u1");
    expect(store.listStackMembers(jobs[0]!.id).map((m) => m.pr_number)).toEqual([41, 42, 43]);
  });

  it("reviews normally when the body marker's author is not authorized", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    // "read" is explicit and weaker than write — never upgraded.
    const { github } = stackGithub({ permission: "read" });
    const rawBody = markedPr("part of stack u1");
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
    const rawBody = markedPr("Adds the thing.\n\nend of stack : misconfigured\n");
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
    const rawBody = markedPr("end of stack u1", {
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
      ...prPayload({ pull_request: { ...prPayload().pull_request, number: 43, base: { sha: "h42", ref: "feat-b" }, head: { sha: "fresh43", ref: "feat-c" }, body: "end of stack u1" } }),
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
    const pausedBody = markedPr("end of stack u1", {
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
    expect(pausedResult.body.enqueued).toBe(false);
    expect(pausedComments[0]?.body).toMatch(/paused until/);
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
    const limitedBody = markedPr("end of stack u1", {
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
    expect(limitedResult.body.enqueued).toBe(false);
    expect(limitedComments[0]?.body).toMatch(/rate limited/);
    expect(limitedStore.listJobs(10).filter((j) => j.job_type === "stack_review")).toHaveLength(0);
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
    expect(store.listJobs(10)[0]?.dedup_key).toBe("stack:ship-it");
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

  it("rolls back all declarations when 'end of stack' hits a conflicting member", async () => {
    const secret = "s3cret";
    const config = stackConfig(secret);
    const store = new JobStore(openDb(":memory:"));
    store.upsertStackStart({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 41, actor: "alice" });
    // Pre-declare #42 at a position that contradicts the resolved chain.
    store.upsertStackDeclaration({ repoFullName: "acme/widgets", stackId: "u1", prNumber: 42, position: 9, expectedCount: 9, actor: "alice" });
    const { github, comments } = stackGithub({ openPulls: chainPulls() });
    const body = stackCommentOn(43, "end of stack u1");
    const result = await handleGithubWebhook({
      config,
      store,
      github,
      request: { event: "issue_comment", deliveryId: "m18", signature: sign(secret, body), rawBody: body },
    });
    expect(result.body.enqueued).toBe(false);
    expect(comments[0]?.body).toMatch(/already declared as issue 9/);
    // Atomic: only the pre-existing conflicting row remains.
    expect(store.listStackDeclarations("acme/widgets", "u1")).toHaveLength(1);
    expect(store.listJobs(10)).toHaveLength(0);
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
});
