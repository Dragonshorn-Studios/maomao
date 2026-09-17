import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { JobStore } from "./jobs/store.js";
import type { JobQueue } from "./jobs/queue.js";
import type { OpenCodePort } from "./opencode/parse.js";

type OpenCodeLike = OpenCodePort;
import { createApp } from "./server.js";
import { fingerprintFinding } from "./findings/identity.js";
import { SESSION_COOKIE, CSRF_COOKIE, issueCsrfToken } from "./auth.js";
import type { GithubPort, ManualTriggerPort, ResolvedPull } from "./github/client.js";

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function testApp(
  env: Record<string, string> = {},
  github?: ManualTriggerPort,
  oauthFetch?: typeof fetch,
  contextExtras: Partial<Parameters<typeof createApp>[0]> = {},
) {
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
  const app = createApp({ config, store, queue, github, startedAt: Date.now(), oauthFetch, env: { ...env }, ...contextExtras });
  return { app, store, enqueued, webhookSecret };
}

function mockOauthFetch(
  user: { id: number; login: string; avatar_url?: string },
  options: { tokenFail?: boolean } = {},
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      if (options.tokenFail) return new Response("nope", { status: 500 });
      const body = JSON.parse(String(init?.body)) as { code?: string };
      if (body.code !== "good-code") return new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 200 });
      return new Response(JSON.stringify({ access_token: "human-access-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify(user), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function cookieFrom(response: Response, name = SESSION_COOKIE): string {
  const raw = response.headers.get("set-cookie") ?? "";
  const match = raw.match(new RegExp(`${name}=([^;]+)`));
  if (!match?.[1]) throw new Error(`missing ${name} cookie in ${raw}`);
  return `${name}=${match[1]}`;
}

function csrfArtifacts(response: Response): Promise<{ html: string; csrfCookie: string; csrfToken: string }> {
  const csrfCookie = cookieFrom(response, CSRF_COOKIE);
  return response.text().then((html) => {
    const tokenMatch = html.match(/name="csrf_token" value="([^"]+)"/);
    if (!tokenMatch?.[1]) throw new Error("missing csrf_token field in rendered form");
    return { html, csrfCookie, csrfToken: tokenMatch[1] };
  });
}

async function loginSession(
  app: ReturnType<typeof createApp>,
): Promise<{ session: string; csrfToken: string; cookies: string }> {
  const page = await app.request("/login");
  const { csrfCookie, csrfToken } = await csrfArtifacts(page);
  const login = await app.request("/login", {
    method: "POST",
    headers: { cookie: csrfCookie, "content-type": "application/x-www-form-urlencoded" },
    body: `password=hunter2&next=%2F&csrf_token=${encodeURIComponent(csrfToken)}`,
  });
  if (login.status !== 302) throw new Error(`login failed with status ${login.status}`);
  const session = cookieFrom(login);
  return { session, csrfToken, cookies: `${session}; ${csrfCookie}` };
}

function hiddenValue(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  if (match?.[1] === undefined) throw new Error(`missing hidden field ${name} in confirm page`);
  return match[1];
}

async function operatorSession(app: ReturnType<typeof createApp>): Promise<string> {
  const start = await app.request("/login/github");
  const state = start.headers.get("location")?.match(/state=([^&]+)/)?.[1] ?? "";
  const callback = await app.request(`/login/github/callback?code=good-code&state=${state}`);
  return cookieFrom(callback);
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
    expect(home.headers.get("set-cookie") ?? "").not.toContain(CSRF_COOKIE);
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
    const typeaheadJs = await app.request("/assets/typeahead.js");
    expect(typeaheadJs.status).toBe(200);
    expect(typeaheadJs.headers.get("content-type")).toContain("text/javascript");
    expect(await typeaheadJs.text()).toContain("__maomaoTypeahead");
    const pierreJs = await app.request("/assets/vendor/pierre-diffs.js");
    expect(pierreJs.status).toBe(200);
    expect(pierreJs.headers.get("content-type")).toContain("text/javascript");
    expect(await pierreJs.text()).toContain("__maomaoPierre");
    expect((await app.request("/assets/other.css")).status).toBe(302);
    expect((await app.request("/assets/other.css")).headers.get("location")).toContain("/login");

    // Brand icons are public with stable content types; PNG bytes survive the base64 round-trip.
    const faviconSvg = await app.request("/assets/favicon.svg");
    expect(faviconSvg.status).toBe(200);
    expect(faviconSvg.headers.get("content-type")).toContain("image/svg+xml");
    expect(await faviconSvg.text()).toContain("<svg");
    const faviconPng = await app.request("/assets/favicon.png");
    expect(faviconPng.status).toBe(200);
    expect(faviconPng.headers.get("content-type")).toBe("image/png");
    const pngHead = Buffer.from(await faviconPng.arrayBuffer()).subarray(0, 4);
    expect(pngHead.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    expect((await app.request("/assets/icon.png")).headers.get("content-type")).toBe("image/png");
    expect((await app.request("/assets/icon.svg")).status).toBe(200);

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

    const tokenless = await app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=hunter2&next=%2F",
    });
    expect(tokenless.status).toBe(403);
    expect(tokenless.headers.get("set-cookie") ?? "").not.toContain(SESSION_COOKIE);

    const loginPage = await app.request("/login");
    expect(loginPage.status).toBe(200);
    const { csrfCookie, csrfToken } = await csrfArtifacts(loginPage);

    const badLogin = await app.request("/login", {
      method: "POST",
      headers: { cookie: csrfCookie, "content-type": "application/x-www-form-urlencoded" },
      body: `password=wrong&next=%2F&csrf_token=${encodeURIComponent(csrfToken)}`,
    });
    expect(badLogin.status).toBe(401);
    expect(badLogin.headers.get("set-cookie") ?? "").not.toContain(SESSION_COOKIE);

    const login = await app.request("https://maomao.example/login", {
      method: "POST",
      headers: { cookie: csrfCookie, "content-type": "application/x-www-form-urlencoded" },
      body: `password=hunter2&next=%2F&csrf_token=${encodeURIComponent(csrfToken)}`,
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

    const session = await loginSession(app);
    const tokenless = await app.request("/reviews", {
      method: "POST",
      headers: { cookie: session.session, "content-type": "application/x-www-form-urlencoded" },
      body: "url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets%2Fpull%2F12",
    });
    expect(tokenless.status).toBe(403);
    expect(enqueued).toEqual([]);

    const allowed = await app.request("/reviews", {
      method: "POST",
      headers: {
        cookie: session.cookies,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets%2Fpull%2F12&csrf_token=${encodeURIComponent(session.csrfToken)}`,
    });
    expect(allowed.status).toBe(302);
    expect(allowed.headers.get("location")).toMatch(/notice=queued/);
    expect(enqueued).toEqual([1]);
  });

  it("rejects tokenless, forged, mismatched, expired, and non-form form posts when the gate is on", async () => {
    const { app, webhookSecret } = testApp(
      { UI_PASSWORD: "hunter2", UI_SESSION_SECRET: "session-secret-for-tests" },
      mockGithub(),
    );

    const tokenlessLogin = await app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=hunter2&next=%2F",
    });
    expect(tokenlessLogin.status).toBe(403);
    const retry = await csrfArtifacts(tokenlessLogin);
    expect(retry.html).toContain("was missing or expired");

    const forged = await app.request("/login", {
      method: "POST",
      headers: { cookie: retry.csrfCookie, "content-type": "application/x-www-form-urlencoded" },
      body: `password=hunter2&next=%2F&csrf_token=${encodeURIComponent("v1.tampered")}`,
    });
    expect(forged.status).toBe(403);

    const session = await loginSession(app);

    const tokenlessReviews = await app.request("/reviews", {
      method: "POST",
      headers: { cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: "url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets%2Fpull%2F12",
    });
    expect(tokenlessReviews.status).toBe(403);
    expect(await tokenlessReviews.text()).toContain("missing a valid CSRF token");

    const mismatched = await app.request("/reviews", {
      method: "POST",
      headers: { cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: `url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets%2Fpull%2F12&csrf_token=${encodeURIComponent(
        issueCsrfToken("session-secret-for-tests"),
      )}`,
    });
    expect(mismatched.status).toBe(403);

    const expiredToken = issueCsrfToken("session-secret-for-tests", Date.now() - 1_000, 500);
    const expired = await app.request("/reviews", {
      method: "POST",
      headers: {
        cookie: `${CSRF_COOKIE}=${expiredToken}; ${session.session}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets%2Fpull%2F12&csrf_token=${encodeURIComponent(expiredToken)}`,
    });
    expect(expired.status).toBe(403);

    const jsonBody = await app.request("/reviews", {
      method: "POST",
      headers: { cookie: session.cookies, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://github.com/acme/widgets/pull/12", csrf_token: session.csrfToken }),
    });
    expect(jsonBody.status).toBe(403);

    const tokenlessLogout = await app.request("/logout", { method: "POST", headers: { cookie: session.cookies } });
    expect(tokenlessLogout.status).toBe(403);

    const home = await app.request("/", { headers: { cookie: session.cookies } });
    const homeHtml = await home.text();
    const homeToken = homeHtml.match(/name="csrf_token" value="([^"]+)"/)?.[1];
    expect(homeToken).toBeTruthy();
    expect(session.cookies).toContain(homeToken!);

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
  });

  it("issues the csrf cookie with the same protections as the session cookie", async () => {
    const { app } = testApp({ UI_PASSWORD: "hunter2", UI_SESSION_SECRET: "session-secret-for-tests" });
    const page = await app.request("https://maomao.example/login");
    const raw = page.headers.get("set-cookie") ?? "";
    const csrfSegment = raw.split(",").find((part) => part.includes(CSRF_COOKIE)) ?? raw;
    expect(csrfSegment).toContain("HttpOnly");
    expect(csrfSegment).toMatch(/samesite=lax/i);
    expect(csrfSegment).toMatch(/secure/i);
    expect(csrfSegment).toContain("Path=/");
    expect(csrfSegment).toContain("Max-Age=");
  });

  it("logs out with a valid token and clears the session", async () => {
    const { app } = testApp(
      { UI_PASSWORD: "hunter2", UI_SESSION_SECRET: "session-secret-for-tests" },
      mockGithub(),
    );
    const session = await loginSession(app);
    const logout = await app.request("/logout", {
      method: "POST",
      headers: { cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: `csrf_token=${encodeURIComponent(session.csrfToken)}`,
    });
    expect(logout.status).toBe(302);
    expect(logout.headers.get("location")).toBe("/login");
    expect(logout.headers.get("set-cookie") ?? "").toMatch(new RegExp(`${SESSION_COOKIE}=;`));
  });

  it("enforces the csrf token on reviewer retry posts when the gate is on", async () => {
    const { app, store, enqueued } = testApp(
      { UI_PASSWORD: "hunter2", UI_SESSION_SECRET: "session-secret-for-tests" },
      mockGithub(),
    );
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
    const session = await loginSession(app);

    const tokenless = await app.request(`/jobs/${created.job.id}/reviewers/${run.id}/retry`, {
      method: "POST",
      headers: { cookie: session.cookies },
    });
    expect(tokenless.status).toBe(403);
    expect(store.getReviewerRun(run.id)?.state).toBe("failed");
    expect(enqueued).toEqual([]);

    const jobPage = await app.request(`/jobs/${created.job.id}`, { headers: { cookie: session.cookies } });
    const pageToken = (await jobPage.text()).match(/name="csrf_token" value="([^"]+)"/)?.[1];
    expect(pageToken).toBeTruthy();

    const allowed = await app.request(`/jobs/${created.job.id}/reviewers/${run.id}/retry`, {
      method: "POST",
      headers: { cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: `csrf_token=${encodeURIComponent(pageToken!)}`,
    });
    expect(allowed.status).toBe(302);
    expect(allowed.headers.get("location")).toBe(`/jobs/${created.job.id}?notice=retry`);
    expect(enqueued).toEqual([created.job.id]);
    expect(store.getReviewerRun(run.id)?.state).toBe("queued");
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

describe("oauth operator login", () => {
  const oauthEnv = {
    UI_SESSION_SECRET: "session-secret-for-tests",
    GITHUB_OAUTH_CLIENT_ID: "cid",
    GITHUB_OAUTH_CLIENT_SECRET: "csecret",
    MAOMAO_ADMIN_GITHUB_IDS: "1001",
    MAOMAO_PUBLIC_URL: "https://maomao.example",
  };

  function stateFrom(location: string | null): string {
    const match = location?.match(/state=([^&]+)/);
    if (!match?.[1]) throw new Error(`missing state in ${location}`);
    return match[1];
  }

  it("logs in an allowlisted GitHub user and rotates the session", async () => {
    const { app } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));

    const loginPage = await app.request("/login");
    const pageHtml = await loginPage.text();
    expect(pageHtml).toContain("Sign in with GitHub");
    expect(pageHtml).not.toContain('name="password"');

    const start = await app.request("/login/github?next=%2Fjobs%2F9");
    expect(start.status).toBe(302);
    const authorize = start.headers.get("location") ?? "";
    expect(authorize).toContain("https://github.com/login/oauth/authorize");
    expect(authorize).toContain("client_id=cid");
    expect(decodeURIComponent(authorize)).toContain("https://maomao.example/login/github/callback");
    const state = stateFrom(authorize);

    const callback = await app.request(`/login/github/callback?code=good-code&state=${state}`);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/jobs/9");
    const sessionCookie = cookieFrom(callback);
    const setCookie = callback.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toMatch(/samesite=lax/i);

    const home = await app.request("/", { headers: { cookie: sessionCookie } });
    const homeHtml = await home.text();
    expect(homeHtml).toContain("signed in as <strong>octocat</strong>");
    expect(homeHtml).not.toContain("human-access-token");
  });

  it("denies a valid GitHub user who is not on the admin id allowlist", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 4242, login: "outsider" }));
    const start = await app.request("/login/github");
    const state = stateFrom(start.headers.get("location"));
    const callback = await app.request(`/login/github/callback?code=good-code&state=${state}`);
    expect(callback.status).toBe(403);
    expect(await callback.text()).toContain("not authorized to operate this Maomao instance");
    // The deny path clears the stale session cookie instead of leaving it in place.
    expect(callback.headers.get("set-cookie") ?? "").toContain(`${SESSION_COOKIE}=;`);
    expect(String(warn.mock.calls.find(([msg]) => String(msg).includes("oauth login denied"))?.[0])).toContain("id=4242");
    warn.mockRestore();
  });

  it("rejects replayed, foreign, and failed states single-use", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));
    const start = await app.request("/login/github");
    const state = stateFrom(start.headers.get("location"));

    const first = await app.request(`/login/github/callback?code=good-code&state=${state}`);
    expect(first.status).toBe(302);

    const replay = await app.request(`/login/github/callback?code=good-code&state=${state}`);
    expect(replay.status).toBe(403);
    expect(await replay.text()).toContain("could not be verified");

    const foreign = await app.request(`/login/github/callback?code=good-code&state=bogus`);
    expect(foreign.status).toBe(403);
    warn.mockRestore();
  });

  it("renders a provider failure without leaking secrets", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }, { tokenFail: true }));
    const start = await app.request("/login/github");
    const state = stateFrom(start.headers.get("location"));
    const callback = await app.request(`/login/github/callback?code=good-code&state=${state}`);
    expect(callback.status).toBe(502);
    const html = await callback.text();
    expect(html).toContain("GitHub sign-in failed");
    expect(html).not.toContain("csecret");
    expect(html).not.toContain("human-access-token");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("rate limits repeated callback failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));
    for (let i = 0; i < 10; i += 1) {
      const res = await app.request(`/login/github/callback?code=good-code&state=bogus`);
      expect(res.status).toBe(403);
    }
    const blocked = await app.request(`/login/github/callback?code=good-code&state=bogus`);
    expect(blocked.status).toBe(429);
    warn.mockRestore();
  });

  it("revokes live sessions as soon as the id leaves the allowlist", async () => {
    const { app } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));
    const start = await app.request("/login/github");
    const state = stateFrom(start.headers.get("location"));
    const callback = await app.request(`/login/github/callback?code=good-code&state=${state}`);
    const cookie = cookieFrom(callback);

    const revoked = testApp(
      { ...oauthEnv, MAOMAO_ADMIN_GITHUB_IDS: "9999" },
      undefined,
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const denied = await revoked.app.request("/", { headers: { cookie } });
    expect(denied.status).toBe(403);
    const api = await revoked.app.request("/api/jobs", { headers: { cookie } });
    expect(api.status).toBe(403);
  });

  it("keeps the emergency local login hidden unless explicitly enabled", async () => {
    const { app } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));

    const hidden = await app.request("/login");
    expect((await hidden.text())).not.toContain('name="password"');

    const forcedPost = await app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=hunter2&next=%2F",
    });
    // The csrf gate rejects the tokenless post before the password route is even reached.
    expect(forcedPost.status).toBe(403);
    expect(forcedPost.headers.get("set-cookie") ?? "").not.toContain(SESSION_COOKIE);

    const enabled = testApp({ ...oauthEnv, UI_LOCAL_LOGIN: "true", UI_PASSWORD: "hunter2" });
    const page = await enabled.app.request("/login");
    const html = await page.text();
    expect(html).toContain("Sign in with GitHub");
    expect(html).toContain('name="password"');
  });
});

describe("oauth operator login hardening", () => {
  const oauthEnv = {
    UI_SESSION_SECRET: "session-secret-for-tests",
    GITHUB_OAUTH_CLIENT_ID: "cid",
    GITHUB_OAUTH_CLIENT_SECRET: "csecret",
    MAOMAO_ADMIN_GITHUB_IDS: "1001",
    MAOMAO_PUBLIC_URL: "https://maomao.example",
  };

  function stateFrom(location: string | null): string {
    const match = location?.match(/state=([^&]+)/);
    if (!match?.[1]) throw new Error(`missing state in ${location}`);
    return match[1];
  }

  it("treats a provider-side cancel as user action, not a failure", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));
    for (let i = 0; i < 12; i += 1) {
      const start = await app.request("/login/github");
      const state = stateFrom(start.headers.get("location"));
      const cancelled = await app.request(`/login/github/callback?error=access_denied&state=${state}`);
      expect(cancelled.status).toBe(400);
      expect(await cancelled.text()).toContain("was cancelled");
    }
    expect(log.mock.calls.some(([msg]) => String(msg).includes("not completed at provider"))).toBe(true);
    log.mockRestore();
  });

  it("refuses the disabled password route even with a valid csrf token and empty password", async () => {
    const { app } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));
    const start = await app.request("/login/github");
    const state = stateFrom(start.headers.get("location"));
    const callback = await app.request(`/login/github/callback?code=good-code&state=${state}`);
    const session = cookieFrom(callback);

    const page = await app.request("/", { headers: { cookie: session } });
    const { csrfCookie, csrfToken } = await csrfArtifacts(page);
    const post = await app.request("/login", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `password=&next=%2F&csrf_token=${encodeURIComponent(csrfToken)}`,
    });
    expect(post.status).toBe(302);
    expect(post.headers.get("location")).toBe("/login");
    expect(post.headers.get("set-cookie") ?? "").not.toMatch(new RegExp(`${SESSION_COOKIE}=v1`));
  });

  it("replaces a pre-existing (attacker-chosen) session cookie at login", async () => {
    const { app } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));
    const attackerCookie = `${SESSION_COOKIE}=v2.attacker.9999999999999.1001.YXR0YWNrZXI..sig`;
    const start = await app.request("/login/github", { headers: { cookie: attackerCookie } });
    const state = stateFrom(start.headers.get("location"));
    const callback = await app.request(
      `/login/github/callback?code=good-code&state=${state}`,
      { headers: { cookie: attackerCookie } },
    );
    expect(callback.status).toBe(302);
    const fresh = cookieFrom(callback);
    expect(fresh).not.toBe(attackerCookie);
    expect((callback.headers.get("set-cookie") ?? "").match(/maomao_session=([^;]+)/)?.[1]).toBeTruthy();
  });

  it("logs out an oauth session and clears its cookie", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));
    const start = await app.request("/login/github");
    const state = stateFrom(start.headers.get("location"));
    const callback = await app.request(`/login/github/callback?code=good-code&state=${state}`);
    const session = cookieFrom(callback);

    const page = await app.request("/", { headers: { cookie: session } });
    const { csrfCookie, csrfToken } = await csrfArtifacts(page);
    const logout = await app.request("/logout", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `csrf_token=${encodeURIComponent(csrfToken)}`,
    });
    expect(logout.status).toBe(302);
    expect(logout.headers.get("location")).toBe("/login");
    expect(logout.headers.get("set-cookie") ?? "").toContain(`${SESSION_COOKIE}=;`);
    expect(log.mock.calls.some(([msg]) => String(msg).includes("auth: logout"))).toBe(true);
    log.mockRestore();
  });

  it("keeps csrf enforcement active for oauth sessions", async () => {
    const { app } = testApp(oauthEnv, mockGithub(), mockOauthFetch({ id: 1001, login: "octocat" }));
    const start = await app.request("/login/github");
    const state = stateFrom(start.headers.get("location"));
    const callback = await app.request(`/login/github/callback?code=good-code&state=${state}`);
    const session = cookieFrom(callback);

    const tokenless = await app.request("/reviews", {
      method: "POST",
      headers: { cookie: session, "content-type": "application/x-www-form-urlencoded" },
      body: "url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets%2Fpull%2F12",
    });
    expect(tokenless.status).toBe(403);
  });
});

describe("review configuration routes", () => {
  const oauthEnv = {
    UI_SESSION_SECRET: "session-secret-for-tests",
    GITHUB_OAUTH_CLIENT_ID: "cid",
    GITHUB_OAUTH_CLIENT_SECRET: "csecret",
    MAOMAO_ADMIN_GITHUB_IDS: "1001",
    MAOMAO_PUBLIC_URL: "https://maomao.example",
  };
  const definition = {
    name: "default",
    reviewers: [{ role: "correctness" }],
    minPublishableSeverity: "medium",
  };

  async function oauthSession(app: ReturnType<typeof createApp>): Promise<string> {
    const start = await app.request("/login/github");
    const state = start.headers.get("location")?.match(/state=([^&]+)/)?.[1];
    if (!state) throw new Error("missing oauth state");
    const callback = await app.request(`/login/github/callback?code=good-code&state=${state}`);
    return cookieFrom(callback);
  }

  it("denies config writes without an oauth identity and allows them for operators", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, store } = testApp(
      { ...oauthEnv, UI_PASSWORD: "hunter2", UI_LOCAL_LOGIN: "true" },
      mockGithub(),
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );

    // Password-only session: the config page reads fine, but writes are denied.
    const page = await app.request("/login");
    const { csrfCookie, csrfToken } = await csrfArtifacts(page);
    const login = await app.request("/login", {
      method: "POST",
      headers: { cookie: csrfCookie, "content-type": "application/x-www-form-urlencoded" },
      body: `password=hunter2&next=%2F&csrf_token=${encodeURIComponent(csrfToken)}`,
    });
    const passwordCookies = cookieFrom(login);

    const denied = await app.request("/config/drafts", {
      method: "POST",
      headers: { cookie: passwordCookies, "content-type": "application/x-www-form-urlencoded" },
      body: `definition=${encodeURIComponent(JSON.stringify(definition))}`,
    });
    expect(denied.status).toBe(403);
    expect(store.configs.listRevisions()).toEqual([]);

    // OAuth operator session: the same write succeeds.
    const start = await app.request("/login/github");
    const state = start.headers.get("location")?.match(/state=([^&]+)/)?.[1] ?? "";
    const callback = await app.request(`/login/github/callback?code=good-code&state=${state}`);
    const session = cookieFrom(callback);
    const configPage = await app.request("/config", { headers: { cookie: session } });
    const artifacts = await csrfArtifacts(configPage);

    const created = await app.request("/config/drafts", {
      method: "POST",
      headers: {
        cookie: `${session}; ${artifacts.csrfCookie}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `definition=${encodeURIComponent(JSON.stringify(definition))}&csrf_token=${encodeURIComponent(artifacts.csrfToken)}`,
    });
    expect(created.status).toBe(302);
    expect(created.headers.get("location")).toContain("draft-created");
    expect(store.configs.listRevisions()).toHaveLength(1);
    expect(store.configs.listRevisions()[0]?.created_by).toBe("octocat");
    warn.mockRestore();
    log.mockRestore();
  });

  it("conflicts on a stale draft save and exports without credentials", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, store } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));
    const start = await app.request("/login/github");
    const state = start.headers.get("location")?.match(/state=([^&]+)/)?.[1] ?? "";
    const callback = await app.request(`/login/github/callback?code=good-code&state=${state}`);
    const session = cookieFrom(callback);

    store.configs.createDraft({ definition, createdBy: "octocat" });
    const draft = store.configs.listRevisions()[0];

    const configPage = await app.request("/config", { headers: { cookie: session } });
    const { csrfCookie, csrfToken } = await csrfArtifacts(configPage);

    const conflict = await app.request(`/config/drafts/${draft.id}`, {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `definition=${encodeURIComponent(JSON.stringify(definition))}&expected_edit_seq=999&csrf_token=${encodeURIComponent(csrfToken)}`,
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).toContain("saved by someone else");

    const exportData = (await (await app.request("/config/export", { headers: { cookie: session } })).json()) as {
      schema_version: number;
      revisions: unknown[];
    };
    expect(exportData.schema_version).toBe(1);
    expect(JSON.stringify(exportData)).not.toContain("secret");
    log.mockRestore();
  });
});

