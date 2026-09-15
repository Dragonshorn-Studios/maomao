import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Config } from "./config.js";
import type { JobStore } from "./jobs/store.js";
import { handleGithubWebhook } from "./github/webhooks.js";
import type { ManualTriggerPort, GithubPort } from "./github/client.js";
import { authorizeGithubAccount, logAuthorizationRejection, logRateLimited, rejectUnauthorized } from "./github/authorize.js";
import { repoRateLimitActive, RepoRateLimiter, WindowRateLimiter } from "./github/rate-limit.js";
import { parseGithubPullUrl, PullUrlError } from "./github/pull-url.js";
import { dispatchEnqueue, enqueuePullJob } from "./jobs/enqueue.js";
import { subscribe } from "./events.js";
import { renderHome, renderJob, renderLogin, THEME_CSS } from "./ui/index.js";
import type { JobQueue } from "./jobs/queue.js";
import {
  CSRF_COOKIE,
  CSRF_FIELD,
  CSRF_TTL_MS,
  OAuthStateStore,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  cookieSecure,
  csrfExemptPath,
  csrfRejectReason,
  isPublicPath,
  issueCsrfToken,
  passwordsMatch,
  safeNextPath,
  signOAuthSession,
  signSession,
  uiGateEnabled,
  verifyCsrfRequest,
  verifyCsrfToken,
  verifyOAuthSession,
  verifySession,
  type OAuthSession,
} from "./auth.js";
import { exchangeOauthCode, fetchGithubUser, oauthAuthorizeUrl, oauthEnabled } from "./oauth.js";
import type { LoginError } from "./ui/index.js";

