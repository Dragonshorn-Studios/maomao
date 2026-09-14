import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { JobStore } from "./jobs/store.js";
import type { JobQueue } from "./jobs/queue.js";
import { createApp } from "./server.js";
import { SESSION_COOKIE } from "./auth.js";
import type { ManualTriggerPort, ResolvedPull } from "./github/client.js";

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function testApp(env: Record<string, string> = {}, github?: ManualTriggerPort) {
  const webhookSecret = "s3cret";
  const config = loadConfig({
    GITHUB_WEBHOOK_SECRET: webhookSecret,
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "k",
    REVIEWER_ROLES: "correctness",
    ...env,
  });
  const store = new JobStore(openDb(":memory:"));
  const enqueued: number[] = [];
  const queue = {
    enqueue(id: number) {
      enqueued.push(id);
    },
    abortMany() {},
  } as unknown as JobQueue;
  const app = createApp({ config, store, queue, github, startedAt: Date.now() });
  return { app, store, enqueued, webhookSecret };
}

function cookieFrom(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  const match = raw.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match?.[1]) throw new Error(`missing session cookie in ${raw}`);
  return `${SESSION_COOKIE}=${match[1]}`;
}

const openedPayload = JSON.stringify({
  action: "opened",
  installation: { id: 1, account: { id: 1001 } },
  repository: { id: 2002, full_name: "acme/widgets", name: "widgets", owner: { login: "acme", id: 1001 } },
  pull_request: {
    number: 8,
    title: "Hello",
    body: "",
    html_url: "https://example.test",
    draft: false,
    user: { login: "dev" },
    base: { sha: "b", ref: "main" },
    head: { sha: "h", ref: "f" },
  },
});

describe("HTTP app", () => {
  it("serves health, UI, and webhook enqueue when the UI gate is off", async () => {
    const { app, enqueued, webhookSecret } = testApp();

    const health = await app.request("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, service: "maomao" });

    const home = await app.request("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Queue a GitHub pull request");

    const webhook = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "abc",
        "x-hub-signature-256": sign(webhookSecret, openedPayload),
        "content-type": "application/json",
      },
      body: openedPayload,
    });
    expect(webhook.status).toBe(202);
    expect(enqueued).toHaveLength(1);

    const api = await app.request("/api/jobs");
    const body = (await api.json()) as { jobs: { pr_number: number }[] };
    expect(body.jobs[0]?.pr_number).toBe(8);

    const detail = await app.request(`/jobs/${enqueued[0]}`);
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain("acme/widgets#8");
  });

  it("protects UI/API/events with a session cookie and leaves webhook/health public", async () => {
    const { app, enqueued, webhookSecret } = testApp({
      UI_PASSWORD: "hunter2",
      UI_SESSION_SECRET: "session-secret-for-tests",
    });

    expect((await app.request("/")).status).toBe(302);
    expect((await app.request("/")).headers.get("location")).toContain("/login");
    expect((await app.request("/jobs/1")).status).toBe(302);

    const apiDenied = await app.request("/api/jobs");
    expect(apiDenied.status).toBe(401);
    expect(await apiDenied.json()).toEqual({ error: "unauthorized" });
    expect((await app.request("/events")).status).toBe(401);

    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/login")).status).toBe(200);
    expect((await app.request("/assets/maomao.css")).status).toBe(200);
    expect(await (await app.request("/assets/maomao.css")).text()).toContain("--jade:");
    expect((await app.request("/assets/other.css")).status).toBe(302);
    expect((await app.request("/assets/other.css")).headers.get("location")).toContain("/login");

    const webhook = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "abc",
        "x-hub-signature-256": sign(webhookSecret, openedPayload),
        "content-type": "application/json",
      },
      body: openedPayload,
    });
    expect(webhook.status).toBe(202);
    expect(enqueued).toHaveLength(1);

    const badLogin = await app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=wrong&next=%2F",
    });
    expect(badLogin.status).toBe(401);
    expect(badLogin.headers.get("set-cookie") ?? "").not.toContain(SESSION_COOKIE);

    const login = await app.request("https://maomao.example/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=hunter2&next=%2F",
    });
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/");
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toMatch(/samesite=lax/i);
    expect(setCookie).toMatch(/secure/i);
    const cookie = cookieFrom(login);

    const home = await app.request("/", { headers: { cookie } });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Review jobs");

    const api = await app.request("/api/jobs", { headers: { cookie } });
    expect(api.status).toBe(200);
    const body = (await api.json()) as { jobs: { pr_number: number }[] };
    expect(body.jobs[0]?.pr_number).toBe(8);

    const detail = await app.request(`/jobs/${enqueued[0]}`, { headers: { cookie } });
    expect(detail.status).toBe(200);

    const tampered = await app.request("/api/jobs", {
      headers: { cookie: `${SESSION_COOKIE}=v1.9999999999999.not-a-real-sig` },
    });
    expect(tampered.status).toBe(401);
  });
});