describe("prompt configuration routes", () => {
  const oauthEnv = {
    UI_SESSION_SECRET: "session-secret-for-tests",
    GITHUB_OAUTH_CLIENT_ID: "cid",
    GITHUB_OAUTH_CLIENT_SECRET: "csecret",
    MAOMAO_ADMIN_GITHUB_IDS: "1001",
    MAOMAO_PUBLIC_URL: "https://maomao.example",
  };

  it("denies prompt writes to password-only sessions (no operator identity)", async () => {
    const { app, store } = testApp({ UI_PASSWORD: "hunter2", UI_SESSION_SECRET: "session-secret-for-tests" });

    const page = await app.request("/login");
    const { csrfCookie, csrfToken } = await csrfArtifacts(page);
    const login = await app.request("/login", {
      method: "POST",
      headers: { cookie: csrfCookie, "content-type": "application/x-www-form-urlencoded" },
      body: `password=hunter2&next=%2F&csrf_token=${encodeURIComponent(csrfToken)}`,
    });
    const session = cookieFrom(login);
    const promptsPage = await app.request("/config/prompts", { headers: { cookie: session } });
    const pageArtifacts = await csrfArtifacts(promptsPage);

    const denied = await app.request("/config/prompts/drafts", {
      method: "POST",
      headers: { cookie: `${session}; ${pageArtifacts.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `role_id=correctness&body=${encodeURIComponent("Focus: leaked secrets.")}&csrf_token=${encodeURIComponent(pageArtifacts.csrfToken)}`,
    });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain("operator GitHub OAuth identity");
    expect(store.prompts.listPromptRevisions()).toEqual([]);
  });

  it("requires an operator identity for prompt writes and records the actor", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, store } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));

    const start = await app.request("/login/github");
    const state = start.headers.get("location")?.match(/state=([^&]+)/)?.[1] ?? "";
    const callback = await app.request(`/login/github/callback?code=good-code&state=${state}`);
    const session = cookieFrom(callback);
    const promptsPage = await app.request("/config/prompts", { headers: { cookie: session } });
    const pageArtifacts = await csrfArtifacts(promptsPage);

    const created = await app.request("/config/prompts/drafts", {
      method: "POST",
      headers: { cookie: `${session}; ${pageArtifacts.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `role_id=correctness&body=${encodeURIComponent("Focus: leaked secrets.")}&csrf_token=${encodeURIComponent(pageArtifacts.csrfToken)}`,
    });
    expect(created.status).toBe(302);
    const revision = store.prompts.listPromptRevisions()[0];
    expect(revision?.created_by).toBe("octocat");
    log.mockRestore();
  });

  it("evaluates a draft prompt against a fixture without any GitHub writes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, store } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));

    const start = await app.request("/login/github");
    const state = start.headers.get("location")?.match(/state=([^&]+)/)?.[1] ?? "";
    const callback = await app.request(`/login/github/callback?code=good-code&state=${state}`);
    const session = cookieFrom(callback);
    const promptsPage = await app.request("/config/prompts", { headers: { cookie: session } });
    const { csrfCookie, csrfToken } = await csrfArtifacts(promptsPage);

    const draft = store.prompts.createDraft({ roleId: "correctness", body: "Focus: leaked secrets.", createdBy: "octocat" });
    if (!("revision" in draft)) throw new Error("draft failed");
    const fixture = store.prompts.saveFixture({
      name: "leak",
      prMeta: { repo: "acme/widgets" },
      diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n x\n+console.log(secret);",
      expectations: [{ severity: "high" }],
      savedBy: "octocat",
      acknowledged: true,
    });
    if (!("fixture" in fixture)) throw new Error("fixture failed");

    const opencode: OpenCodeLike = {
      async run(input) {
        const text = JSON.stringify({
          schema_version: 1,
          reviewer: "correctness",
          verdict: "findings",
          findings: [
            { severity: "high", confidence: 0.9, category: "correctness", file: "a.ts", line: 2, summary: "secret logged", reason: "evidence" },
          ],
        });
        void input;
        return { stdout: text, stderr: "", exitCode: 0, text, usage: { cost: 0.01, totalTokens: 10, complete: true } };
      },
    };
    const evalApp = createApp({
      config: loadConfig(oauthEnv),
      store,
      queue: { enqueue() {}, abortMany() {} } as unknown as JobQueue,
      startedAt: Date.now(),
      oauthFetch: mockOauthFetch({ id: 1001, login: "octocat" }),
      opencode: opencode as unknown as OpenCodePort,
    });
    const evalStart = await evalApp.request("/login/github");
    const evalState = evalStart.headers.get("location")?.match(/state=([^&]+)/)?.[1] ?? "";
    const evalCallback = await evalApp.request(`/login/github/callback?code=good-code&state=${evalState}`);
    const evalSession = cookieFrom(evalCallback);
    const evalPage = await evalApp.request("/config/prompts", { headers: { cookie: evalSession } });
    const evalArtifacts = await csrfArtifacts(evalPage);

    const evaluate = await evalApp.request("/config/prompts/evaluate", {
      method: "POST",
      headers: { cookie: `${evalSession}; ${evalArtifacts.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `prompt_revision_id=${draft.revision.id}&fixture_id=${fixture.fixture.id}&model=test/model&csrf_token=${encodeURIComponent(evalArtifacts.csrfToken)}`,
    });
    expect(evaluate.status).toBe(302);
    const evaluation = store.prompts.listEvaluations()[0];
    expect(evaluation?.status).toBe("completed");
    log.mockRestore();
  });
});

describe("health scan routes", () => {
  const oauthEnv = {
    UI_SESSION_SECRET: "session-secret-for-tests",
    GITHUB_OAUTH_CLIENT_ID: "cid",
    GITHUB_OAUTH_CLIENT_SECRET: "csecret",
    MAOMAO_ADMIN_GITHUB_IDS: "1001",
    MAOMAO_PUBLIC_URL: "https://maomao.example",
  };

  function scanGithub(): ManualTriggerPort & Partial<GithubPort> {
    return {
      getRepoInstallation: async () => ({ installationId: 42, accountId: 1001 }),
      getRepository: async () => ({ id: 2002 }),
      getRepositoryHead: async () => ({ defaultBranch: "main", headSha: "head111head111head111head111head11111" }),
      getCommitDiff: async () => "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n x\n+console.log(secret);",
      listReviewThreads: async () => [],
      resolveReviewThread: async () => {},
      unresolveReviewThread: async () => {},
      getCollaboratorPermission: async () => "write",
      getInstallationToken: async () => "t",
    } as unknown as ManualTriggerPort & Partial<GithubPort>;
  }

  async function operatorCsrf(app: ReturnType<typeof createApp>, session: string) {
    const scanPage = await app.request("/scan", { headers: { cookie: session } });
    expect(scanPage.status).toBe(200);
    const artifacts = await csrfArtifacts(scanPage);
    return { ...artifacts, html: artifacts.html };
  }

  /** Step 1 of the scan flow: POST the repo, returning the rendered confirmation page. */
  async function scanPreview(
    app: ReturnType<typeof createApp>,
    session: string,
    csrfCookie: string,
    csrfToken: string,
  ): Promise<string> {
    const preview = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `repo=acme%2Fwidgets&csrf_token=${encodeURIComponent(csrfToken)}`,
    });
    expect(preview.status).toBe(200);
    return preview.text();
  }

  /** Step 2 of the scan flow: POST the confirmation fields shown on a preview page. */
  function confirmBody(html: string, csrfToken: string, overrides: Record<string, string> = {}): string {
    const fields = new URLSearchParams({
      repo: hiddenValue(html, "repo"),
      branch: hiddenValue(html, "branch"),
      sha: hiddenValue(html, "sha"),
      revision_id: hiddenValue(html, "revision_id"),
      csrf_token: csrfToken,
      ...overrides,
    });
    return fields.toString();
  }

  it("queues a scan only for operators, pinned to the confirmed head SHA", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, store } = testApp(oauthEnv, scanGithub(), mockOauthFetch({ id: 1001, login: "octocat" }));

    // Unauthenticated scan attempts are redirected to the login page by the session gate.
    const deniedGet = await app.request("/scan");
    expect(deniedGet.status).toBe(302);
    expect(deniedGet.headers.get("location")).toContain("/login");
    const denied = await app.request("/scan", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "repo=acme/widgets",
    });
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")).toContain("/login");
    expect(store.listJobs()).toEqual([]);

    const session = await operatorSession(app);
    const page = await operatorCsrf(app, session);
    expect(page.html).toContain('href="/scan"'); // reachable from the header nav

    // Step 1 shows the resolved branch + exact head SHA and enqueues nothing.
    const previewHtml = await scanPreview(app, session, page.csrfCookie, page.csrfToken);
    expect(previewHtml).toContain("Confirm repository health scan");
    expect(previewHtml).toContain("head111head111head111head111head11111");
    expect(hiddenValue(previewHtml, "branch")).toBe("main");
    expect(store.listJobs()).toEqual([]);

    // Step 2 (operator confirms the shown revision) enqueues one pinned scan. The
    // confirming fields are read back from the rendered form, not restated.
    const queued = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${page.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: confirmBody(previewHtml, page.csrfToken),
    });
    expect(queued.status).toBe(302);
    const job = store.listJobs()[0];
    expect(job.job_type).toBe("health_scan");
    expect(job.head_sha).toBe("head111head111head111head111head11111");
    expect(job.pr_number).toBe(0);
    log.mockRestore();
  });

  it("re-renders with a notice instead of enqueueing when the default branch moved after the operator confirmed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, store } = testApp(oauthEnv, scanGithub(), mockOauthFetch({ id: 1001, login: "octocat" }));
    const session = await operatorSession(app);
    const page = await operatorCsrf(app, session);
    const previewHtml = await scanPreview(app, session, page.csrfCookie, page.csrfToken);

    // The operator sat on the confirmation page while the branch advanced: the
    // confirming POST still carries the SHA that was shown at preview time.
    const stale = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${page.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: confirmBody(previewHtml, page.csrfToken, { sha: "oldsha" }),
    });
    expect(stale.status).toBe(200);
    const staleHtml = await stale.text();
    expect(staleHtml).toContain("moved since you confirmed");
    expect(staleHtml).toContain("oldsha");
    expect(hiddenValue(staleHtml, "sha")).toBe("head111head111head111head111head11111");
    expect(store.listJobs()).toEqual([]);
    log.mockRestore();
  });

  it("re-renders with a notice instead of enqueueing when only the confirmed branch name is stale", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, store } = testApp(oauthEnv, scanGithub(), mockOauthFetch({ id: 1001, login: "octocat" }));
    const session = await operatorSession(app);
    const page = await operatorCsrf(app, session);
    const previewHtml = await scanPreview(app, session, page.csrfCookie, page.csrfToken);

    const stale = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${page.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: confirmBody(previewHtml, page.csrfToken, { branch: "develop" }),
    });
    expect(stale.status).toBe(200);
    const staleHtml = await stale.text();
    expect(staleHtml).toContain("you confirmed (develop)");
    expect(store.listJobs()).toEqual([]);
    log.mockRestore();
  });

  it("shows the active revision's severity floor on the confirm page and snapshots the confirmed revision", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, store } = testApp(oauthEnv, scanGithub(), mockOauthFetch({ id: 1001, login: "octocat" }));
    const created = store.configs.createDraft({
      definition: { name: "default", reviewers: [{ role: "correctness" }], minPublishableSeverity: "high" },
      createdBy: "octocat",
    });
    if ("error" in created) throw new Error("fixture draft rejected");
    const activated = store.configs.activateRevision(created.revision.id, "octocat");
    if ("error" in activated) throw new Error(`fixture activation failed: ${activated.error}`);
    const session = await operatorSession(app);
    const page = await operatorCsrf(app, session);

    const preview = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${page.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `repo=acme%2Fwidgets&csrf_token=${encodeURIComponent(page.csrfToken)}`,
    });
    expect(preview.status).toBe(200);
    const previewHtml = await preview.text();
    expect(previewHtml).toContain(">high<");
    expect(previewHtml).toContain(`<code>#${created.revision.id}</code>`);
    expect(hiddenValue(previewHtml, "revision_id")).toBe(String(created.revision.id));

    const queued = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${page.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: confirmBody(previewHtml, page.csrfToken),
    });
    expect(queued.status).toBe(302);
    expect(store.listJobs()[0]?.profile_revision_id).toBe(created.revision.id);
    log.mockRestore();
  });

  it("does not spend the scan rate budget when only rendering the confirmation", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, store } = testApp(
      { ...oauthEnv, REPO_RATE_LIMIT_PER_WINDOW: "1", REPO_RATE_WINDOW_MS: "3600000" },
      scanGithub(),
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const session = await operatorSession(app);
    const page = await operatorCsrf(app, session);

    // With a budget of 1, the confirm step can only succeed if the preview spent nothing.
    const preview = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${page.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `repo=acme%2Fwidgets&csrf_token=${encodeURIComponent(page.csrfToken)}`,
    });
    expect(preview.status).toBe(200);
    const previewHtml = await preview.text();

    const queued = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${page.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: confirmBody(previewHtml, page.csrfToken),
    });
    expect(queued.status).toBe(302);
    expect(queued.headers.get("location")).toContain("scan-queued");
    expect(store.listJobs()).toHaveLength(1);
    log.mockRestore();
  });

  it("rescanning the same confirmed SHA reports exists without creating a second job", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, store } = testApp(oauthEnv, scanGithub(), mockOauthFetch({ id: 1001, login: "octocat" }));
    const session = await operatorSession(app);
    const page = await operatorCsrf(app, session);
    const previewHtml = await scanPreview(app, session, page.csrfCookie, page.csrfToken);

    const first = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${page.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: confirmBody(previewHtml, page.csrfToken),
    });
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toContain("scan-queued");

    const duplicate = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${page.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: confirmBody(previewHtml, page.csrfToken),
    });
    expect(duplicate.status).toBe(302);
    expect(duplicate.headers.get("location")).toContain("notice=exists");
    expect(store.listJobs()).toHaveLength(1);
    log.mockRestore();
  });

  it("rate-limits scans with the same per-repository budget as manual reviews", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app, store } = testApp(
      { ...oauthEnv, REPO_RATE_LIMIT_PER_WINDOW: "1", REPO_RATE_WINDOW_MS: "3600000" },
      scanGithub(),
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const session = await operatorSession(app);
    const page = await operatorCsrf(app, session);
    const previewHtml = await scanPreview(app, session, page.csrfCookie, page.csrfToken);

    const first = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${page.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: confirmBody(previewHtml, page.csrfToken),
    });
    expect(first.status).toBe(302);
    expect(store.listJobs()).toHaveLength(1);

    const second = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${page.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `repo=acme%2Fwidgets&csrf_token=${encodeURIComponent(page.csrfToken)}`,
    });
    expect(second.status).toBe(429);
    expect(await second.text()).toContain("Rate limited");
    expect(store.listJobs()).toHaveLength(1);
    log.mockRestore();
    warn.mockRestore();
  });

  it("rejects a scan POST without a valid CSRF token before touching GitHub", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app, store } = testApp(oauthEnv, scanGithub(), mockOauthFetch({ id: 1001, login: "octocat" }));
    const session = await operatorSession(app);

    const rejected = await app.request("/scan", {
      method: "POST",
      headers: { cookie: session, "content-type": "application/x-www-form-urlencoded" },
      body: "repo=acme%2Fwidgets&branch=main&sha=head111head111head111head111head11111",
    });
    expect(rejected.status).toBe(403);
    expect(store.listJobs()).toEqual([]);
    warn.mockRestore();
  });

  it("rejects scans of repositories outside the account allowlist before any GitHub call but the installation lookup", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const github = scanGithub();
    let headCalls = 0;
    github.getRepositoryHead = async () => {
      headCalls += 1;
      return { defaultBranch: "main", headSha: "x" };
    };
    const { app, store } = testApp({ ...oauthEnv, ALLOWED_GITHUB_ACCOUNT_IDS: "999999" }, github, mockOauthFetch({ id: 1001, login: "octocat" }));
    const session = await operatorSession(app);
    const page = await operatorCsrf(app, session);

    const denied = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${page.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `repo=acme%2Fwidgets&csrf_token=${encodeURIComponent(page.csrfToken)}`,
    });
    expect(denied.status).toBe(403);
    expect(headCalls).toBe(0);
    expect(store.listJobs()).toEqual([]);
    warn.mockRestore();
  });

  it("rejects scans of repositories outside the repository allowlist before head resolution", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const github = scanGithub();
    let headCalls = 0;
    github.getRepositoryHead = async () => {
      headCalls += 1;
      return { defaultBranch: "main", headSha: "x" };
    };
    const { app, store } = testApp(
      { ...oauthEnv, ALLOWED_GITHUB_ACCOUNT_IDS: "1001", ALLOWED_GITHUB_REPOSITORY_IDS: "999999" },
      github,
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const session = await operatorSession(app);
    const page = await operatorCsrf(app, session);

    const denied = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${page.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `repo=acme%2Fwidgets&csrf_token=${encodeURIComponent(page.csrfToken)}`,
    });
    expect(denied.status).toBe(403);
    expect(headCalls).toBe(0);
    expect(store.listJobs()).toEqual([]);
    warn.mockRestore();
  });

  it("re-renders with a revision notice instead of enqueueing when the active revision changed after preview", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, store } = testApp(oauthEnv, scanGithub(), mockOauthFetch({ id: 1001, login: "octocat" }));
    const activate = (definition: Record<string, unknown>) => {
      const created = store.configs.createDraft({ definition, createdBy: "octocat" });
      if ("error" in created) throw new Error("fixture draft rejected");
      const activated = store.configs.activateRevision(created.revision.id, "octocat");
      if ("error" in activated) throw new Error(`fixture activation failed: ${activated.error}`);
      return created.revision.id;
    };
    const oldRevisionId = activate({ name: "default", reviewers: [{ role: "correctness" }], minPublishableSeverity: "medium" });
    const session = await operatorSession(app);
    const page = await operatorCsrf(app, session);
    const previewHtml = await scanPreview(app, session, page.csrfCookie, page.csrfToken);
    expect(hiddenValue(previewHtml, "revision_id")).toBe(String(oldRevisionId));

    // The operator sat on the confirmation page while revision B was published.
    const newRevisionId = activate({ name: "default", reviewers: [{ role: "correctness" }, { role: "security" }], minPublishableSeverity: "high" });
    const stale = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${page.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: confirmBody(previewHtml, page.csrfToken),
    });
    expect(stale.status).toBe(200);
    const staleHtml = await stale.text();
    expect(staleHtml).toContain("profile revision changed");
    expect(hiddenValue(staleHtml, "revision_id")).toBe(String(newRevisionId));
    expect(store.listJobs()).toEqual([]);
    log.mockRestore();
  });

  it("renders the incomplete-confirmation notice for a partially populated confirm POST", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, store } = testApp(oauthEnv, scanGithub(), mockOauthFetch({ id: 1001, login: "octocat" }));
    const created = store.configs.createDraft({
      definition: { name: "default", reviewers: [{ role: "correctness" }], minPublishableSeverity: "medium" },
      createdBy: "octocat",
    });
    if ("error" in created) throw new Error("fixture draft rejected");
    const activated = store.configs.activateRevision(created.revision.id, "octocat");
    if ("error" in activated) throw new Error(`fixture activation failed: ${activated.error}`);
    const session = await operatorSession(app);
    const page = await operatorCsrf(app, session);
    const previewHtml = await scanPreview(app, session, page.csrfCookie, page.csrfToken);

    // Correct revision id but no sha/branch: a confirmation attempt, not a preview.
    const partial = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${page.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `repo=acme%2Fwidgets&revision_id=${encodeURIComponent(hiddenValue(previewHtml, "revision_id"))}&csrf_token=${encodeURIComponent(page.csrfToken)}`,
    });
    expect(partial.status).toBe(200);
    expect(await partial.text()).toContain("Confirmation incomplete");
    expect(store.listJobs()).toEqual([]);
    log.mockRestore();
  });

  it("returns 502 and enqueues nothing when GitHub yields a malformed repository id", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const github = scanGithub();
    github.getRepository = async () => ({ id: 0 });
    const { app, store } = testApp(oauthEnv, github, mockOauthFetch({ id: 1001, login: "octocat" }));
    const session = await operatorSession(app);
    const page = await operatorCsrf(app, session);

    const preview = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${page.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `repo=acme%2Fwidgets&csrf_token=${encodeURIComponent(page.csrfToken)}`,
    });
    expect(preview.status).toBe(502);
    expect(await preview.text()).toContain("Could not resolve a valid repository id");
    expect(store.listJobs()).toEqual([]);
    log.mockRestore();
    warn.mockRestore();
  });

  it("logs unexpected scan-start failures server-side and returns 400", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const github = scanGithub();
    github.getRepositoryHead = async () => {
      throw new Error("upstream exploded");
    };
    const { app, store } = testApp(oauthEnv, github, mockOauthFetch({ id: 1001, login: "octocat" }));
    const session = await operatorSession(app);
    const page = await operatorCsrf(app, session);

    const failed = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${page.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `repo=acme%2Fwidgets&csrf_token=${encodeURIComponent(page.csrfToken)}`,
    });
    expect(failed.status).toBe(400);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("acme/widgets"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("upstream exploded"));
    expect(store.listJobs()).toEqual([]);
    log.mockRestore();
    errorSpy.mockRestore();
  });

  it("does not spend the rate budget on a rejected (stale) confirmation", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, store } = testApp(
      { ...oauthEnv, REPO_RATE_LIMIT_PER_WINDOW: "1", REPO_RATE_WINDOW_MS: "3600000" },
      scanGithub(),
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const session = await operatorSession(app);
    const page = await operatorCsrf(app, session);
    const previewHtml = await scanPreview(app, session, page.csrfCookie, page.csrfToken);

    // The stale confirm re-renders without recording a hit, so the operator's
    // corrective confirm still fits in the budget of 1.
    const stale = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${page.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: confirmBody(previewHtml, page.csrfToken, { sha: "oldsha" }),
    });
    expect(stale.status).toBe(200);

    const retryHtml = await stale.text();
    const corrective = await app.request("/scan", {
      method: "POST",
      headers: { cookie: `${session}; ${page.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: confirmBody(retryHtml, page.csrfToken),
    });
    expect(corrective.status).toBe(302);
    expect(corrective.headers.get("location")).toContain("scan-queued");
    expect(store.listJobs()).toHaveLength(1);
    log.mockRestore();
  });
});

describe("scan issue creation", () => {
  const oauthEnv = {
    UI_SESSION_SECRET: "session-secret-for-tests",
    GITHUB_OAUTH_CLIENT_ID: "cid",
    GITHUB_OAUTH_CLIENT_SECRET: "csecret",
    MAOMAO_ADMIN_GITHUB_IDS: "1001",
    MAOMAO_PUBLIC_URL: "https://maomao.example",
  };
  const HEAD = "head111head111head111head111head11111";

  function seedScan(
    store: JobStore,
    options: { confidence?: number; agreed?: string[]; body?: string; diffHunk?: string; currentPath?: string; second?: boolean } = {},
  ): { jobId: number; fingerprints: string[] } {
    const findings = [
      {
        severity: "high",
        confidence: options.confidence ?? 0.9,
        category: "correctness",
        file: "a.ts",
        line: 2,
        summary: "secret logged",
        body: options.body ?? "evidence here",
        reviewers_agreed: options.agreed ?? ["correctness", "security"],
      },
    ];
    if (options.second) {
      findings.push({
        severity: "medium",
        confidence: 0.85,
        category: "correctness",
        file: "b.ts",
        line: 5,
        summary: "unbounded retry loop",
        body: "can spin forever",
        reviewers_agreed: ["correctness", "security"],
      });
    }
    const fingerprints = findings.map((finding) => fingerprintFinding(finding));
    const created = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 42,
      githubAccountId: 1001,
      githubRepositoryId: 2002,
      prNumber: 0,
      prTitle: "Repository health scan (main)",
      prBody: "",
      prHtmlUrl: "https://github.com/acme/widgets",
      prAuthor: "dev",
      baseSha: "s",
      headSha: HEAD,
      baseRef: "main",
      headRef: "main",
      jobType: "health_scan",
      reviewers: [],
    });
    store.patchJob(created.job.id, {
      aggregator_normalized: JSON.stringify({ schema_version: 1, verdict: "comment", summary: "scan aggregation", findings }),
    });
    store.setJobState(created.job.id, "completed", { finished_at: new Date().toISOString() });
    findings.forEach((finding, index) => {
      store.upsertFinding({
        repoFullName: "acme/widgets",
        prNumber: 0,
        fingerprint: fingerprints[index],
        status: "open",
        reviewedSha: HEAD,
        currentSha: HEAD,
        originalPath: index === 0 ? options.currentPath ?? finding.file : finding.file,
        originalLine: finding.line,
        currentPath: index === 0 ? options.currentPath ?? finding.file : finding.file,
        currentLine: finding.line,
        category: finding.category,
        summary: finding.summary,
        body: finding.body,
        severity: finding.severity,
        confidence: finding.confidence,
        diffHunk: index === 0 ? options.diffHunk : undefined,
        lastJobId: created.job.id,
      });
    });
    return { jobId: created.job.id, fingerprints };
  }

  function issueGithub(created: Array<{ title: string; body: string }>): ManualTriggerPort & Partial<GithubPort> {
    return {
      getRepoInstallation: async () => ({ installationId: 42, accountId: 1001 }),
      getRepository: async () => ({ id: 2002 }),
      listReviewThreads: async () => [],
      resolveReviewThread: async () => {},
      unresolveReviewThread: async () => {},
      getCollaboratorPermission: async () => "write",
      listOpenIssuesByMarker: async () => [],
      searchOpenIssues: async () => [],
      createIssue: async (_installationId: number, _owner: string, _repo: string, title: string, body: string) => {
        created.push({ title, body });
        return { number: 100 + created.length, url: `https://github.com/acme/widgets/issues/${100 + created.length}` };
      },
    } as unknown as ManualTriggerPort & Partial<GithubPort>;
  }

  function issuePostBody(jobId: number, fingerprints: string[], csrfToken: string): string {
    const params = new URLSearchParams({ job_id: String(jobId), csrf_token: csrfToken });
    for (const fingerprint of fingerprints) params.append("fp[]", fingerprint);
    return params.toString();
  }

  async function operatorWithCsrf(app: ReturnType<typeof createApp>) {
    const session = await operatorSession(app);
    const scanPage = await app.request("/scan", { headers: { cookie: session } });
    const { csrfCookie, csrfToken } = await csrfArtifacts(scanPage);
    return { session, csrfCookie, csrfToken };
  }

  it("blocks issue creation entirely while the capability is disabled", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, store } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));
    const seeded = seedScan(store);
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);
    const res = await app.request("/scan/issues", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `job_id=${seeded.jobId}&csrf_token=${encodeURIComponent(csrfToken)}`,
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("GITHUB_ISSUE_CREATION_ENABLED=false");
    log.mockRestore();
  });

  it("previews the proposed issue with the exact body, dedup state, and likely human duplicates", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const created: Array<{ title: string; body: string }> = [];
    const github = issueGithub(created);
    github.searchOpenIssues = async () => [
      { number: 7, title: "secret logged in handler", url: "https://github.com/acme/widgets/issues/7" },
    ];
    const { app, store } = testApp({ ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" }, github, mockOauthFetch({ id: 1001, login: "octocat" }));
    const seeded = seedScan(store);
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);

    const preview = await app.request("/scan/issues/preview", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, [seeded.fingerprints[0]], csrfToken),
    });
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain("Preview GitHub issues");
    expect(html).toContain("[maomao] HIGH: secret logged");
    expect(html).toContain("maomao-scan-issue");
    expect(html).toContain("Reviewed SHA");
    expect(html).toContain("Issues: write");
    expect(html).toContain("secret logged in handler"); // surfaced, never modified
    expect(created).toHaveLength(0); // preview never publishes
    log.mockRestore();
  });

  it("creates deduplicated issues with the hidden marker and records provenance", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const created: Array<{ title: string; body: string }> = [];
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" },
      issueGithub(created),
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const seeded = seedScan(store, { diffHunk: "+console.log(secret);" });
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);

    const res = await app.request("/scan/issues", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, [seeded.fingerprints[0]], csrfToken),
    });
    if (res.status !== 302) {
      throw new Error(`unexpected status ${res.status}; alert=${(await res.text()).match(/role="alert">([^<]*)/)?.[1]}`);
    }
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("issues-created");
    expect(created).toHaveLength(1);
    expect(created[0].title).toContain("[maomao] HIGH:");
    expect(created[0].body).toContain(`maomao-scan-issue ${seeded.fingerprints[0]} @ ${HEAD}`);
    expect(created[0].body).toContain(HEAD);
    expect(created[0].body).toContain("```diff");
    const recorded = store.listScanIssues(seeded.jobId)[0];
    expect(recorded?.issue_number).toBe(101);

    // Retry skips the already-created issue entirely.
    const retry = await app.request("/scan/issues", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, [seeded.fingerprints[0]], csrfToken),
    });
    expect(retry.status).toBe(302);
    expect(created).toHaveLength(1);
    log.mockRestore();
  });

  it("refuses to publish findings below the confidence and consensus publication bar", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const created: Array<{ title: string; body: string }> = [];
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" },
      issueGithub(created),
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const seeded = seedScan(store, { confidence: 0.4, agreed: ["correctness"] });
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);

    const res = await app.request("/scan/issues", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, [seeded.fingerprints[0]], csrfToken),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("publication bar");
    expect(created).toHaveLength(0);
    log.mockRestore();
    warn.mockRestore();
  });

  it("rejects selected fingerprints that do not belong to the scan", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const created: Array<{ title: string; body: string }> = [];
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" },
      issueGithub(created),
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const seeded = seedScan(store);
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);

    const res = await app.request("/scan/issues", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, ["bogusfingerprint1"], csrfToken),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("do not belong to this scan");
    expect(created).toHaveLength(0);
    log.mockRestore();
  });

  it("stops with an explicit notice when GitHub refuses the write, and the retry succeeds", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const created: Array<{ title: string; body: string }> = [];
    const github = issueGithub(created);
    github.createIssue = async () => {
      throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 });
    };
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" },
      github,
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const seeded = seedScan(store);
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);

    const denied = await app.request("/scan/issues", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, [seeded.fingerprints[0]], csrfToken),
    });
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")).toContain("issues-permission");
    // The pending claim was released, so a retry is possible.
    expect(store.listScanIssues(seeded.jobId)).toEqual([]);

    github.createIssue = async (_i, _o, _r, title, body) => {
      created.push({ title, body });
      return { number: 101, url: "https://github.com/acme/widgets/issues/101" };
    };
    const retry = await app.request("/scan/issues", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, [seeded.fingerprints[0]], csrfToken),
    });
    expect(retry.status).toBe(302);
    expect(retry.headers.get("location")).toContain("issues-created");
    expect(created).toHaveLength(1);
    log.mockRestore();
    warn.mockRestore();
  });

  it("links to an existing Maomao issue found by marker instead of creating a duplicate", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const created: Array<{ title: string; body: string }> = [];
    const github = issueGithub(created);
    github.listOpenIssuesByMarker = async () => [
      { number: 42, title: "maomao: secret logged", url: "https://github.com/acme/widgets/issues/42", state: "open" },
    ];
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" },
      github,
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const seeded = seedScan(store);
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);

    const res = await app.request("/scan/issues", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, [seeded.fingerprints[0]], csrfToken),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("issues-none:1"); // nothing created, nothing failed
    expect(created).toHaveLength(0);
    const recorded = store.listScanIssues(seeded.jobId)[0];
    expect(recorded?.issue_number).toBe(42);
    log.mockRestore();
  });

  it("reports partial failures and retries only the missing issue", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const created: Array<{ title: string; body: string }> = [];
    const github = issueGithub(created);
    let calls = 0;
    github.createIssue = async (_i, _o, _r, title, body) => {
      calls += 1;
      if (calls === 1) throw new Error("upstream hiccup");
      created.push({ title, body });
      return { number: 100 + created.length, url: `https://github.com/acme/widgets/issues/${100 + created.length}` };
    };
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" },
      github,
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const seeded = seedScan(store, { second: true });
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);

    const first = await app.request("/scan/issues", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, seeded.fingerprints, csrfToken),
    });
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toContain("issues-partial:1");
    expect(created).toHaveLength(1);

    // Retry publishes the missing one and does not duplicate the successful one.
    const retry = await app.request("/scan/issues", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, seeded.fingerprints, csrfToken),
    });
    expect(retry.status).toBe(302);
    expect(retry.headers.get("location")).toContain("issues-created");
    expect(created).toHaveLength(2);
    expect(new Set(created.map((issue) => issue.title)).size).toBe(2);
    log.mockRestore();
    warn.mockRestore();
  });

  it("neutralizes forged dedup markers and redacts secrets in published bodies", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const created: Array<{ title: string; body: string }> = [];
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" },
      issueGithub(created),
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const forged = `real evidence <!-- maomao-scan-issue deadbeef @ ${HEAD} --> plus webhook secret s3cret`;
    const seeded = seedScan(store, {
      body: forged,
      // The path and the diff hunk are sanitized separately from the body.
      currentPath: `a<!-- maomao-scan-issue deadbeef2 @ ${HEAD} -->.ts`,
      diffHunk: `+console.log("s3cret"); <!-- maomao-scan-issue deadbeef3 @ ${HEAD} -->`,
    });
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);

    const res = await app.request("/scan/issues", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, [seeded.fingerprints[0]], csrfToken),
    });
    expect(res.status).toBe(302);
    expect(created).toHaveLength(1);
    expect(created[0].body).toContain("[neutralized maomao marker]");
    expect(created[0].body).toContain("[redacted]");
    // Exactly one live marker remains: the one Maomao itself wrote.
    expect(created[0].body.match(/<\s*!--\s*maomao-scan-issue/g)).toEqual([`<!-- maomao-scan-issue`]);
    log.mockRestore();
  });

  it("re-checks the allowlists at issue-creation time after a post-scan revocation", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const created: Array<{ title: string; body: string }> = [];
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true", ALLOWED_GITHUB_ACCOUNT_IDS: "999999" },
      issueGithub(created),
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const seeded = seedScan(store);
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);

    for (const path of ["/scan/issues/preview", "/scan/issues"]) {
      const res = await app.request(path, {
        method: "POST",
        headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
        body: issuePostBody(seeded.jobId, [seeded.fingerprints[0]], csrfToken),
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("Not authorized to create issues");
    }
    expect(created).toHaveLength(0);
    expect(store.listScanIssues(seeded.jobId)).toEqual([]);
    log.mockRestore();
    warn.mockRestore();
  });

  it("guards the preview route: unauthenticated, CSRF-less, and empty selections are rejected", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const created: Array<{ title: string; body: string }> = [];
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" },
      issueGithub(created),
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const seeded = seedScan(store);
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);

    const anonymous = await app.request("/scan/issues/preview", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `job_id=${seeded.jobId}&fp[]=${seeded.fingerprints[0]}`,
    });
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("location")).toContain("/login");

    const csrfLess = await app.request("/scan/issues/preview", {
      method: "POST",
      headers: { cookie: session, "content-type": "application/x-www-form-urlencoded" },
      body: `job_id=${seeded.jobId}&fp[]=${seeded.fingerprints[0]}`,
    });
    expect(csrfLess.status).toBe(403);

    const empty = await app.request("/scan/issues/preview", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `job_id=${seeded.jobId}&csrf_token=${encodeURIComponent(csrfToken)}`,
    });
    expect(empty.status).toBe(403);
    expect(await empty.text()).toContain("Select at least one finding to preview");
    expect(created).toHaveLength(0);
    log.mockRestore();
    warn.mockRestore();
  });

  it("still renders the preview when the best-effort GitHub checks fail", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const created: Array<{ title: string; body: string }> = [];
    const github = issueGithub(created);
    github.listOpenIssuesByMarker = async () => {
      throw new Error("installation suspended");
    };
    github.searchOpenIssues = async () => {
      throw new Error("secondary rate limit");
    };
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" },
      github,
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const seeded = seedScan(store);
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);

    const preview = await app.request("/scan/issues/preview", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, [seeded.fingerprints[0]], csrfToken),
    });
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain("[maomao] HIGH: secret logged");
    expect(html).toContain("Remote dedup check failed");
    // The failures are visible in the job log, not just swallowed.
    expect(store.listLogs(seeded.jobId).some((entry) => entry.message.includes("Remote dedup check failed"))).toBe(true);
    log.mockRestore();
    warn.mockRestore();
  });

  it("renders the finding-selection form on a completed scan's job page", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" },
      issueGithub([]),
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const seeded = seedScan(store, { confidence: 0.4, agreed: ["correctness"], second: true });
    const session = await operatorSession(app);

    const jobPage = await app.request(`/jobs/${seeded.jobId}`, { headers: { cookie: session } });
    expect(jobPage.status).toBe(200);
    const html = await jobPage.text();
    expect(html).toContain('action="/scan/issues/preview"');
    // The speculative first finding is visible but not offerable; the second is preselected.
    expect(html).toContain(`value="${seeded.fingerprints[0]}" disabled`);
    expect(html).toContain(`value="${seeded.fingerprints[1]}" checked`);
    expect(html).toContain("Not offered:");
    log.mockRestore();
  });

  it("logs dropped findings when a crafted POST mixes worthy and unworthy selections", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const created: Array<{ title: string; body: string }> = [];
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" },
      issueGithub(created),
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const seeded = seedScan(store, { confidence: 0.4, agreed: ["correctness"], second: true });
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);

    const res = await app.request("/scan/issues", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, seeded.fingerprints, csrfToken),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("issues-created");
    expect(created).toHaveLength(1); // only the worthy one
    const dropLog = store.listLogs(seeded.jobId).find((entry) => entry.message.includes("below the publication bar"));
    expect(dropLog).toBeDefined();
    log.mockRestore();
    warn.mockRestore();
  });

  it("treats an in-flight pending claim as skipped without fake success", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const created: Array<{ title: string; body: string }> = [];
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" },
      issueGithub(created),
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const seeded = seedScan(store);
    // Simulate a claim left behind by a crashed run: pending, issue_number 0.
    expect(store.claimScanIssue({ jobId: seeded.jobId, repoFullName: "acme/widgets", fingerprint: seeded.fingerprints[0], title: "pending" })).toBe(true);
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);

    const preview = await app.request("/scan/issues/preview", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, [seeded.fingerprints[0]], csrfToken),
    });
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain("claim for this finding is already in flight");

    const res = await app.request("/scan/issues", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, [seeded.fingerprints[0]], csrfToken),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("issues-none:1"); // not "created"
    expect(created).toHaveLength(0);
    log.mockRestore();
  });

  it("submits the rendered job-page form end-to-end (job_id included)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const created: Array<{ title: string; body: string }> = [];
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" },
      issueGithub(created),
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const seeded = seedScan(store);
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);

    const jobPage = await app.request(`/jobs/${seeded.jobId}`, { headers: { cookie: session } });
    const html = await jobPage.text();
    // Submit exactly what the rendered form carries: job_id, checked fingerprints, CSRF.
    const params = new URLSearchParams({
      job_id: hiddenValue(html, "job_id"),
      csrf_token: csrfToken,
    });
    params.append("fp[]", seeded.fingerprints[0]);
    const preview = await app.request("/scan/issues/preview", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain("[maomao] HIGH: secret logged");
    expect(created).toHaveLength(0);
    log.mockRestore();
  });

  it("preview shows a remote marker hit as skipped and excludes it from the confirm form", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const created: Array<{ title: string; body: string }> = [];
    const github = issueGithub(created);
    github.listOpenIssuesByMarker = async () => [
      { number: 42, title: "maomao: secret logged", url: "https://github.com/acme/widgets/issues/42", state: "open" },
    ];
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" },
      github,
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const seeded = seedScan(store);
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);

    const preview = await app.request("/scan/issues/preview", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, [seeded.fingerprints[0]], csrfToken),
    });
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain("an existing Maomao issue already tracks this finding");
    expect(html).toContain("Nothing left to publish");
    expect(html).not.toContain(`name="fp[]" value="${seeded.fingerprints[0]}"`);
    expect(created).toHaveLength(0);
    log.mockRestore();
  });

  it("preview rejects fingerprints that do not belong to the scan", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const created: Array<{ title: string; body: string }> = [];
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" },
      issueGithub(created),
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const seeded = seedScan(store);
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);

    const preview = await app.request("/scan/issues/preview", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, ["bogusfingerprint1"], csrfToken),
    });
    expect(preview.status).toBe(403);
    expect(await preview.text()).toContain("do not belong to this scan");
    expect(created).toHaveLength(0);
    log.mockRestore();
  });

  it("never counts a provenance-recording failure as a failed creation", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const created: Array<{ title: string; body: string }> = [];
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" },
      issueGithub(created),
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const seeded = seedScan(store);
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);
    const recordSpy = vi.spyOn(store, "recordScanIssue").mockImplementationOnce(() => {
      throw new Error("db busy");
    });

    const res = await app.request("/scan/issues", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, [seeded.fingerprints[0]], csrfToken),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("issues-created"); // the issue exists on GitHub
    expect(created).toHaveLength(1);
    expect(store.listLogs(seeded.jobId).some((entry) => entry.message.includes("provenance recording failed"))).toBe(true);
    recordSpy.mockRestore();
    log.mockRestore();
    warn.mockRestore();
  });

  it("treats primary rate-limit 403s as transient failures, not permission denials", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const created: Array<{ title: string; body: string }> = [];
    const github = issueGithub(created);
    github.createIssue = async () => {
      throw Object.assign(new Error("API rate limit exceeded for installation"), { status: 403 });
    };
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" },
      github,
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const seeded = seedScan(store);
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);

    const res = await app.request("/scan/issues", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, [seeded.fingerprints[0]], csrfToken),
    });
    expect(res.status).toBe(302);
    // Retryable partial failure, not the permission-stop notice.
    expect(res.headers.get("location")).toContain("issues-partial:1");
    expect(res.headers.get("location")).not.toContain("issues-permission");
    expect(store.listScanIssues(seeded.jobId)).toEqual([]); // claim released for the retry
    log.mockRestore();
    warn.mockRestore();
  });

  it("keeps a credential-free audit trail of every resulting issue", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const created: Array<{ title: string; body: string }> = [];
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" },
      issueGithub(created),
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const seeded = seedScan(store);
    const { session, csrfCookie, csrfToken } = await operatorWithCsrf(app);

    const res = await app.request("/scan/issues", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: issuePostBody(seeded.jobId, [seeded.fingerprints[0]], csrfToken),
    });
    expect(res.status).toBe(302);

    // Per-issue log line ties the issue to the finding fingerprint; the summary
    // line names the actor. Neither contains credentials.
    const messages = store.listLogs(seeded.jobId).map((entry) => entry.message);
    expect(messages.some((message) => message.includes("Created issue #101") && message.includes(seeded.fingerprints[0]))).toBe(true);
    expect(messages.some((message) => message.includes("Issue creation by octocat"))).toBe(true);

    // The job page shows the resulting issues with their fingerprints.
    const jobPage = await app.request(`/jobs/${seeded.jobId}`, { headers: { cookie: session } });
    expect(jobPage.status).toBe(200);
    const html = await jobPage.text();
    expect(html).toContain("GitHub issues from this scan");
    expect(html).toContain('href="https://github.com/acme/widgets/issues/101"');
    expect(html).toContain(seeded.fingerprints[0]);
    log.mockRestore();
  });

  it("renders the permission-denied notice on the job page", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, store } = testApp(
      { ...oauthEnv, GITHUB_ISSUE_CREATION_ENABLED: "true" },
      issueGithub([]),
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    const seeded = seedScan(store);
    const session = await operatorSession(app);
    const page = await app.request(`/jobs/${seeded.jobId}?notice=issues-permission`, { headers: { cookie: session } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Issues: write permission");
    log.mockRestore();
  });
});

