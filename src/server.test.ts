import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { JobStore } from "./jobs/store.js";
import type { JobQueue } from "./jobs/queue.js";
import { createApp } from "./server.js";
import { SESSION_COOKIE } from "./auth.js";

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function testApp(env: Record<string, string> = {}) {
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
  const app = createApp({ config, store, queue, startedAt: Date.now() });
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
  installation: { id: 1 },
  repository: { full_name: "acme/widgets", name: "widgets", owner: { login: "acme" } },
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
    expect(await home.text()).toContain("Review jobs");

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
