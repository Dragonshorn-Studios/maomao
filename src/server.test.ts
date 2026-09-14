import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { JobStore } from "./jobs/store.js";
import type { JobQueue } from "./jobs/queue.js";
import { createApp } from "./server.js";

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("HTTP app", () => {
  it("serves health, UI, and webhook enqueue", async () => {
    const secret = "s3cret";
    const config = loadConfig({
      GITHUB_WEBHOOK_SECRET: secret,
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "k",
      REVIEWER_ROLES: "correctness",
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

    const health = await app.request("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, service: "maomao" });

    const home = await app.request("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Review jobs");

    const payload = JSON.stringify({
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
    const webhook = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "abc",
        "x-hub-signature-256": sign(secret, payload),
        "content-type": "application/json",
      },
      body: payload,
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
});