describe("pierre diffs vendor asset", () => {
  it("404s when the bundle has not been built, leaving the no-JS fallback", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const emptyDir = mkdtempSync(join(tmpdir(), "maomao-vendor-"));
    const { app } = testApp(
      { UI_PASSWORD: "hunter2", UI_SESSION_SECRET: "session-secret-for-tests" },
      undefined,
      undefined,
      { vendorAssetsDir: emptyDir },
    );
    const missing = await app.request("/assets/vendor/pierre-diffs.js");
    expect(missing.status).toBe(404);
  });

  it("serves a bundle placed into the vendor directory (fixture, not cwd dist)", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const vendorDir = mkdtempSync(join(tmpdir(), "maomao-vendor-"));
    writeFileSync(join(vendorDir, "pierre-diffs.js"), "globalThis.__maomaoPierre = { enhance() {} };");
    const { app } = testApp(
      { UI_PASSWORD: "hunter2", UI_SESSION_SECRET: "session-secret-for-tests" },
      undefined,
      undefined,
      { vendorAssetsDir: vendorDir },
    );
    const res = await app.request("/assets/vendor/pierre-diffs.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toContain("__maomaoPierre");
  });
});

describe("scan repository typeahead", () => {
  const oauthEnv = {
    UI_SESSION_SECRET: "session-secret-for-tests",
    GITHUB_OAUTH_CLIENT_ID: "cid",
    GITHUB_OAUTH_CLIENT_SECRET: "csecret",
    MAOMAO_ADMIN_GITHUB_IDS: "1001",
    MAOMAO_PUBLIC_URL: "https://maomao.example",
  };

  function typeaheadGithub(calls: { installations: number; repositories: number }): ManualTriggerPort & Partial<GithubPort> {
    return {
      getRepoInstallation: async () => ({ installationId: 42, accountId: 1001 }),
      getRepository: async () => ({ id: 2002 }),
      listAppInstallations: async () => {
        calls.installations += 1;
        return [
          { id: 42, accountId: 1001 },
          { id: 43, accountId: 1001 },
        ];
      },
      listInstallationRepositories: async (installationId: number) => {
        calls.repositories += 1;
        if (installationId === 43) throw new Error("installation suspended");
        return [
          { id: 2002, fullName: "acme/widgets" },
          { id: 3003, fullName: "acme/other" },
          { id: 4004, fullName: "acme/zebra" },
        ];
      },
    } as unknown as ManualTriggerPort & Partial<GithubPort>;
  }

  async function operatorSession(app: ReturnType<typeof createApp>): Promise<string> {
    const start = await app.request("/login/github");
    const state = start.headers.get("location")?.match(/state=([^&]+)/)?.[1] ?? "";
    const callback = await app.request(`/login/github/callback?code=good-code&state=${state}`);
    return cookieFrom(callback);
  }

  it("is operator-only and gated like the rest of /api", async () => {
    const { app } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));
    const anonymous = await app.request("/api/scan/repositories");
    expect(anonymous.status).toBe(401);
  });

  it("refuses non-OAuth (password) sessions", async () => {
    const { app } = testApp({ UI_PASSWORD: "hunter2", UI_SESSION_SECRET: "session-secret-for-tests" });
    const { cookies } = await loginSession(app);
    const res = await app.request("/api/scan/repositories", { headers: { cookie: cookies } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: expect.stringContaining("operator GitHub OAuth identity") });
  });

  it("does not render a dead combobox for password-only sessions", async () => {
    const { app } = testApp({ UI_PASSWORD: "hunter2", UI_SESSION_SECRET: "session-secret-for-tests" });
    const { cookies } = await loginSession(app);
    const page = await app.request("/scan", { headers: { cookie: cookies } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Scanning requires an operator GitHub OAuth identity");
    expect(html).not.toContain("data-repo-typeahead");
    expect(html).not.toContain("/assets/typeahead.js");
  });

  it("returns allowlisted repositories sorted by name, skipping failing installations", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = { installations: 0, repositories: 0 };
    const { app, store } = testApp(
      { ...oauthEnv, ALLOWED_GITHUB_REPOSITORY_IDS: "2002,4004" },
      typeaheadGithub(calls),
      mockOauthFetch({ id: 1001, login: "octocat" }),
    );
    void store;
    const session = await operatorSession(app);
    const res = await app.request("/api/scan/repositories", { headers: { cookie: session } });
    expect(res.status).toBe(200);
    const body = await res.json() as { repositories: Array<{ fullName: string }> };
    // acme/other (id 3003) is filtered by the repository allowlist; installation 43
    // failed and was skipped without killing the rest.
    expect(body.repositories.map((repo) => repo.fullName)).toEqual(["acme/widgets", "acme/zebra"]);
    expect(calls.installations).toBe(1);
    expect(calls.repositories).toBe(2);

    // Cached for the TTL: no additional GitHub enumeration on the second call.
    const again = await app.request("/api/scan/repositories", { headers: { cookie: session } });
    expect(again.status).toBe(200);
    expect(calls.installations).toBe(1);
    expect(calls.repositories).toBe(2);
    warn.mockRestore();
  });

  it("reports 502 when enumeration fails entirely so the UI can fall back", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const github = {
      listAppInstallations: async () => {
        throw new Error("bad credentials");
      },
      listInstallationRepositories: async () => [],
    } as unknown as ManualTriggerPort & Partial<GithubPort>;
    const { app } = testApp(oauthEnv, github, mockOauthFetch({ id: 1001, login: "octocat" }));
    const session = await operatorSession(app);
    const res = await app.request("/api/scan/repositories", { headers: { cookie: session } });
    expect(res.status).toBe(502);
    warn.mockRestore();
  });

  it("reports 503 when a present client lacks the optional enumeration methods", async () => {
    const github = {
      getRepoInstallation: async () => ({ installationId: 42, accountId: 1001 }),
      getRepository: async () => ({ id: 2002 }),
    } as unknown as ManualTriggerPort & Partial<GithubPort>;
    const { app } = testApp(oauthEnv, github, mockOauthFetch({ id: 1001, login: "octocat" }));
    const session = await operatorSession(app);
    const res = await app.request("/api/scan/repositories", { headers: { cookie: session } });
    expect(res.status).toBe(503);
  });

  it("skips installations outside the account allowlist entirely", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = { installations: 0, repositories: 0 };
    const github = typeaheadGithub(calls);
    github.listAppInstallations = async () => {
      calls.installations += 1;
      return [
        { id: 42, accountId: 1001 },
        { id: 43, accountId: 9001 },
      ];
    };
    const { app } = testApp({ ...oauthEnv, ALLOWED_GITHUB_ACCOUNT_IDS: "1001" }, github, mockOauthFetch({ id: 1001, login: "octocat" }));
    const session = await operatorSession(app);
    const res = await app.request("/api/scan/repositories", { headers: { cookie: session } });
    const body = await res.json() as { repositories: Array<{ fullName: string }> };
    expect(body.repositories.map((repo) => repo.fullName)).toEqual(["acme/other", "acme/widgets", "acme/zebra"]);
    expect(calls.repositories).toBe(1); // installation 43's repos were never listed
    warn.mockRestore();
  });

  it("caps the suggestion list at 500 repositories", async () => {
    const github = {
      listAppInstallations: async () => [{ id: 42, accountId: 1001 }],
      listInstallationRepositories: async () =>
        Array.from({ length: 600 }, (_, i) => ({ id: i + 1, fullName: `acme/repo${String(i).padStart(3, "0")}` })),
    } as unknown as ManualTriggerPort & Partial<GithubPort>;
    const { app } = testApp(oauthEnv, github, mockOauthFetch({ id: 1001, login: "octocat" }));
    const session = await operatorSession(app);
    const res = await app.request("/api/scan/repositories", { headers: { cookie: session } });
    const body = await res.json() as { repositories: unknown[] };
    expect(body.repositories).toHaveLength(500);
  });

  it("re-enumerates after the cache TTL lapses", async () => {
    const calls = { installations: 0, repositories: 0 };
    const { app } = testApp(oauthEnv, typeaheadGithub(calls), mockOauthFetch({ id: 1001, login: "octocat" }));
    const session = await operatorSession(app);
    await app.request("/api/scan/repositories", { headers: { cookie: session } });
    expect(calls.installations).toBe(1);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);
    try {
      await app.request("/api/scan/repositories", { headers: { cookie: session } });
      expect(calls.installations).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not cache empty enumeration results", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = { installations: 0, repositories: 0 };
    const github = typeaheadGithub(calls);
    github.listAppInstallations = async () => {
      calls.installations += 1;
      return [];
    };
    const { app } = testApp(oauthEnv, github, mockOauthFetch({ id: 1001, login: "octocat" }));
    const session = await operatorSession(app);
    const first = await app.request("/api/scan/repositories", { headers: { cookie: session } });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ repositories: [] });
    await app.request("/api/scan/repositories", { headers: { cookie: session } });
    expect(calls.installations).toBe(2); // empty result must not pin the list for the TTL
    warn.mockRestore();
  });
});

