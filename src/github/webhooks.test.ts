import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { JobStore } from "../jobs/store.js";
import { loadConfig } from "../config.js";
import { handleGithubWebhook, shouldHandlePullRequest } from "./webhooks.js";
import type { GithubPort, RepoPermission, ReviewThread } from "./client.js";

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
