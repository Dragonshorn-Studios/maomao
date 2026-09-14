import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Config } from "./config.js";
import type { JobStore } from "./jobs/store.js";
import { handleGithubWebhook } from "./github/webhooks.js";
import { subscribe } from "./events.js";
import { renderHome, renderJob, renderLogin } from "./ui.js";
import type { JobQueue } from "./jobs/queue.js";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  cookieSecure,
  isPublicPath,
  passwordsMatch,
  safeNextPath,
  signSession,
  uiGateEnabled,
  verifySession,
} from "./auth.js";

export interface ServerContext {
  config: Config;
  store: JobStore;
  queue: JobQueue;
  startedAt: number;
}

export function createApp(ctx: ServerContext): Hono {
  const app = new Hono();
  const gateOn = uiGateEnabled(ctx.config.uiPassword, ctx.config.uiSessionSecret);
  const pageOpts = { showLogout: gateOn };

  app.use("*", async (c, next) => {
    if (!gateOn || isPublicPath(c.req.path)) return next();
    const token = getCookie(c, SESSION_COOKIE);
    if (verifySession(ctx.config.uiSessionSecret, token)) return next();
    if (c.req.path.startsWith("/api/") || c.req.path === "/events") {
      return c.json({ error: "unauthorized" }, 401);
    }
    const url = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`, 302);
  });

  app.get("/login", (c) => {
    if (!gateOn) return c.redirect("/", 302);
    const token = getCookie(c, SESSION_COOKIE);
    const nextPath = safeNextPath(c.req.query("next"));
    if (verifySession(ctx.config.uiSessionSecret, token)) return c.redirect(nextPath, 302);
    return c.html(renderLogin(false, nextPath));
  });

  app.post("/login", async (c) => {
    if (!gateOn) return c.redirect("/", 302);
    const body = await c.req.parseBody();
    const password = typeof body.password === "string" ? body.password : "";
    const nextPath = safeNextPath(typeof body.next === "string" ? body.next : c.req.query("next"));
    if (!passwordsMatch(password, ctx.config.uiPassword)) {
      return c.html(renderLogin(true, nextPath), 401);
    }
    setCookie(c, SESSION_COOKIE, signSession(ctx.config.uiSessionSecret), {
      httpOnly: true,
      sameSite: "Lax",
      secure: cookieSecure(c.req.url, c.req.header("x-forwarded-proto")),
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return c.redirect(nextPath, 302);
  });

  app.post("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect(gateOn ? "/login" : "/", 302);
  });

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
    return c.html(renderHome(jobs, ctx.store, pageOpts));
  });

  app.get("/jobs/:id", (c) => {
    const id = Number(c.req.param("id"));
    const job = ctx.store.getJob(id);
    if (!job) return c.text("Not found", 404);
    return c.html(renderJob(job, ctx.store.listReviewerRuns(id), ctx.store.listLogs(id), pageOpts));
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