describe("webhook merge cancellation wiring", () => {
  it("aborts queue jobs cancelled by a merged pull_request.closed delivery", async () => {
    const aborted: number[][] = [];
    const { app, store, enqueued, webhookSecret } = testApp({}, undefined, undefined, {
      queue: {
        enqueue(id: number) {
          enqueued.push(id);
        },
        abortMany(ids: number[]) {
          aborted.push([...ids]);
        },
      } as unknown as JobQueue,
    });

    const opened = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "open-1",
        "x-hub-signature-256": sign(webhookSecret, openedPayload),
        "content-type": "application/json",
      },
      body: openedPayload,
    });
    expect(opened.status).toBe(202);
    expect(enqueued).toHaveLength(1);
    const jobId = enqueued[0];

    const closedPayload = JSON.stringify({
      action: "closed",
      installation: { id: 1, account: { id: 1001 } },
      repository: { id: 2002, full_name: "acme/widgets", name: "widgets", owner: { login: "acme", id: 1001 } },
      pull_request: { number: 8, merged: true },
    });
    const closed = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "close-1",
        "x-hub-signature-256": sign(webhookSecret, closedPayload),
        "content-type": "application/json",
      },
      body: closedPayload,
    });
    expect(closed.status).toBe(200);
    const body = (await closed.json()) as { cancelled?: number; cancelledJobIds?: number[] };
    expect(body.cancelled).toBe(1);
    expect(body.cancelledJobIds).toEqual([jobId]);
    expect(aborted).toEqual([[jobId]]);
    const job = store.getJob(jobId);
    expect(job?.state).toBe("cancelled");
    expect(job?.cancelled_reason).toBe("pr_merged");
  });
});