export interface ServerContext {
  config: Config;
  store: JobStore;
  queue: JobQueue;
  startedAt: number;
  github?: ManualTriggerPort & Partial<GithubPort>;
  rateLimiter?: RepoRateLimiter;
  /** Injectable transport for the GitHub OAuth operator-login endpoints (tests). */
  oauthFetch?: typeof fetch;
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_START_LIMIT = 30;
const OAUTH_FAIL_LIMIT = 10;
const OAUTH_WINDOW_MS = 10 * 60 * 1000;

export function createApp(ctx: ServerContext): Hono<{ Variables: { identity?: OAuthSession } }> {
  const app = new Hono<{ Variables: { identity?: OAuthSession } }>();
  const oauthOn = oauthEnabled(ctx.config);
  const passwordGateOn = uiGateEnabled(ctx.config.uiPassword, ctx.config.uiSessionSecret);
  const gateOn = oauthOn || passwordGateOn;
  const passwordLoginOn = passwordGateOn && (!oauthOn || ctx.config.uiLocalLogin);
  const pageOpts = { showLogout: gateOn };
  const loginPageOpts = { showGithub: oauthOn, showPassword: passwordLoginOn };
  const renderLoginDenied = (c: Context) => c.html(renderLogin({ ...loginPageOpts, error: "oauth-denied" }), 403);
  const rateLimiter = ctx.rateLimiter ?? new RepoRateLimiter();
  const authLimiter = new WindowRateLimiter();
  const oauthStates = new OAuthStateStore();

  app.use("*", async (c, next) => {
    if (!gateOn || isPublicPath(c.req.path)) return next();
    const token = getCookie(c, SESSION_COOKIE);
    const oauthSession = verifyOAuthSession(ctx.config.uiSessionSecret, token);
    if (oauthSession) {
      // Re-check the allowlist on every request so removing an id revokes live sessions immediately.
      if (!ctx.config.adminGithubIds.includes(oauthSession.id)) {
        console.warn(`auth: session denied (not allowlisted) id=${oauthSession.id} login=${oauthSession.login}`);
        if (c.req.path.startsWith("/api/") || c.req.path === "/events") {
          return c.json({ error: "forbidden" }, 403);
        }
        return renderLoginDenied(c);
      }
      c.set("identity", oauthSession);
      return next();
    }
    if (verifySession(ctx.config.uiSessionSecret, token)) return next();
    if (c.req.path.startsWith("/api/") || c.req.path === "/events") {
      return c.json({ error: "unauthorized" }, 401);
    }
    const url = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`, 302);
  });

  app.use("*", async (c, next) => {
    if (!gateOn || c.req.method !== "POST" || csrfExemptPath(c.req.path)) return next();
    const cookieToken = getCookie(c, CSRF_COOKIE);
    let fieldToken: string | undefined;
    let bodyNext: string | undefined;
    try {
      // parseBody caches the parsed form on the request, so route handlers can parse it again.
      const body = await c.req.parseBody();
      if (typeof body[CSRF_FIELD] === "string") fieldToken = body[CSRF_FIELD];
      if (typeof body.next === "string") bodyNext = body.next;
    } catch (error) {
      console.warn(
        `csrf: could not parse body for ${c.req.path}:`,
        error instanceof Error ? error.message : error,
      );
      fieldToken = undefined;
    }
    if (!verifyCsrfRequest(ctx.config.uiSessionSecret, cookieToken, fieldToken)) {
      console.warn(`csrf rejected: ${csrfRejectReason(cookieToken, fieldToken)} path=${c.req.path}`);
      if (c.req.path === "/login") {
        return c.html(
          renderLogin({
            ...loginPageOpts,
            error: "csrf",
            nextPath: safeNextPath(bodyNext ?? c.req.query("next")),
            csrfToken: passwordLoginOn ? ensureCsrfToken(c, ctx.config.uiSessionSecret) : undefined,
          }),
          403,
        );
      }
      return c.html(CSRF_FAILURE_HTML, 403);
    }
    return next();
  });

  app.get("/login", (c) => {
    if (!gateOn) return c.redirect("/", 302);
    const token = getCookie(c, SESSION_COOKIE);
    const nextPath = safeNextPath(c.req.query("next"));
    if (verifySession(ctx.config.uiSessionSecret, token) || verifyOAuthSession(ctx.config.uiSessionSecret, token)) {
      return c.redirect(nextPath, 302);
    }
    return c.html(
      renderLogin({
        ...loginPageOpts,
        nextPath,
        csrfToken: passwordLoginOn ? ensureCsrfToken(c, ctx.config.uiSessionSecret) : undefined,
      }),
    );
  });

  app.post("/login", async (c) => {
    if (!passwordLoginOn) return c.redirect("/login", 302);
    const body = await c.req.parseBody();
    const password = typeof body.password === "string" ? body.password : "";
    const nextPath = safeNextPath(typeof body.next === "string" ? body.next : c.req.query("next"));
    if (!passwordsMatch(password, ctx.config.uiPassword)) {
      return c.html(
        renderLogin({
          ...loginPageOpts,
          error: "invalid",
          nextPath,
          csrfToken: ensureCsrfToken(c, ctx.config.uiSessionSecret),
        }),
        401,
      );
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

  app.get("/login/github", (c) => {
    if (!oauthOn) return c.redirect("/login", 302);
    if (!authLimiter.wouldAllow("oauth-start", OAUTH_START_LIMIT, OAUTH_WINDOW_MS)) {
      return c.text("Too many sign-in attempts; try again later.", 429);
    }
    authLimiter.record("oauth-start", OAUTH_START_LIMIT, OAUTH_WINDOW_MS);
    const state = oauthStates.issue(Date.now(), OAUTH_STATE_TTL_MS, safeNextPath(c.req.query("next")));
    return c.redirect(oauthAuthorizeUrl(ctx.config, state), 302);
  });

  app.get("/login/github/callback", async (c) => {
    if (!oauthOn) return c.redirect("/login", 302);
    if (!authLimiter.wouldAllow("oauth-fail", OAUTH_FAIL_LIMIT, OAUTH_WINDOW_MS)) {
      return c.text("Too many failed sign-ins; try again later.", 429);
    }
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code") ?? "";
    const next = oauthStates.consume(url.searchParams.get("state") ?? undefined);
    if (next === undefined) {
      authLimiter.record("oauth-fail", OAUTH_FAIL_LIMIT, OAUTH_WINDOW_MS);
      console.warn("auth: oauth state rejected (missing, expired, or replayed)");
      return c.html(renderLogin({ ...loginPageOpts, error: "oauth-state" }), 403);
    }
    const fetchImpl = ctx.oauthFetch ?? fetch;
    const accessToken = await exchangeOauthCode(ctx.config, code, fetchImpl).catch(() => undefined);
    const user = accessToken ? await fetchGithubUser(accessToken, fetchImpl).catch(() => undefined) : undefined;
    if (!user) {
      authLimiter.record("oauth-fail", OAUTH_FAIL_LIMIT, OAUTH_WINDOW_MS);
      console.warn("auth: oauth token exchange or user lookup failed");
      return c.html(renderLogin({ ...loginPageOpts, error: "oauth-failed" }), 502);
    }
    if (!ctx.config.adminGithubIds.includes(user.id)) {
      authLimiter.record("oauth-fail", OAUTH_FAIL_LIMIT, OAUTH_WINDOW_MS);
      console.warn(`auth: oauth login denied id=${user.id} login=${user.login}`);
      return renderLoginDenied(c);
    }
    // Rotation: always issue a fresh session value at login; the human access token above is
    // used once for identity and never stored.
    setCookie(
      c,
      SESSION_COOKIE,
      signOAuthSession(ctx.config.uiSessionSecret, { id: user.id, login: user.login, avatarUrl: user.avatarUrl }),
      {
        httpOnly: true,
        sameSite: "Lax",
        secure: cookieSecure(c.req.url, c.req.header("x-forwarded-proto")),
        path: "/",
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      },
    );
    console.log(`auth: oauth login id=${user.id} login=${user.login}`);
    return c.redirect(safeNextPath(next), 302);
  });

  app.post("/logout", (c) => {
    const identity = c.get("identity");
    if (identity) console.log(`auth: logout id=${identity.id} login=${identity.login}`);
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

  app.get("/assets/maomao.css", (c) =>
    c.newResponse(THEME_CSS, 200, {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "public, max-age=3600",
    }),
  );

  app.post("/webhooks/github", async (c) => {
    const rawBody = await c.req.text();
    const result = await handleGithubWebhook({
      config: ctx.config,
      store: ctx.store,
      github: isReviewGithub(ctx.github) ? ctx.github : undefined,
      request: {
        event: c.req.header("x-github-event") ?? "",
        deliveryId: c.req.header("x-github-delivery") ?? "",
        signature: c.req.header("x-hub-signature-256") ?? "",
        rawBody,
      },
      rateLimiter,
    });
    if (result.enqueue) {
      dispatchEnqueue(ctx.queue, result.enqueue);
    }
    if (result.dispatchJobId) {
      ctx.queue.enqueue(result.dispatchJobId);
    }
    return c.json(result.body, result.status as 200);
  });

  app.get("/reviews", (c) => c.redirect("/", 302));

  app.post("/reviews", async (c) => {
    const body = await c.req.parseBody();
    const rawUrl = typeof body.url === "string" ? body.url : "";
    const csrfToken = gateOn ? ensureCsrfToken(c, ctx.config.uiSessionSecret) : undefined;
    const identity = c.get("identity");
    const home = (extra: { error?: string; notice?: string; reviewUrl?: string } = {}) =>
      c.html(
        renderHome(ctx.store.listJobs(75), ctx.store, {
          ...pageOpts,
          identity,
          csrfToken,
          ...extra,
          reviewUrl: extra.reviewUrl ?? rawUrl,
        }),
        extra.error ? 400 : 200,
      );

    let parsed: { owner: string; repo: string; number: number };
    try {
      parsed = parseGithubPullUrl(rawUrl);
    } catch (error) {
      const message = error instanceof PullUrlError ? error.message : "Could not parse that pull request URL.";
      return home({ error: message });
    }

    if (!ctx.github) {
      return home({ error: "GitHub App client is not configured on this process." });
    }

    try {
      const installation = await ctx.github.getRepoInstallation(parsed.owner, parsed.repo);
      const accountAuth = authorizeGithubAccount(ctx.config, {
        installationId: installation.installationId,
        accountId: installation.accountId,
      });
      if (!accountAuth.ok) {
        logAuthorizationRejection({
          installationId: installation.installationId,
          reason: accountAuth.reason,
        });
        return home({ error: "Not authorized to review this installation or repository." });
      }

      let repositoryId: number | undefined;
      if (ctx.config.allowedGithubRepositoryIds.length > 0) {
        const repository = await ctx.github.getRepository(
          parsed.owner,
          parsed.repo,
          installation.installationId,
        );
        repositoryId = repository.id;
        const repoAuth = rejectUnauthorized(ctx.config, {
          installationId: installation.installationId,
          accountId: installation.accountId,
          repositoryId: repository.id,
        });
        if (!repoAuth.ok) {
          return home({ error: "Not authorized to review this installation or repository." });
        }
      }

      const pull = await ctx.github.getPull(installation.installationId, parsed.owner, parsed.repo, parsed.number);
      const subject = {
        installationId: pull.installationId,
        accountId: pull.accountId || installation.accountId,
        repositoryId: pull.repositoryId || repositoryId,
      };
      const auth = rejectUnauthorized(ctx.config, subject);
      if (!auth.ok) {
        return home({ error: "Not authorized to review this installation or repository." });
      }

      if (pull.draft && !ctx.config.reviewDrafts) {
        return home({ error: "Ignored draft pull request (set REVIEW_DRAFTS=true to review drafts)." });
      }

      const resolvedRepoId = subject.repositoryId;
      const rateOn = repoRateLimitActive(ctx.config.repoRateLimitPerWindow, ctx.config.repoRateWindowMs);
      if (rateOn) {
        if (resolvedRepoId == null) {
          logAuthorizationRejection({
            installationId: pull.installationId,
            reason: "missing repository id",
          });
          return home({ error: "Not authorized to review this installation or repository." });
        }
        if (
          !rateLimiter.wouldAllow(
            resolvedRepoId,
            ctx.config.repoRateLimitPerWindow,
            ctx.config.repoRateWindowMs,
          )
        ) {
          logRateLimited({ installationId: pull.installationId, repositoryId: resolvedRepoId });
          return home({ error: "Rate limited for this repository; try again later." });
        }
      }

      const enqueue = enqueuePullJob(ctx.store, ctx.config, {
        repoFullName: pull.repoFullName,
        repoOwner: pull.repoOwner,
        repoName: pull.repoName,
        installationId: pull.installationId,
        githubAccountId: subject.accountId,
        githubRepositoryId: resolvedRepoId,
        prNumber: pull.prNumber,
        prTitle: pull.prTitle,
        prBody: pull.prBody,
        prHtmlUrl: pull.prHtmlUrl,
        prAuthor: pull.prAuthor,
        baseSha: pull.baseSha,
        headSha: pull.headSha,
        baseRef: pull.baseRef,
        headRef: pull.headRef,
        webhookEvent: "manual.ui",
      });
      if (enqueue.created && rateOn && resolvedRepoId != null) {
        rateLimiter.record(resolvedRepoId, ctx.config.repoRateLimitPerWindow, ctx.config.repoRateWindowMs);
      }
      dispatchEnqueue(ctx.queue, enqueue);
      const notice = enqueue.created ? "queued" : "exists";
      return c.redirect(`/jobs/${enqueue.job.id}?notice=${notice}`, 302);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return home({ error: message });
    }
  });

  app.get("/", (c) => {
    const jobs = ctx.store.listJobs(75);
    return c.html(
      renderHome(jobs, ctx.store, {
        ...pageOpts,
        identity: c.get("identity"),
        csrfToken: gateOn ? ensureCsrfToken(c, ctx.config.uiSessionSecret) : undefined,
        notice: noticeText(c.req.query("notice")),
        error: c.req.query("error") || undefined,
      }),
    );
  });

  app.get("/jobs/:id", (c) => {
    const id = Number(c.req.param("id"));
    const job = ctx.store.getJob(id);
    if (!job) return c.text("Not found", 404);
    return c.html(
      renderJob(job, ctx.store.listReviewerRuns(id), ctx.store.listLogs(id), {
        ...pageOpts,
        identity: c.get("identity"),
        csrfToken: gateOn ? ensureCsrfToken(c, ctx.config.uiSessionSecret) : undefined,
        notice: noticeText(c.req.query("notice"), job.repo_full_name, job.pr_number, job.head_sha),
        prFindings: ctx.store.listFindings(job.repo_full_name, job.pr_number),
      }),
    );
  });

  app.post("/jobs/:id/retry", (c) => retryJob(c, ctx, Number(c.req.param("id"))));
  app.post("/jobs/:id/reviewers/:runId/retry", (c) => {
    const runId = Number(c.req.param("runId"));
    if (!Number.isFinite(runId)) return c.text("Not found", 404);
    return retryJob(c, ctx, Number(c.req.param("id")), runId);
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
      findings: ctx.store.listFindings(job.repo_full_name, job.pr_number),
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

function noticeText(
  code: string | undefined,
  repo?: string,
  pr?: number,
  sha?: string,
): string | undefined {
  if (code === "queued") {
    const target = repo && pr != null ? ` ${repo}#${pr}` : "";
    const short = sha ? ` (${sha.slice(0, 12)})` : "";
    return `Queued a review${target}${short} for this exact head SHA.`;
  }
  if (code === "exists") {
    return "A job already exists for this repository, pull request, and head SHA.";
  }
  if (code === "retry") {
    return "Re-queued failed reviewer(s) for this head SHA.";
  }
  return undefined;
}

// Reuses a still-valid token instead of rotating: per-request rotation would 403 forms open in other tabs.
function ensureCsrfToken(c: Context, secret: string): string {
  const existing = getCookie(c, CSRF_COOKIE);
  if (existing && verifyCsrfToken(secret, existing)) return existing;
  const token = issueCsrfToken(secret);
  setCookie(c, CSRF_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: cookieSecure(c.req.url, c.req.header("x-forwarded-proto")),
    path: "/",
    maxAge: Math.floor(CSRF_TTL_MS / 1000),
  });
  return token;
}

function retryJob(c: Context, ctx: ServerContext, jobId: number, runId?: number) {
  const job = ctx.store.getJob(jobId);
  if (!job) return c.text("Not found", 404);
  const result = ctx.store.retryFailedReviewers(jobId, runId);
  if (!result.ok) {
    const gate = oauthEnabled(ctx.config) || uiGateEnabled(ctx.config.uiPassword, ctx.config.uiSessionSecret);
    return c.html(
      renderJob(job, ctx.store.listReviewerRuns(jobId), ctx.store.listLogs(jobId), {
        showLogout: gate,
        identity: c.get("identity"),
        csrfToken: gate ? ensureCsrfToken(c, ctx.config.uiSessionSecret) : undefined,
        error: result.error,
        prFindings: ctx.store.listFindings(job.repo_full_name, job.pr_number),
      }),
      400,
    );
  }
  ctx.queue.enqueue(jobId);
  return c.redirect(`/jobs/${jobId}?notice=retry`, 302);
}

const CSRF_FAILURE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Maomao — form expired</title>
  <link rel="stylesheet" href="/assets/maomao.css"/>
</head>
<body>
  <main id="main">
    <p class="error" role="alert">This form was missing a valid CSRF token, or its token expired. Go back, reload the page, and try again.</p>
    <p><a href="/">Back to jobs</a></p>
  </main>
</body>
</html>`;

function isReviewGithub(github: (ManualTriggerPort & Partial<GithubPort>) | undefined): github is ManualTriggerPort & GithubPort {
  return Boolean(
    github &&
      typeof github.listReviewThreads === "function" &&
      typeof github.resolveReviewThread === "function" &&
      typeof github.getCollaboratorPermission === "function",
  );
}