function fakePull(overrides: Partial<ResolvedPull> = {}): ResolvedPull {
  return {
    installationId: 42,
    accountId: 1001,
    repositoryId: 2002,
    repoOwner: "acme",
    repoName: "widgets",
    repoFullName: "acme/widgets",
    prNumber: 12,
    prTitle: "Add frob",
    prBody: "does a thing",
    prHtmlUrl: "https://github.com/acme/widgets/pull/12",
    prAuthor: "octocat",
    baseSha: "base111",
    headSha: "head222head222head222head222head222head222",
    baseRef: "main",
    headRef: "feature",
    draft: false,
    ...overrides,
  };
}

function mockGithub(pull: ResolvedPull = fakePull()): ManualTriggerPort & {
  calls: { installation: number; repository: number; pull: number };
} {
  const calls = { installation: 0, repository: 0, pull: 0 };
  return {
    calls,
    getRepoInstallation: async () => {
      calls.installation += 1;
      return { installationId: pull.installationId, accountId: pull.accountId };
    },
    getRepository: async () => {
      calls.repository += 1;
      return { id: pull.repositoryId };
    },
    getPull: async () => {
      calls.pull += 1;
      return pull;
    },
  };
}

describe("manual review trigger", () => {
  it("enqueues through the same job store path and reports an existing SHA", async () => {
    const { app, store, enqueued } = testApp({}, mockGithub());
    const first = await app.request("/reviews", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets%2Fpull%2F12",
    });
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toMatch(/\/jobs\/1\?notice=queued/);
    expect(enqueued).toEqual([1]);
    expect(store.getJob(1)?.webhook_event).toBe("manual.ui");
    expect(store.getJob(1)?.head_sha).toBe("head222head222head222head222head222head222");
    expect(store.getJob(1)?.github_account_id).toBe(1001);
    expect(store.getJob(1)?.github_repository_id).toBe(2002);

    const again = await app.request("/reviews", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets%2Fpull%2F12",
    });
    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toMatch(/\/jobs\/1\?notice=exists/);
    expect(enqueued).toEqual([1]);

    const detail = await app.request("/jobs/1?notice=queued");
    expect(await detail.text()).toContain("Queued a review");
  });

  it("rejects a non-GitHub URL without touching the queue", async () => {
    const github = mockGithub();
    const { app, enqueued } = testApp({}, github);
    const res = await app.request("/reviews", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "url=https%3A%2F%2Fgitlab.com%2Facme%2Fwidgets%2Fpull%2F1",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("github.com");
    expect(enqueued).toEqual([]);
  });

  it("requires session auth for the paste-URL form when the UI gate is on", async () => {
    const { app, enqueued } = testApp(
      { UI_PASSWORD: "hunter2", UI_SESSION_SECRET: "session-secret-for-tests" },
      mockGithub(),
    );
    const denied = await app.request("/reviews", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets%2Fpull%2F12",
    });
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")).toContain("/login");
    expect(enqueued).toEqual([]);

    const login = await app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=hunter2&next=%2F",
    });
    const cookie = cookieFrom(login);
    const allowed = await app.request("/reviews", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets%2Fpull%2F12",
    });
    expect(allowed.status).toBe(302);
    expect(allowed.headers.get("location")).toMatch(/notice=queued/);
    expect(enqueued).toEqual([1]);
  });

  it("respects REVIEW_DRAFTS for manual triggers", async () => {
    const { app, enqueued } = testApp({}, mockGithub(fakePull({ draft: true })));
    const res = await app.request("/reviews", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets%2Fpull%2F12",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("draft");
    expect(enqueued).toEqual([]);
  });

  it("rejects unauthorized accounts without pulling the PR, enqueueing, or fetching the repository", async () => {
    const github = mockGithub();
    const { app, store, enqueued } = testApp({ ALLOWED_GITHUB_ACCOUNT_IDS: "1" }, github);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await app.request("/reviews", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets%2Fpull%2F12",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Not authorized");
    expect(github.calls).toEqual({ installation: 1, repository: 0, pull: 0 });
    expect(enqueued).toEqual([]);
    expect(store.listJobs()).toEqual([]);
    const log = String(warn.mock.calls[0]?.[0]);
    expect(log).toContain("unauthorized account");
    expect(log).not.toContain("acme/widgets");
    warn.mockRestore();
  });

  it("rejects unauthorized repositories after the account check without pulling the PR", async () => {
    const github = mockGithub();
    const { app, store, enqueued } = testApp(
      { ALLOWED_GITHUB_ACCOUNT_IDS: "1001", ALLOWED_GITHUB_REPOSITORY_IDS: "1" },
      github,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await app.request("/reviews", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets%2Fpull%2F12",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Not authorized");
    expect(github.calls.installation).toBe(1);
    expect(github.calls.repository).toBe(1);
    expect(github.calls.pull).toBe(0);
    expect(enqueued).toEqual([]);
    expect(store.listJobs()).toEqual([]);
    warn.mockRestore();
  });

  it("does not enqueue webhook deliveries for unauthorized repository ids", async () => {
    const { app, store, enqueued, webhookSecret } = testApp({ ALLOWED_GITHUB_REPOSITORY_IDS: "9" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const webhook = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "abc",
        "x-hub-signature-256": sign(webhookSecret, openedPayload),
        "content-type": "application/json",
      },
      body: openedPayload,
    });
    expect(webhook.status).toBe(202);
    expect(await webhook.json()).toEqual({ ok: true, ignored: true, reason: "unauthorized repository" });
    expect(enqueued).toEqual([]);
    expect(store.listJobs()).toEqual([]);
    warn.mockRestore();
  });

  it("enqueues a manual review when numeric allowlists match", async () => {
    const github = mockGithub();
    const { app, enqueued } = testApp(
      { ALLOWED_GITHUB_ACCOUNT_IDS: "1001", ALLOWED_GITHUB_REPOSITORY_IDS: "2002" },
      github,
    );
    const res = await app.request("/reviews", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets%2Fpull%2F12",
    });
    expect(res.status).toBe(302);
    expect(enqueued).toEqual([1]);
    expect(github.calls).toEqual({ installation: 1, repository: 1, pull: 1 });
  });

  it("does not spend a rate-limit slot when getPull fails", async () => {
    const github = mockGithub();
    const original = github.getPull;
    let pulls = 0;
    github.getPull = async (...args) => {
      pulls += 1;
      if (pulls === 1) throw new Error("GitHub unavailable");
      return original(...args);
    };
    const { app, enqueued } = testApp({ REPO_RATE_LIMIT_PER_WINDOW: "1", REPO_RATE_WINDOW_MS: "60000" }, github);
    const failed = await app.request("/reviews", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets%2Fpull%2F12",
    });
    expect(failed.status).toBe(400);
    expect(enqueued).toEqual([]);

    const ok = await app.request("/reviews", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets%2Fpull%2F12",
    });
    expect(ok.status).toBe(302);
    expect(enqueued).toEqual([1]);
  });

  it("retries failed reviewers and enqueues the job", async () => {
    const { app, store, enqueued } = testApp();
    const created = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 1,
      prNumber: 8,
      prTitle: "Hello",
      prBody: "",
      prHtmlUrl: "https://example.test",
      prAuthor: "dev",
      baseSha: "b",
      headSha: "h",
      baseRef: "main",
      headRef: "f",
      reviewers: [{ role: "correctness", title: "Correctness" }],
    });
    const run = store.listReviewerRuns(created.job.id)[0];
    store.patchReviewer(run.id, { state: "failed", validation_error: "empty" });
    store.setJobState(created.job.id, "failed", { failure_reason: "all specialist reviewers failed" });

    const res = await app.request(`/jobs/${created.job.id}/reviewers/${run.id}/retry`, { method: "POST" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/jobs/${created.job.id}?notice=retry`);
    expect(enqueued).toEqual([created.job.id]);
    expect(store.getJob(created.job.id)?.state).toBe("queued");
    expect(store.getReviewerRun(run.id)?.state).toBe("queued");

    const again = await app.request(`/jobs/${created.job.id}/retry`, { method: "POST" });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("still running");
  });
});