describe("manual dequeue and cancel review", () => {
  const oauthEnv = {
    UI_SESSION_SECRET: "session-secret-for-tests",
    GITHUB_OAUTH_CLIENT_ID: "cid",
    GITHUB_OAUTH_CLIENT_SECRET: "csecret",
    MAOMAO_ADMIN_GITHUB_IDS: "1001",
    MAOMAO_PUBLIC_URL: "https://maomao.example",
  };

  function seedJobs(store: JobStore): { queued: number; reviewing: number; completed: number } {
    const seed = (prNumber: number, headSha: string) =>
      store.enqueue({
        repoFullName: "acme/widgets",
        repoOwner: "acme",
        repoName: "widgets",
        installationId: 1,
        prNumber,
        prTitle: "t",
        prBody: "",
        prHtmlUrl: "https://github.com/acme/widgets/pull/x",
        prAuthor: "dev",
        baseSha: "b",
        headSha,
        baseRef: "main",
        headRef: "f",
        reviewers: [{ role: "correctness", title: "Correctness" }],
      }).job.id;
    const queued = seed(1, "q1");
    const reviewing = seed(2, "r1");
    store.setJobState(reviewing, "reviewing");
    const completed = seed(3, "c1");
    store.setJobState(completed, "completed");
    return { queued, reviewing, completed };
  }

  /** Session cookie alone is not enough: grab the CSRF cookie+field pair from a page render. */
  async function csrfFor(app: ReturnType<typeof createApp>, session: string) {
    const page = await app.request("/", { headers: { cookie: session } });
    const { csrfCookie, csrfToken } = await csrfArtifacts(page);
    return { cookie: `${session}; ${csrfCookie}`, csrfToken };
  }

  async function post(
    app: ReturnType<typeof createApp>,
    jobId: number,
    path: string,
    cookie: string,
    csrfToken: string,
  ) {
    return app.request(`/jobs/${jobId}${path}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `csrf_token=${encodeURIComponent(csrfToken)}`,
    });
  }

  it("dequeues a queued job with actor and reason and aborts the queue", async () => {
    const aborted: number[][] = [];
    const { app, store } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }), {
      queue: {
        enqueue() {},
        abortMany(ids: number[]) {
          aborted.push([...ids]);
        },
      } as unknown as JobQueue,
    });
    const jobs = seedJobs(store);
    const { cookie, csrfToken } = await csrfFor(app, await operatorSession(app));

    const response = await post(app, jobs.queued, "/dequeue", cookie, csrfToken);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("notice=dequeued");
    const job = store.getJob(jobs.queued);
    expect(job?.state).toBe("cancelled");
    expect(job?.cancelled_reason).toBe("manual_dequeue");
    expect(job?.cancelled_by).toBe("octocat");
    expect(aborted).toEqual([[jobs.queued]]);
    expect(store.getJob(jobs.reviewing)?.state).toBe("reviewing");
  });

  it("is idempotent when the dequeue is repeated", async () => {
    const { app, store } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));
    const jobs = seedJobs(store);
    const { cookie, csrfToken } = await csrfFor(app, await operatorSession(app));
    await post(app, jobs.queued, "/dequeue", cookie, csrfToken);
    const second = await post(app, jobs.queued, "/dequeue", cookie, csrfToken);
    expect(second.status).toBe(302);
    expect(second.headers.get("location")).toContain("notice=dequeue-already");
    expect(store.listLogs(jobs.queued).filter((line) => line.message.includes("Cancelled"))).toHaveLength(1);
  });

  it("refuses to dequeue a running job and a completed job", async () => {
    const { app, store } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));
    const jobs = seedJobs(store);
    const { cookie, csrfToken } = await csrfFor(app, await operatorSession(app));
    const running = await post(app, jobs.reviewing, "/dequeue", cookie, csrfToken);
    expect(running.status).toBe(400);
    expect(await running.text()).toContain("Only queued jobs can be dequeued");
    const done = await post(app, jobs.completed, "/dequeue", cookie, csrfToken);
    expect(done.status).toBe(400);
    expect(store.getJob(jobs.reviewing)?.state).toBe("reviewing");
    expect(store.getJob(jobs.completed)?.state).toBe("completed");
  });

  it("requires a session for dequeue posts", async () => {
    const { app, store } = testApp(oauthEnv);
    const jobs = seedJobs(store);
    const response = await app.request(`/jobs/${jobs.queued}/dequeue`, { method: "POST" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/login");
    expect(store.getJob(jobs.queued)?.state).toBe("queued");
  });

  it("cancels a running review through the confirmation page", async () => {
    const aborted: number[][] = [];
    const { app, store } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }), {
      queue: {
        enqueue() {},
        abortMany(ids: number[]) {
          aborted.push([...ids]);
        },
      } as unknown as JobQueue,
    });
    const jobs = seedJobs(store);
    const { cookie, csrfToken } = await csrfFor(app, await operatorSession(app));

    // Queued jobs redirect to the job page (no confirmation to see).
    const queuedConfirm = await app.request(`/jobs/${jobs.queued}/cancel`, { headers: { cookie } });
    expect(queuedConfirm.status).toBe(302);

    const confirmPage = await app.request(`/jobs/${jobs.reviewing}/cancel`, { headers: { cookie } });
    expect(confirmPage.status).toBe(200);
    const html = await confirmPage.text();
    expect(html).toContain("Cancel this review?");
    const tokenMatch = html.match(/name="csrf_token" value="([^"]+)"/);
    expect(tokenMatch?.[1]).toBeTruthy();

    const response = await app.request(`/jobs/${jobs.reviewing}/cancel`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `csrf_token=${encodeURIComponent(tokenMatch![1])}`,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("notice=cancelled-review");
    const job = store.getJob(jobs.reviewing);
    expect(job?.state).toBe("cancelled");
    expect(job?.cancelled_reason).toBe("manual_cancel");
    expect(job?.cancelled_by).toBe("octocat");
    expect(aborted).toEqual([[jobs.reviewing]]);
  });

  it("refuses the cancel POST for a terminal job", async () => {
    const { app, store } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));
    const jobs = seedJobs(store);
    const { cookie, csrfToken } = await csrfFor(app, await operatorSession(app));
    const response = await post(app, jobs.completed, "/cancel", cookie, csrfToken);
    expect(response.status).toBe(400);
    expect(store.getJob(jobs.completed)?.state).toBe("completed");
  });
});

describe("manual cancel and dequeue hardening", () => {
  const oauthEnv = {
    UI_SESSION_SECRET: "session-secret-for-tests",
    GITHUB_OAUTH_CLIENT_ID: "cid",
    GITHUB_OAUTH_CLIENT_SECRET: "csecret",
    MAOMAO_ADMIN_GITHUB_IDS: "1001",
    MAOMAO_PUBLIC_URL: "https://maomao.example",
  };

  function seedReviewing(store: JobStore) {
    return store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 1,
      prNumber: 5,
      prTitle: "t",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "dev",
      baseSha: "b",
      headSha: "h5",
      baseRef: "main",
      headRef: "f",
      reviewers: [{ role: "correctness", title: "Correctness" }],
    }).job.id;
  }

  it("treats a repeated cancel POST on an already-cancelled job as idempotent", async () => {
    const { app, store } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));
    const jobId = seedReviewing(store);
    store.setJobState(jobId, "reviewing");
    const { cookie, csrfToken } = await csrfForInner(app);
    await cancelPost(app, jobId, cookie, csrfToken);
    const second = await cancelPost(app, jobId, cookie, csrfToken);
    expect(second.status).toBe(302);
    expect(second.headers.get("location")).toContain("notice=cancel-already");
    expect(store.getJob(jobId)?.state).toBe("cancelled");
  });

  it("treats a cancel POST on a merge-cancelled job as idempotent, not an error", async () => {
    // The confirm page was open when the merge webhook cancelled the job.
    const { app, store } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));
    const jobId = seedReviewing(store);
    store.setJobState(jobId, "reviewing");
    store.cancelJobs({ jobId }, "pr_merged", null);
    const { cookie, csrfToken } = await csrfForInner(app);
    const response = await cancelPost(app, jobId, cookie, csrfToken);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("notice=cancel-already");
    expect(store.getJob(jobId)?.cancelled_reason).toBe("pr_merged");
  });

  it("attributes manual dequeue to a password-gate session without inventing a login", async () => {
    const { app, store } = testApp({ UI_PASSWORD: "hunter2", UI_SESSION_SECRET: "session-secret-for-tests" });
    const jobId = seedReviewing(store);
    const { session } = await loginSession(app);
    const page = await app.request("/", { headers: { cookie: session } });
    const { csrfCookie, csrfToken } = await csrfArtifacts(page);
    const response = await app.request(`/jobs/${jobId}/dequeue`, {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `csrf_token=${encodeURIComponent(csrfToken)}`,
    });
    expect(response.status).toBe(302);
    const job = store.getJob(jobId);
    expect(job?.state).toBe("cancelled");
    expect(job?.cancelled_reason).toBe("manual_dequeue");
    // No fabricated login in the audit trail: the copy layer renders "an operator".
    expect(job?.cancelled_by).toBeNull();
  });

  async function csrfForInner(app: ReturnType<typeof createApp>) {
    const session = await operatorSession(app);
    const page = await app.request("/", { headers: { cookie: session } });
    const { csrfCookie, csrfToken } = await csrfArtifacts(page);
    return { cookie: `${session}; ${csrfCookie}`, csrfToken };
  }

  async function cancelPost(
    app: ReturnType<typeof createApp>,
    jobId: number,
    cookie: string,
    csrfToken: string,
  ) {
    return app.request(`/jobs/${jobId}/cancel`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `csrf_token=${encodeURIComponent(csrfToken)}`,
    });
  }
});

describe("home queue pagination", () => {
  function seededApp(count: number) {
    const { app, store } = testApp();
    for (let index = 0; index < count; index += 1) {
      store.enqueue({
        repoFullName: "acme/widgets",
        repoOwner: "acme",
        repoName: "widgets",
        installationId: 1,
        prNumber: index + 1,
        prTitle: `job ${index + 1}`,
        prBody: "",
        prHtmlUrl: "",
        prAuthor: "dev",
        baseSha: "b",
        headSha: `sha-${index + 1}`,
        baseRef: "main",
        headRef: "f",
        reviewers: [],
      });
    }
    return { app, store };
  }

  it("serves the newest page first and paginates through the whole history", async () => {
    const { app } = seededApp(60);
    const first = await app.request("/");
    const firstHtml = await first.text();
    expect(first.status).toBe(200);
    expect(firstHtml).toContain('rel="next"');
    expect(firstHtml).not.toContain('rel="prev"');
    expect(firstHtml).not.toContain("Viewing older jobs");
    // Default page size 25: the 61st... the 26th-newest job must not be on page 1.
    expect(firstHtml).toContain("job 60");
    expect(firstHtml).not.toContain("job 35");
    expect(firstHtml).not.toContain("job 34");

    const beforeMatch = firstHtml.match(/href="\/\?before=(\d+)"/);
    expect(beforeMatch?.[1]).toBeTruthy();
    const second = await app.request(`/?before=${beforeMatch![1]}`);
    const secondHtml = await second.text();
    expect(secondHtml).toContain("job 34");
    expect(secondHtml).not.toContain("job 60");
    expect(secondHtml).toContain('rel="prev"');
    expect(secondHtml).toContain("Viewing older jobs");
  });

  it("falls back to the first page for invalid cursors instead of erroring", async () => {
    const { app } = seededApp(3);
    for (const bad of ["abc", "-5", "1e9", "0", "12.5", "999999999999999999999999"]) {
      const response = await app.request(`/?before=${encodeURIComponent(bad)}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("job 3");
      expect(html).not.toContain("Older jobs</a>");
    }
    // A before cursor beyond the newest id serves the newest page too.
    const beyond = await app.request("/?before=999999");
    expect(beyond.status).toBe(200);
    expect((await beyond.text()).replace(/<[^>]+>/g, "")).toContain("job 3");
  });

  it("no longer renders an unbounded 75-job list: only the page is loaded", async () => {
    const { app, store } = seededApp(90);
    const html = await (await app.request("/")).text();
    expect(html).toContain("job 90");
    expect(html).not.toContain("job 65");
    // The full history stays reachable through pagination.
    let cursor: { before?: number } = {};
    let oldest = Number.POSITIVE_INFINITY;
    for (;;) {
      const page = store.listJobsPage(cursor);
      oldest = Math.min(oldest, ...page.jobs.map((job) => job.pr_number));
      if (!page.hasOlder) break;
      cursor = { before: page.jobs[page.jobs.length - 1]!.id };
    }
    expect(oldest).toBe(1);
  });

  it("renders an empty first page without navigation dead ends", async () => {
    const { app } = seededApp(0);
    const response = await app.request("/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Nothing is under examination");
    expect(html).toContain("aria-disabled=\"true\"");
  });
});

