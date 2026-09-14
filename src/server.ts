import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { basicAuth } from "hono/basic-auth";
import type { Config } from "./config.js";
import type { JobStore } from "./jobs/store.js";
import { handleGithubWebhook } from "./github/webhooks.js";
import { subscribe } from "./events.js";
import { renderHome, renderJob } from "./ui.js";
import type { JobQueue } from "./jobs/queue.js";

export interface ServerContext {
  config: Config;
  store: JobStore;
  queue: JobQueue;
  startedAt: number;
}

export function createApp(ctx: ServerContext): Hono {
  const app = new Hono();

  if (ctx.config.uiBasicAuthUser && ctx.config.uiBasicAuthPassword) {
    app.use("/*", async (c, next) => {
      if (c.req.path === "/webhooks/github" || c.req.path === "/health") return next();
      return basicAuth({ username: ctx.config.uiBasicAuthUser, password: ctx.config.uiBasicAuthPassword })(c, next);
    });
  }

  app.get("/health", (c) =>
    c.json({
      ok: true,
      uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
      service: "maomao",
    }),
  );

  app.post("/webhooks/github", async (c) => {
    const rawBody = await c.req.text();
    const result = await handleGithubWebhook({
      config: ctx.config,
      store: ctx.store,
      request: {
        event: c.req.header("x-github-event") ?? "",
        deliveryId: c.req.header("x-github-delivery") ?? "",
        signature: c.req.header("x-hub-signature-256") ?? "",
        rawBody,
      },
    });
    if (result.enqueue?.created) {
      ctx.queue.enqueue(result.enqueue.job.id);
    }
    if (result.enqueue?.staleJobIds.length) {
      ctx.queue.abortMany(result.enqueue.staleJobIds);
    }
    return c.json(result.body, result.status as 200);
  });

  app.get("/", (c) => {
    const jobs = ctx.store.listJobs(75);
    return c.html(renderHome(jobs, ctx.store));
  });

  app.get("/jobs/:id", (c) => {
    const id = Number(c.req.param("id"));
    const job = ctx.store.getJob(id);
    if (!job) return c.text("Not found", 404);
    return c.html(renderJob(job, ctx.store.listReviewerRuns(id), ctx.store.listLogs(id)));
  });

  app.get("/api/jobs", (c) => {
    const jobs = ctx.store.listJobs(75).map((job) => ({
      ...job,
      ...ctx.store.jobSummary(job),
    }));
    return c.json({ jobs });
  });

  app.get("/api/jobs/:id", (c) => {
    const id = Number(c.req.param("id"));
    const job = ctx.store.getJob(id);
    if (!job) return c.json({ error: "not found" }, 404);
    return c.json({
      job,
      reviewers: ctx.store.listReviewerRuns(id),
      logs: ctx.store.listLogs(id),
      ...ctx.store.jobSummary(job),
    });
  });

  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: JSON.stringify({ type: "hello" }) });
      const unsubscribe = subscribe((event) => {
        void stream.writeSSE({ data: JSON.stringify(event) });
      });
      const ping = setInterval(() => {
        void stream.writeSSE({ data: JSON.stringify({ type: "hello" }) });
      }, 15000);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(ping);
          unsubscribe();
          resolve();
        });
      });
    }),
  );

  return app;
}