describe("home queue pagination review fixes", () => {
  function seededApp2(count: number) {
    const { app, store } = testApp();
    for (let index = 0; index < count; index += 1) {
      store.enqueue({
        repoFullName: "acme/widgets",
        repoOwner: "acme",
        repoName: "widgets",
        installationId: 1,
        prNumber: index + 1,
        prTitle: `job ${index + 1}`,
        prBody: "",
        prHtmlUrl: "",
        prAuthor: "dev",
        baseSha: "b",
        headSha: `sha-${index + 1}`,
        baseRef: "main",
        headRef: "f",
        reviewers: [],
      });
    }
    return { app, store };
  }

  it("follows the Newer jobs link back up and treats a stale after cursor as the first page", async () => {
    const { app } = seededApp2(60);
    const firstHtml = await (await app.request("/")).text();
    const beforeMatch = firstHtml.match(/href="\/\?before=(\d+)"/);
    const secondHtml = await (await app.request(`/?before=${beforeMatch![1]}`)).text();
    const afterMatch = secondHtml.match(/href="\/\?after=(\d+)"/);
    expect(afterMatch?.[1]).toBeTruthy();
    const up = await (await app.request(`/?after=${afterMatch![1]}`)).text();
    expect(up).toContain("job 60");
    expect(up).toContain('rel="next"');
    expect(up).not.toContain('rel="prev"');
    // A stale after bookmark beyond the newest id falls back to the first page.
    const stale = await app.request("/?after=999999");
    expect(stale.status).toBe(200);
    expect((await stale.text()).replace(/<[^>]+>/g, "")).toContain("That page no longer exists");
  });

  it("renders the final partial page with a disabled Older link and live Newer link", async () => {
    const { app } = seededApp2(30);
    const firstHtml = await (await app.request("/")).text();
    const beforeMatch = firstHtml.match(/href="\/\?before=(\d+)"/);
    const lastHtml = await (await app.request(`/?before=${beforeMatch![1]}`)).text();
    expect(lastHtml).toContain("job 5");
    expect(lastHtml).toContain("job 1");
    expect(lastHtml).toContain('aria-disabled="true"');
    expect(lastHtml).toContain('rel="prev"');
    expect(lastHtml).toContain("Viewing older jobs");
    expect(lastHtml).not.toContain('rel="next"');
  });

  it("keeps the pagination nav on the POST /reviews error re-render", async () => {
    const { app } = seededApp2(40);
    const response = await app.request("/reviews", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "url=not-a-url",
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('class="jobs-pagination"');
    expect(html).toContain('rel="next"');
    expect(html).not.toContain("job 15");
  });
});

describe("effective configuration summary", () => {
  const gateEnv = { UI_PASSWORD: "hunter2", UI_SESSION_SECRET: "session-secret-for-tests" };
  const canaryEnv = {
    UI_PASSWORD: "PASSWORD-CANARY",
    UI_SESSION_SECRET: "SESSION-SECRET-CANARY",
    GITHUB_APP_PRIVATE_KEY: "PRIVATE-KEY-CANARY-VALUE",
    GITHUB_WEBHOOK_SECRET: "WEBHOOK-SECRET-CANARY",
    GITHUB_OAUTH_CLIENT_SECRET: "OAUTH-SECRET-CANARY",
    OPENCODE_REVIEWER_MODEL: "test/reviewer-env",
    POST_EMPTY_REVIEW: "true",
  };

  async function configPage(app: ReturnType<typeof createApp>): Promise<string> {
    const { session } = await loginSession(app);
    const response = await app.request("/config", { headers: { cookie: session } });
    expect(response.status).toBe(200);
    return response.text();
  }

  function sectionFor(html: string, label: string): string {
    const match = html.match(new RegExp(`<dt>[^<]*${label}[\\s\\S]{0,200}?</dd>`));
    expect(match, `row for ${label}`).toBeTruthy();
    return match![0];
  }

  it("renders the effective-config section with source badges", async () => {
    const { app } = testApp(gateEnv);
    const html = await configPage(app);
    expect(html).toContain("Effective configuration");
    expect(sectionFor(html, "Reviewer model")).toContain(">Default</span>");
    expect(sectionFor(html, "Allow APPROVE verdicts")).toContain(">Default</span>");
  });

  it("labels environment-backed values as Environment", async () => {
    const env = {
      ...gateEnv,
      OPENCODE_REVIEWER_MODEL: "test/reviewer-env",
      POST_EMPTY_REVIEW: "true",
    };
    const { app } = testApp(env);
    const html = await configPage(app);
    // The source badge sits on the <dt> (label) row, above the value row.
    expect(sectionFor(html, "Reviewer model")).toContain(">Environment</span>");
  });

  it("shows the active profile revision as the source for profile-backed values", async () => {
    const { app, store } = testApp(gateEnv);
    // The active revision must be named "default" — that is the name the
    // resolution point queries.
    const created = store.configs.createDraft({
      definition: { name: "default", reviewers: [{ role: "correctness" }], minPublishableSeverity: "low" },
      createdBy: "octocat",
    });
    if ("error" in created) throw new Error(created.issues.join("; "));
    const activated = store.configs.activateRevision(created.revision.id, "octocat");
    if ("error" in activated) throw new Error(activated.error);
    const html = await configPage(app);
    expect(html).toContain("config-source-profile");
    expect(html).toContain("Profile reviewer set");
    expect(html).toContain("Profile minimum publishable severity");
  });

  async function canaryConfigPage(app: ReturnType<typeof createApp>): Promise<string> {
    // The canary password is not hunter2, so log in manually.
    const page = await app.request("/login");
    const { csrfCookie, csrfToken } = await csrfArtifacts(page);
    const login = await app.request("/login", {
      method: "POST",
      headers: { cookie: csrfCookie, "content-type": "application/x-www-form-urlencoded" },
      body: `password=${encodeURIComponent("PASSWORD-CANARY")}&next=%2F&csrf_token=${encodeURIComponent(csrfToken)}`,
    });
    expect(login.status).toBe(302);
    const session = cookieFrom(login);
    const response = await app.request("/config", { headers: { cookie: `${session}; ${csrfCookie}` } });
    expect(response.status).toBe(200);
    return response.text();
  }

  it("never leaks credential values into the rendered page", async () => {
    const { app } = testApp(canaryEnv);
    const html = await canaryConfigPage(app);
    for (const canary of [
      "PRIVATE-KEY-CANARY-VALUE",
      "WEBHOOK-SECRET-CANARY",
      "OAUTH-SECRET-CANARY",
      "PASSWORD-CANARY",
      "SESSION-SECRET-CANARY",
    ]) {
      expect(html, `credential canary ${canary} leaked into /config`).not.toContain(canary);
    }
    // Anchor the assertion to the credential row, not page prose.
    expect(sectionFor(html, "GitHub webhook secret")).toContain('>configured</code>');
  });

  it("keeps credentials out of the 403 denied page too", async () => {
    // Password-gate sessions carry no identity, so POST /config renders the
    // 403 denial page even while logged in.
    const { app } = testApp({
      UI_PASSWORD: "PASSWORD-CANARY",
      UI_SESSION_SECRET: "SESSION-SECRET-CANARY",
      GITHUB_APP_PRIVATE_KEY: "PRIVATE-KEY-CANARY-VALUE",
      GITHUB_WEBHOOK_SECRET: "WEBHOOK-SECRET-CANARY",
    });
    const page = await app.request("/login");
    const { csrfCookie, csrfToken } = await csrfArtifacts(page);
    const login = await app.request("/login", {
      method: "POST",
      headers: { cookie: csrfCookie, "content-type": "application/x-www-form-urlencoded" },
      body: `password=${encodeURIComponent("PASSWORD-CANARY")}&next=%2F&csrf_token=${encodeURIComponent(csrfToken)}`,
    });
    expect(login.status).toBe(302);
    const session = cookieFrom(login);
    const response = await app.request("/config/drafts", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `csrf_token=${encodeURIComponent(csrfToken)}&definition={}`,
    });
    expect(response.status).toBe(403);
    const html = await response.text();
    for (const canary of ["PRIVATE-KEY-CANARY-VALUE", "WEBHOOK-SECRET-CANARY", "PASSWORD-CANARY", "SESSION-SECRET-CANARY"]) {
      expect(html, `credential canary ${canary} leaked into the 403 page`).not.toContain(canary);
    }
  });

  it("keeps the section on config error re-renders (400 validation failure)", async () => {
    const oauthEnv = {
      UI_SESSION_SECRET: "session-secret-for-tests",
      GITHUB_OAUTH_CLIENT_ID: "cid",
      GITHUB_OAUTH_CLIENT_SECRET: "csecret",
      MAOMAO_ADMIN_GITHUB_IDS: "1001",
      MAOMAO_PUBLIC_URL: "https://maomao.example",
    };
    const { app } = testApp(oauthEnv, undefined, mockOauthFetch({ id: 1001, login: "octocat" }));
    const session = await operatorSession(app);
    const page = await app.request("/config", { headers: { cookie: session } });
    const { csrfCookie, csrfToken } = await csrfArtifacts(page);
    const response = await app.request("/config/drafts", {
      method: "POST",
      headers: { cookie: `${session}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: `csrf_token=${encodeURIComponent(csrfToken)}&definition=not-json`,
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("Effective configuration");
  });
});
