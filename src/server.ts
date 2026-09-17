import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Config } from "./config.js";
import type { JobStore } from "./jobs/store.js";
import { handleGithubWebhook } from "./github/webhooks.js";
import type { ManualTriggerPort, GithubPort } from "./github/client.js";
import type { OpenCodePort } from "./opencode/parse.js";
import { authorizeGithubAccount, authorizeGithubRepository, authorizeGithubTarget, logAuthorizationRejection, logRateLimited, rejectUnauthorized } from "./github/authorize.js";
import { repoRateLimitActive, RepoRateLimiter, WindowRateLimiter } from "./github/rate-limit.js";
import { parseGithubPullUrl, PullUrlError } from "./github/pull-url.js";
import { dispatchEnqueue, enqueuePullJob } from "./jobs/enqueue.js";
import { cancelJob } from "./jobs/cancel.js";
import { LIVE_JOB_STATES } from "./config.js";
import { effectiveConfigEntries } from "./config-effective.js";
import type { ProfileFieldErrors } from "./config-form.js";
import { decodeProfileAction, decodeProfileForm, applyProfileAction, profileFormToDefinition } from "./config-form.js";
import { KNOWN_REVIEWER_ROLES } from "./prompts.js";
import { subscribe } from "./events.js";
import { redactSecrets } from "./util.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  renderScanConfirmPage,
  renderScanIssuePreviewPage,
  renderScanPage,
  renderCancelConfirmPage,
  renderConfigPage,
  renderProfileForm,
  renderHome,
  renderJob,
  renderLogin,
  renderPromptConfigPage,
  THEME_CSS,
  PIERRE_DIFFS_HREF,
  TYPEAHEAD_HREF,
  TYPEAHEAD_JS,
  FAVICON_SVG,
  FAVICON_PNG_BASE64,
  LARGE_ICON_SVG,
  LARGE_ICON_PNG_BASE64,
  type PageOptions,
  type ScanConfirmNotice,
  type ScanIssueCreationData,
  type ScanIssuePreviewItem,
  type ScanPageData,
} from "./ui/index.js";
import type { JobRow } from "./jobs/store.js";
import type { FindingRow } from "./findings/types.js";
import type { ConfigPageData } from "./ui/index.js";
import { issueWorthiness, parseAggregatedFindings, type IssueWorthiness } from "./findings/issue-worthiness.js";
import { SCAN_ISSUE_MARKER_RE, scanIssueMarkerBase } from "./findings/identity.js";
import { githubSecrets } from "./config.js";
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
import { exchangeOAuthCode, fetchGithubUser, oauthAuthorizeUrl, oauthEnabled } from "./oauth.js";

export interface ServerContext {
  config: Config;
  /** Directory holding the esbuild-bundled @pierre/diffs asset (tests may override). */
  vendorAssetsDir?: string;
  store: JobStore;
  queue: JobQueue;
  startedAt: number;
  github?: ManualTriggerPort & Partial<GithubPort>;
  rateLimiter?: RepoRateLimiter;
  /** Injectable transport for the GitHub OAuth operator-login endpoints (tests). */
  oauthFetch?: typeof fetch;
  /** Offline prompt-evaluation runner (never touches GitHub). */
  opencode?: OpenCodePort;
  /** The environment loadConfig consumed; defaults to process.env. Injectable for tests. */
  env?: NodeJS.ProcessEnv;
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_START_LIMIT = 30;
const OAUTH_FAIL_LIMIT = 10;
const OAUTH_WINDOW_MS = 10 * 60 * 1000;
/** Global ceilings (10x per-IP) contain distributed abuse without letting one visitor lock everyone out. */
const OAUTH_GLOBAL_MULTIPLIER = 10;

type AppEnv = { Variables: { identity?: OAuthSession } };

function clientKey(c: Context<AppEnv>): string {
  const first = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return first || "local";
}

// ---- Health-scan issue creation helpers ----

/** Checked checkboxes with name `fp[]` arrive as an array of strings (or a single value). */
function fingerprintList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  return list
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .map((entry) => entry.trim());
}

/** GitHub refuses writes with 403 (missing permission) or 404 (repo hidden from the App). */
function isPermissionDenied(error: unknown): boolean {
  if (isTransientAbuseLimit(error)) return false;
  const status = (error as { status?: unknown } | null)?.status;
  return status === 403 || status === 404;
}

/**
 * GitHub also uses 403 for transient conditions — abuse detection and both
 * secondary and primary rate limits ("API rate limit exceeded ..."). Those are
 * retryable, not a permission problem.
 */
function isTransientAbuseLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /secondary rate limit|abuse|rate limit exceeded/i.test(message);
}

function duplicateSearchQuery(summary: string): string {
  return summary
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(" ");
}

/**
 * Finding text comes from the scanned repository. Neutralize any fake dedup
 * markers it may contain (so marker-based dedup cannot be spoofed) and redact
 * runtime secrets as defense in depth before the text lands in a public issue.
 */
function sanitizeIssueText(text: string, config: Config): string {
  return redactSecrets(text.replace(SCAN_ISSUE_MARKER_RE, "[neutralized maomao marker]"), githubSecrets(config));
}

function buildScanIssue(config: Config, job: JobRow, finding: FindingRow): { title: string; body: string } {
  const severity = (finding.severity ?? "info").toUpperCase();
  const marker = `${scanIssueMarkerBase(finding.fingerprint)} @ ${finding.reviewed_sha} -->`;
  const evidence = finding.diff_hunk ? `\n\n\`\`\`diff\n${sanitizeIssueText(finding.diff_hunk, config)}\n\`\`\`` : "";
  const body = `${marker}\n\n**${severity}** — ${sanitizeIssueText(finding.summary ?? "", config)}\n\n${sanitizeIssueText(finding.body ?? "", config)}\n\nFile: \`${sanitizeIssueText(finding.current_path ?? "unknown", config)}${finding.current_line ? `:${finding.current_line}` : ""}\`\nReviewed SHA: ${finding.reviewed_sha}\nDiscovered by a manual Maomao health scan (job ${job.id}).${evidence}`;
  return {
    title: `[maomao] ${severity}: ${sanitizeIssueText(finding.summary ?? finding.fingerprint, config)}`,
    body,
  };
}

interface ScanIssueEntry {
  row: FindingRow;
  agreed: string[];
  worth: IssueWorthiness;
}

/**
 * Resolves a scan's own open findings against the aggregator snapshot and the
 * publication bar — the single source both the job-page form and the issue
 * routes use, so they cannot drift on which findings are eligible.
 */
function scanOpenFindings(store: JobStore, job: JobRow): ScanIssueEntry[] {
  const aggregated = parseAggregatedFindings(job.aggregator_normalized, `job ${job.id} (${job.repo_full_name})`);
  return store
    .listFindings(job.repo_full_name, job.pr_number)
    .filter((row) => row.status === "open" && row.last_job_id === job.id)
    .map((row) => {
      const aggregatedFinding = aggregated.get(row.fingerprint);
      return {
        row,
        agreed: aggregatedFinding?.reviewers_agreed ?? [],
        worth: issueWorthiness(aggregatedFinding),
      };
    });
}

/**
 * Resolves selected fingerprints against the job's own open findings and the
 * publication bar. Fingerprints that do not belong to this scan are reported
 * separately so crafted POSTs are rejected, not silently ignored.
 */
function scanIssueSelection(store: JobStore, job: JobRow, fingerprints: string[]): { selected: ScanIssueEntry[]; unknown: string[] } {
  const byFingerprint = new Map(scanOpenFindings(store, job).map((entry) => [entry.row.fingerprint, entry]));
  const selected: ScanIssueEntry[] = [];
  const unknown: string[] = [];
  for (const fingerprint of fingerprints) {
    const entry = byFingerprint.get(fingerprint);
    if (!entry) {
      unknown.push(fingerprint);
      continue;
    }
    selected.push(entry);
  }
  return { selected, unknown };
}

function setSessionCookie(c: Context<AppEnv>, value: string): void {
  setCookie(c, SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "Lax",
    secure: cookieSecure(c.req.url, c.req.header("x-forwarded-proto")),
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function createApp(ctx: ServerContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const oauthOn = oauthEnabled(ctx.config);
  const passwordGateOn = uiGateEnabled(ctx.config.uiPassword, ctx.config.uiSessionSecret);
  const gateOn = oauthOn || passwordGateOn;
  const passwordLoginOn = passwordGateOn && (!oauthOn || ctx.config.uiLocalLogin);
  const pageOpts = { showLogout: gateOn, uiFlavor: ctx.config.uiFlavor };
  const loginPageOpts = { showGithub: oauthOn, showPassword: passwordLoginOn };
  const renderLoginDenied = (c: Context<AppEnv>) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.html(renderLogin({ ...loginPageOpts, error: "oauth-denied" }), 403);
  };
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
        // Clear the stale cookie so the noise (and the denial) ends after this response.
        deleteCookie(c, SESSION_COOKIE, { path: "/" });
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
    if (!passwordLoginOn) {
      console.warn("auth: password login attempted while disabled");
      return c.redirect("/login", 302);
    }
    const body = await c.req.parseBody();
    const password = typeof body.password === "string" ? body.password : "";
    const nextPath = safeNextPath(typeof body.next === "string" ? body.next : c.req.query("next"));
    // The explicit uiPassword check matters: passwordsMatch("", "") is true, and uiPassword is
    // "" whenever the password gate is off.
    if (!ctx.config.uiPassword || !passwordsMatch(password, ctx.config.uiPassword)) {
      console.warn("auth: password login failed");
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
    console.log("auth: password login");
    setSessionCookie(c, signSession(ctx.config.uiSessionSecret));
    return c.redirect(nextPath, 302);
  });

  app.get("/login/github", (c) => {
    if (!oauthOn) return c.redirect("/login", 302);
    const ip = clientKey(c);
    if (
      !authLimiter.wouldAllow(`start:${ip}`, OAUTH_START_LIMIT, OAUTH_WINDOW_MS) ||
      !authLimiter.wouldAllow("start:global", OAUTH_START_LIMIT * OAUTH_GLOBAL_MULTIPLIER, OAUTH_WINDOW_MS)
    ) {
      console.warn(`auth: oauth start rate limit tripped ip=${ip}`);
      return c.text("Too many sign-in attempts; try again later.", 429);
    }
    authLimiter.record(`start:${ip}`, OAUTH_START_LIMIT, OAUTH_WINDOW_MS);
    authLimiter.record("start:global", OAUTH_START_LIMIT * OAUTH_GLOBAL_MULTIPLIER, OAUTH_WINDOW_MS);
    const state = oauthStates.issue(Date.now(), OAUTH_STATE_TTL_MS, safeNextPath(c.req.query("next")));
    return c.redirect(oauthAuthorizeUrl(ctx.config, state), 302);
  });

  app.get("/login/github/callback", async (c) => {
    if (!oauthOn) return c.redirect("/login", 302);
    const ip = clientKey(c);
    if (
      !authLimiter.wouldAllow(`fail:${ip}`, OAUTH_FAIL_LIMIT, OAUTH_WINDOW_MS) ||
      !authLimiter.wouldAllow("fail:global", OAUTH_FAIL_LIMIT * OAUTH_GLOBAL_MULTIPLIER, OAUTH_WINDOW_MS)
    ) {
      console.warn(`auth: oauth failure rate limit tripped ip=${ip}`);
      return c.text("Too many failed sign-ins; try again later.", 429);
    }
    const url = new URL(c.req.url);
    const next = oauthStates.consume(url.searchParams.get("state") ?? undefined);
    if (next === undefined) {
      authLimiter.record(`fail:${ip}`, OAUTH_FAIL_LIMIT, OAUTH_WINDOW_MS);
      authLimiter.record("fail:global", OAUTH_FAIL_LIMIT * OAUTH_GLOBAL_MULTIPLIER, OAUTH_WINDOW_MS);
      console.warn(`auth: oauth state rejected (missing, expired, or replayed) ip=${ip}`);
      return c.html(renderLogin({ ...loginPageOpts, error: "oauth-state" }), 403);
    }
    const providerError = url.searchParams.get("error");
    if (providerError) {
      // User-initiated cancel or provider-side refusal: no code exists, so this is not a
      // protocol failure and does not count toward the failure budget.
      console.log(`auth: oauth sign-in not completed at provider (${providerError}) ip=${ip}`);
      return c.html(renderLogin({ ...loginPageOpts, error: "oauth-cancelled" }), 400);
    }
    const fetchImpl = ctx.oauthFetch ?? fetch;
    const accessToken = await exchangeOAuthCode(ctx.config, url.searchParams.get("code") ?? "", fetchImpl);
    const user = accessToken ? await fetchGithubUser(accessToken, fetchImpl) : undefined;
    if (!user) {
      authLimiter.record(`fail:${ip}`, OAUTH_FAIL_LIMIT, OAUTH_WINDOW_MS);
      authLimiter.record("fail:global", OAUTH_FAIL_LIMIT * OAUTH_GLOBAL_MULTIPLIER, OAUTH_WINDOW_MS);
      console.warn("auth: oauth token exchange or user lookup failed");
      return c.html(renderLogin({ ...loginPageOpts, error: "oauth-failed" }), 502);
    }
    if (!ctx.config.adminGithubIds.includes(user.id)) {
      authLimiter.record(`fail:${ip}`, OAUTH_FAIL_LIMIT, OAUTH_WINDOW_MS);
      authLimiter.record("fail:global", OAUTH_FAIL_LIMIT * OAUTH_GLOBAL_MULTIPLIER, OAUTH_WINDOW_MS);
      console.warn(`auth: oauth login denied id=${user.id} login=${user.login} ip=${ip}`);
      return renderLoginDenied(c);
    }
    // Rotation: always issue a fresh session value at login; the human access token above is
    // used once for identity and never stored.
    setSessionCookie(
      c,
      signOAuthSession(ctx.config.uiSessionSecret, { id: user.id, login: user.login, avatarUrl: user.avatarUrl }),
    );
    console.log(`auth: oauth login id=${user.id} login=${user.login}`);
    return c.redirect(safeNextPath(next), 302);
  });

  app.post("/logout", (c) => {
    // /logout is a public path, so the session middleware never set `identity`; derive it here.
    const identity = verifyOAuthSession(ctx.config.uiSessionSecret, getCookie(c, SESSION_COOKIE));
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

  // The @pierre/diffs browser bundle (built by `npm run build:vendor`). Read
  // once from disk and cached; 404 before the first build so pages fall back
  // to the server-rendered diff markup.
  const vendorDir = ctx.vendorAssetsDir ?? resolve(process.cwd(), "dist/assets/vendor");
  let pierreBundle: string | null | undefined;
  app.get(PIERRE_DIFFS_HREF, (c) => {
    // Only successful reads are cached: a server started before the vendor
    // build keeps retrying, so the asset appears without a restart.
    if (pierreBundle === undefined) {
      try {
        pierreBundle = readFileSync(resolve(vendorDir, "pierre-diffs.js"), "utf8");
      } catch {
        console.warn("assets: pierre-diffs bundle not built; run npm run build:vendor");
        return c.text("Not found", 404);
      }
    }
    return c.newResponse(pierreBundle, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
    });
  });

  app.get(TYPEAHEAD_HREF, (c) =>
    c.newResponse(TYPEAHEAD_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
    }),
  );

  // Brand icons: fixed constants from src/ui/icons.ts (no filesystem, no traversal).
  const iconAssets: Array<[string, string, string]> = [
    // [path, content-type, source]
    ["/assets/favicon.svg", "image/svg+xml", FAVICON_SVG],
    ["/assets/icon.svg", "image/svg+xml", LARGE_ICON_SVG],
  ];
  for (const [path, contentType, body] of iconAssets) {
    app.get(path, (c) =>
      c.newResponse(body, 200, {
        "content-type": `${contentType}; charset=utf-8`,
        "cache-control": "public, max-age=86400",
      }),
    );
  }
  const pngAssets: Array<[string, string]> = [
    ["/assets/favicon.png", FAVICON_PNG_BASE64],
    ["/assets/icon.png", LARGE_ICON_PNG_BASE64],
  ];
  for (const [path, base64] of pngAssets) {
    app.get(path, (c) =>
      c.newResponse(new Uint8Array(Buffer.from(base64, "base64")), 200, {
        "content-type": "image/png",
        "cache-control": "public, max-age=86400",
      }),
    );
  }

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
      // Dropped from the in-memory queue inside the handler, before any
      // post-cancellation logging could fail; abortMany is idempotent.
      abortJobs: (ids) => ctx.queue.abortMany(ids),
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
    const homePage = ctx.store.listJobsPage({});
    const home = (extra: { error?: string; notice?: string; reviewUrl?: string } = {}) =>
      c.html(
        renderHome(homePage.jobs, ctx.store, {
          ...pageOpts,
          identity,
          csrfToken,
          ...extra,
          reviewUrl: extra.reviewUrl ?? rawUrl,
          pagination: { hasOlder: homePage.hasOlder, hasNewer: homePage.hasNewer },
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

      // A pull a verified webhook recorded as merged is a terminal review
      // target, no matter what the URL form says (best-effort: merges Maomao
      // never saw are not in the marker table).
      if (ctx.store.hasMergedPull(pull.repoFullName, pull.prNumber)) {
        return home({ error: "This pull request is already merged; not queueing a review." });
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
    const cursor = jobsPageCursor(c.req.query("before"), c.req.query("after"));
    let page = ctx.store.listJobsPage(cursor);
    // Only out-of-range cursors empty the page: after at/past the newest id,
    // or before at/below the oldest id. (A before cursor past the newest id
    // never gets here empty — the store's id< query already returns the
    // newest page.) If the page is empty while jobs exist, re-render the
    // first page and say why instead of a dead end.
    let staleCursorNotice: string | undefined;
    if (page.jobs.length === 0) {
      page = ctx.store.listJobsPage({});
      if (page.jobs.length > 0 && (cursor.before != null || cursor.after != null)) {
        staleCursorNotice = "That page no longer exists — showing the newest jobs instead.";
      }
    }
    return c.html(
      renderHome(page.jobs, ctx.store, {
        ...pageOpts,
        identity: c.get("identity"),
        csrfToken: gateOn ? ensureCsrfToken(c, ctx.config.uiSessionSecret) : undefined,
        notice: noticeText(c.req.query("notice")) ?? staleCursorNotice,
        error: c.req.query("error") || undefined,
        pagination: { hasOlder: page.hasOlder, hasNewer: page.hasNewer },
      }),
    );
  });

  app.get("/jobs/:id", (c) => {
    const id = Number(c.req.param("id"));
    const job = ctx.store.getJob(id);
    if (!job) return c.text("Not found", 404);
    const latest = ctx.store.findLatestJobForPull(job.repo_full_name, job.pr_number);
    return c.html(
      renderJob(job, ctx.store.listReviewerRuns(id), ctx.store.listLogs(id), {
        ...pageOpts,
        identity: c.get("identity"),
        csrfToken: gateOn ? ensureCsrfToken(c, ctx.config.uiSessionSecret) : undefined,
        prHeadSha: latest?.head_sha ?? job.head_sha,
        notice: noticeText(c.req.query("notice"), job.repo_full_name, job.pr_number, job.head_sha),
        error: c.req.query("error") || undefined,
        prFindings: ctx.store.listFindings(job.repo_full_name, job.pr_number),
        scanIssueCreation: scanIssueCreationData(job),
        scanIssues: job.job_type === "health_scan" ? ctx.store.listScanIssues(job.id) : undefined,
      }),
    );
  });

  app.post("/jobs/:id/retry", (c) => retryJob(c, ctx, pageOpts, Number(c.req.param("id"))));
  app.post("/jobs/:id/reviewers/:runId/retry", (c) => {
    const runId = Number(c.req.param("runId"));
    if (!Number.isFinite(runId)) return c.text("Not found", 404);
    return retryJob(c, ctx, pageOpts, Number(c.req.param("id")), runId);
  });

  app.post("/jobs/:id/dequeue", (c) => dequeueJob(c, ctx, pageOpts, Number(c.req.param("id"))));
  app.get("/jobs/:id/cancel", (c) => renderCancelConfirm(c, ctx, pageOpts, Number(c.req.param("id"))));
  app.post("/jobs/:id/cancel", (c) => cancelRunningJob(c, ctx, pageOpts, Number(c.req.param("id"))));

  // ---- Versioned review-profile configuration (/config) ----
  const configWriteDenied = (c: Context<AppEnv>) =>
    c.html(
      renderConfigPage({
        revisions: ctx.store.configs.listRevisions(),
        audit: ctx.store.configs.listAudit(),
        canWrite: false,
        error: "Writing configuration requires an operator GitHub OAuth identity.",
      }),
      403,
    );
  const configActor = (c: Context<AppEnv>): { login: string } | undefined => c.get("identity");
  const parseDefinition = (
    raw: string | undefined,
  ): { ok: true; definition: unknown } | { ok: false; error: string } => {
    try {
      return { ok: true, definition: JSON.parse(raw ?? "{}") };
    } catch {
      return { ok: false, error: "Definition must be valid JSON." };
    }
  };
  const KNOWN_ROLE_OPTIONS = KNOWN_REVIEWER_ROLES.map((role) => ({ id: role.id, title: role.title }));
  const profileEditorBase = () => ({
    knownRoles: KNOWN_ROLE_OPTIONS,
    modelCatalog: ctx.config.modelCatalog,
  });

  const renderConfigWithError = (
    c: Context<AppEnv>,
    message: string,
    status: 400 | 403 | 404 | 409,
    profileEditor?: ConfigPageData["profileEditor"],
  ) => {
    return c.html(
      renderConfigPage({
        revisions: ctx.store.configs.listRevisions(),
        audit: ctx.store.configs.listAudit(),
        canWrite: gateOn,
        error: message,
        csrfToken: gateOn ? ensureCsrfToken(c, ctx.config.uiSessionSecret) : undefined,
        effectiveConfig: effectiveConfigEntries(
          ctx.config,
          ctx.env ?? process.env,
          ctx.store.configs.getActiveRevision("default") ?? null,
        ),
        profileEditor: profileEditor ?? profileEditorBase(),
      }),
      status,
    );
  };

  app.get("/config", (c) => {
    if (!gateOn) return c.redirect("/", 302);
    const notices: Record<string, string> = {
      "draft-created": "Draft created.",
      "draft-saved": "Draft saved.",
      activated: "Revision activated.",
      "rolled-back": "Revision rolled back.",
      imported: "Configuration imported as drafts.",
    };
    const noticeKey = c.req.query("notice") ?? "";
    return c.html(
      renderConfigPage({
        revisions: ctx.store.configs.listRevisions(),
        audit: ctx.store.configs.listAudit(),
        canWrite: gateOn,
        csrfToken: gateOn ? ensureCsrfToken(c, ctx.config.uiSessionSecret) : undefined,
        notice: notices[noticeKey],
        effectiveConfig: effectiveConfigEntries(
          ctx.config,
          ctx.env ?? process.env,
          ctx.store.configs.getActiveRevision("default") ?? null,
        ),
        profileEditor: profileEditorBase(),
      }),
    );
  });

  /**
   * Structured-editor form handling: applies add/remove/reorder actions by
   * re-rendering the form with mutated values (no persistence), or decodes
   * and validates on save. Raw-JSON submissions (no `editor` field) keep the
   * old path so scripts and export/import round-trips are unaffected.
   */
  type ProfileFormOutcome =
    | { kind: "render"; response: Response }
    | { kind: "save"; definition: unknown; note?: string };

  /**
   * Structural actions and validation failures re-render the full config
   * page (chrome, audit, effective config) with the in-progress form state
   * applied — never a bare fragment, and never a persistence side effect:
   * noop actions (boundary/malformed clicks) also land here untouched.
   */
  const handleProfileForm = async (
    c: Context<AppEnv>,
    body: Record<string, unknown>,
    existing?: { id: number; editSeq: number },
  ): Promise<ProfileFormOutcome> => {
    let values = decodeProfileForm(body);
    let definition: unknown;
    const action = decodeProfileAction(body);
    const errors: ProfileFieldErrors = {};
    const isStructural = action.kind !== "save";
    if (action.kind === "noop") {
      errors.form = "That row action does not apply — nothing changed.";
    } else if (action.kind !== "save") {
      values = applyProfileAction(values, action, KNOWN_ROLE_OPTIONS.map((role) => role.id));
    } else {
      const built = profileFormToDefinition(values);
      if (!built.ok) {
        for (const [key, message] of Object.entries(built.errors)) {
          if (key !== "form" && !errors[key]) errors[key] = message;
        }
        if (!errors.form) errors.form = built.errors.form;
      } else {
        definition = built.definition;
        // Semantic checks the schema cannot express: duplicates flag the later
        // row, and an empty reviewer list must be an explicit choice.
        const seen = new Map<string, number>();
        values.reviewers.forEach((row, index) => {
          if (!row.role) return;
          const first = seen.get(row.role);
          if (first != null && !errors[`reviewer_role_${index}`]) {
            errors[`reviewer_role_${index}`] = `role already used in reviewer ${first + 1}`;
          } else {
            seen.set(row.role, index);
          }
        });
        if (values.reviewers.length === 0) {
          errors.form = "At least one reviewer row is required.";
        }
      }
    }
    // Structural actions and failures re-render the full page; a noop click
    // is a harmless no-op (200 with a status note), validation failures 400.
    if (isStructural || Object.keys(errors).length > 0) {
      return {
        kind: "render",
        response: c.html(
          renderConfigPage({
            revisions: ctx.store.configs.listRevisions(),
            audit: ctx.store.configs.listAudit(),
            canWrite: gateOn,
            error: errors.form,
            csrfToken: ensureCsrfToken(c, ctx.config.uiSessionSecret),
            effectiveConfig: effectiveConfigEntries(
              ctx.config,
              ctx.env ?? process.env,
              ctx.store.configs.getActiveRevision("default") ?? null,
            ),
            profileEditor: {
              ...profileEditorBase(),
              form: { values, errors, revision: existing },
            },
          }),
          isStructural ? 200 : 400,
        ),
      };
    }
    return { kind: "save", definition, note: values.note };
  };

  app.post("/config/drafts", async (c) => {
    if (!gateOn) return c.redirect("/", 302);
    const actor = configActor(c);
    if (!actor) return configWriteDenied(c);
    const bodyPreview = await c.req.parseBody();
    if (bodyPreview.editor === "structured") {
      const outcome = await handleProfileForm(c, bodyPreview);
      if (outcome.kind === "render") return outcome.response;
      const result = ctx.store.configs.createDraft({
        definition: outcome.definition,
        note: outcome.note,
        createdBy: actor.login,
      });
      if ("error" in result) {
        const values = decodeProfileForm(bodyPreview);
        return c.html(
          renderConfigPage({
            revisions: ctx.store.configs.listRevisions(),
            audit: ctx.store.configs.listAudit(),
            canWrite: gateOn,
            error: result.issues.join("; "),
            csrfToken: ensureCsrfToken(c, ctx.config.uiSessionSecret),
            effectiveConfig: effectiveConfigEntries(
              ctx.config,
              ctx.env ?? process.env,
              ctx.store.configs.getActiveRevision("default") ?? null,
            ),
            profileEditor: {
              ...profileEditorBase(),
              form: { values, errors: { form: result.issues.join("; ") } },
            },
          }),
          400,
        );
      }
      return c.redirect("/config?notice=draft-created", 302);
    }
    const parsed = parseDefinition(typeof bodyPreview.definition === "string" ? bodyPreview.definition : undefined);
    if (!parsed.ok) return renderConfigWithError(c, parsed.error, 400);
    const result = ctx.store.configs.createDraft({
      definition: parsed.definition,
      createdBy: actor.login,
    });
    if ("error" in result) return renderConfigWithError(c, result.issues.join("; "), 400);
    return c.redirect("/config?notice=draft-created", 302);
  });

  app.post("/config/drafts/:id", async (c) => {
    if (!gateOn) return c.redirect("/", 302);
    const actor = configActor(c);
    if (!actor) return configWriteDenied(c);
    const bodyPreview = await c.req.parseBody();
    const revisionId = Number(c.req.param("id"));
    const expectedEditSeq = Number(bodyPreview.expected_edit_seq ?? -1);
    if (bodyPreview.editor === "structured") {
      const existing = ctx.store.configs.getRevision(revisionId);
      if (!existing || existing.status !== "draft") {
        return renderConfigWithError(c, "Draft not found.", 404);
      }
      const editSeq = Number.isFinite(expectedEditSeq) ? expectedEditSeq : existing.editSeq;
      const outcome = await handleProfileForm(c, bodyPreview, {
        id: revisionId,
        editSeq,
      });
      if (outcome.kind === "render") return outcome.response;
      const result = ctx.store.configs.updateDraft({
        id: revisionId,
        definition: outcome.definition,
        note: outcome.note,
        expectedEditSeq,
        updatedBy: actor.login,
      });
      if ("error" in result && result.error === "conflict") {
        return renderConfigWithError(
          c,
          "Conflict: this draft was saved by someone else. Reload and re-apply your edit.",
          409,
        );
      }
      if ("error" in result) {
        if (result.error !== "invalid") {
          return renderConfigWithError(c, "Draft not found.", 404);
        }
        const values = decodeProfileForm(bodyPreview);
        return c.html(
          renderConfigPage({
            revisions: ctx.store.configs.listRevisions(),
            audit: ctx.store.configs.listAudit(),
            canWrite: gateOn,
            error: result.issues.join("; "),
            csrfToken: ensureCsrfToken(c, ctx.config.uiSessionSecret),
            effectiveConfig: effectiveConfigEntries(
              ctx.config,
              ctx.env ?? process.env,
              ctx.store.configs.getActiveRevision("default") ?? null,
            ),
            profileEditor: {
              ...profileEditorBase(),
              form: {
                values,
                errors: { form: result.issues.join("; ") },
                revision: { id: revisionId, editSeq },
              },
            },
          }),
          400,
        );
      }
      return c.redirect("/config?notice=draft-saved", 302);
    }
    const parsed = parseDefinition(typeof bodyPreview.definition === "string" ? bodyPreview.definition : undefined);
    if (!parsed.ok) return renderConfigWithError(c, parsed.error, 400);
    const result = ctx.store.configs.updateDraft({
      id: revisionId,
      definition: parsed.definition,
      expectedEditSeq,
      updatedBy: actor.login,
    });
    if ("error" in result && result.error === "conflict") {
      return renderConfigWithError(
        c,
        "Conflict: this draft was saved by someone else. Reload and re-apply your edit.",
        409,
      );
    }
    if ("error" in result) return renderConfigWithError(c, result.error === "invalid" ? result.issues.join("; ") : "Draft not found.", 400);
    return c.redirect("/config?notice=draft-saved", 302);
  });

  app.post("/config/revisions/:id/activate", (c) => {
    if (!gateOn) return c.redirect("/", 302);
    const actor = configActor(c);
    if (!actor) return configWriteDenied(c);
    const result = ctx.store.configs.activateRevision(Number(c.req.param("id")), actor.login);
    if ("error" in result) return renderConfigWithError(c, result.error, 400);
    return c.redirect("/config?notice=activated", 302);
  });

  app.post("/config/revisions/:id/rollback", (c) => {
    if (!gateOn) return c.redirect("/", 302);
    const actor = configActor(c);
    if (!actor) return configWriteDenied(c);
    const result = ctx.store.configs.rollbackRevision(Number(c.req.param("id")), actor.login);
    if ("error" in result) return renderConfigWithError(c, result.error, 400);
    return c.redirect("/config?notice=rolled-back", 302);
  });

  app.get("/config/export", (c) => {
    if (!gateOn) return c.redirect("/", 302);
    return c.json(ctx.store.configs.exportConfig());
  });

  app.post("/config/import", async (c) => {
    if (!gateOn) return c.redirect("/", 302);
    const actor = configActor(c);
    if (!actor) return configWriteDenied(c);
    const body = await c.req.parseBody();
    const raw = typeof body.payload === "string" ? body.payload : "";
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return renderConfigWithError(c, "Import payload must be valid JSON.", 400);
    }
    const result = ctx.store.configs.importConfig({ payload, actor: actor.login });
    if ("error" in result) return renderConfigWithError(c, result.error, 400);
    return c.redirect("/config?notice=imported", 302);
  });

  // ---- Versioned specialist prompts, fixtures, and evaluation (/config/prompts) ----
  const promptViews = () =>
    ctx.store.prompts.listPromptRevisions().map((revision) => ({
      id: revision.id,
      role_id: revision.role_id,
      status: revision.status,
      body: revision.body,
      note: revision.note,
      created_by: revision.created_by,
      editSeq: revision.edit_seq,
      created_at: revision.created_at,
      updated_at: revision.updated_at,
      activated_at: revision.activated_at,
    }));
  const fixtureViews = () =>
    ctx.store.prompts.listFixtures().map((fixture) => ({
      id: fixture.id,
      name: fixture.name,
      prMeta: JSON.parse(fixture.pr_meta) as Record<string, unknown>,
      diffChars: fixture.diff.length,
      expectations: JSON.parse(fixture.expectations_json ?? "[]") as Array<{
        severity: string;
        category?: string;
        pathContains?: string;
      }>,
      saved_by: fixture.saved_by,
      created_at: fixture.created_at,
    }));
  const evaluationViews = () =>
    ctx.store.prompts.listEvaluations().map((evaluation) => ({
      id: evaluation.id,
      prompt_revision_id: evaluation.prompt_revision_id,
      fixture_id: evaluation.fixture_id,
      model: evaluation.model,
      status: evaluation.status,
      findings: JSON.parse(evaluation.findings_json ?? "[]") as Array<{
        severity?: string;
        category?: string;
        file?: string;
        summary?: string;
      }>,
      usage: evaluation.usage_json ? (JSON.parse(evaluation.usage_json) as { cost?: number; totalTokens?: number }) : null,
      duration_ms: evaluation.duration_ms,
      error: evaluation.error,
      created_at: evaluation.created_at,
    }));

  const promptWriteDenied = (c: Context<AppEnv>) =>
    c.html(
      renderPromptConfigPage({
        revisions: promptViews(),
        fixtures: fixtureViews(),
        evaluations: evaluationViews(),
        canWrite: false,
        error: "Writing prompt configuration requires an operator GitHub OAuth identity.",
      }),
      403,
    );

  const renderPromptError = (c: Context<AppEnv>, message: string, status: 400 | 403 | 409 | 503 = 400) =>
    c.html(
      renderPromptConfigPage({
        revisions: promptViews(),
        fixtures: fixtureViews(),
        evaluations: evaluationViews(),
        canWrite: gateOn,
        error: message,
        csrfToken: gateOn ? ensureCsrfToken(c, ctx.config.uiSessionSecret) : undefined,
      }),
      status,
    );

  app.get("/config/prompts", (c) => {
    if (!gateOn) return c.redirect("/", 302);
    const notices: Record<string, string> = {
      "draft-created": "Prompt draft created.",
      "draft-saved": "Prompt draft saved.",
      activated: "Prompt revision activated.",
      "rolled-back": "Prompt revision rolled back.",
      "fixture-saved": "Fixture saved.",
      evaluated: "Evaluation recorded.",
    };
    return c.html(
      renderPromptConfigPage({
        revisions: promptViews(),
        fixtures: fixtureViews(),
        evaluations: evaluationViews(),
        canWrite: gateOn,
        csrfToken: gateOn ? ensureCsrfToken(c, ctx.config.uiSessionSecret) : undefined,
        notice: notices[c.req.query("notice") ?? ""],
      }),
    );
  });

  app.post("/config/prompts/drafts", async (c) => {
    if (!gateOn) return c.redirect("/", 302);
    const actor = configActor(c);
    if (!actor) return promptWriteDenied(c);
    const body = await c.req.parseBody();
    const result = ctx.store.prompts.createDraft({
      roleId: typeof body.role_id === "string" ? body.role_id.trim() : "",
      body: typeof body.body === "string" ? body.body : "",
      createdBy: actor.login,
    });
    if ("error" in result) return renderPromptError(c, result.issues.join("; "));
    return c.redirect("/config/prompts?notice=draft-created", 302);
  });

  app.post("/config/prompts/drafts/:id", async (c) => {
    if (!gateOn) return c.redirect("/", 302);
    const actor = configActor(c);
    if (!actor) return promptWriteDenied(c);
    const body = await c.req.parseBody();
    const result = ctx.store.prompts.updatePromptDraft({
      id: Number(c.req.param("id")),
      body: typeof body.body === "string" ? body.body : "",
      expectedEditSeq: Number(body.expected_edit_seq ?? -1),
      updatedBy: actor.login,
    });
    if ("error" in result && result.error === "conflict") {
      return renderPromptError(c, "Conflict: this draft was saved by someone else. Reload and re-apply your edit.", 409);
    }
    if ("error" in result) {
      return renderPromptError(c, result.error === "invalid" ? result.issues.join("; ") : "Prompt draft not found.", 400);
    }
    return c.redirect("/config/prompts?notice=draft-saved", 302);
  });

  app.post("/config/prompts/:id/activate", (c) => {
    if (!gateOn) return c.redirect("/", 302);
    const actor = configActor(c);
    if (!actor) return promptWriteDenied(c);
    const result = ctx.store.prompts.activatePromptRevision(Number(c.req.param("id")), actor.login);
    if ("error" in result) return renderPromptError(c, result.error, 400);
    return c.redirect("/config/prompts?notice=activated", 302);
  });

  app.post("/config/prompts/:id/rollback", (c) => {
    if (!gateOn) return c.redirect("/", 302);
    const actor = configActor(c);
    if (!actor) return promptWriteDenied(c);
    const result = ctx.store.prompts.rollbackPromptRevision(Number(c.req.param("id")), actor.login);
    if ("error" in result) return renderPromptError(c, result.error, 400);
    return c.redirect("/config/prompts?notice=rolled-back", 302);
  });

  app.post("/config/prompts/fixtures", async (c) => {
    if (!gateOn) return c.redirect("/", 302);
    const actor = configActor(c);
    if (!actor) return promptWriteDenied(c);
    const body = await c.req.parseBody();
    let prMeta: Record<string, unknown> = {};
    try {
      prMeta = JSON.parse(typeof body.pr_meta === "string" && body.pr_meta ? body.pr_meta : "{}");
    } catch {
      return renderPromptError(c, "Fixture PR metadata must be valid JSON.", 400);
    }
    const result = ctx.store.prompts.saveFixture({
      name: typeof body.name === "string" ? body.name : "",
      prMeta,
      diff: typeof body.diff === "string" ? body.diff : "",
      savedBy: actor.login,
      acknowledged: body.acknowledged === "on" || body.acknowledged === "true",
    });
    if ("error" in result) return renderPromptError(c, result.issues.join("; "), 400);
    return c.redirect("/config/prompts?notice=fixture-saved", 302);
  });

  app.post("/config/prompts/evaluate", async (c) => {
    if (!gateOn) return c.redirect("/", 302);
    const actor = configActor(c);
    if (!actor) return promptWriteDenied(c);
    if (!ctx.opencode) return renderPromptError(c, "Prompt evaluation is unavailable on this process (no OpenCode runner).", 503);
    const body = await c.req.parseBody();
    const promptRevisionId = Number(body.prompt_revision_id);
    const fixtureId = Number(body.fixture_id);
    const maxCostUsd = typeof body.max_cost_usd === "string" && body.max_cost_usd ? Number(body.max_cost_usd) : undefined;
    if (!Number.isFinite(promptRevisionId) || !Number.isFinite(fixtureId)) {
      return renderPromptError(c, "Prompt revision and fixture must be numeric ids.", 400);
    }
    if (maxCostUsd !== undefined && !Number.isFinite(maxCostUsd)) {
      return renderPromptError(c, "Max cost must be a number.", 400);
    }
    let expectations: Array<{ severity: string; category?: string; pathContains?: string }> = [];
    try {
      expectations = JSON.parse(typeof body.expectations === "string" && body.expectations ? body.expectations : "[]");
    } catch {
      return renderPromptError(c, "Expectations must be valid JSON.", 400);
    }
    void expectations; // stored on the fixture; evaluation compares against fixture.expectations
    const result = await ctx.store.prompts.evaluatePrompt({
      promptRevisionId,
      fixtureId,
      model: typeof body.model === "string" && body.model ? body.model : ctx.config.opencode.reviewerModel,
      maxCostUsd,
      actor: actor.login,
      opencode: ctx.opencode,
      extraArgs: ctx.config.opencode.extraArgs,
    });
    if ("error" in result) return renderPromptError(c, result.error, 400);
    if (result.evaluation.status === "failed") {
      return renderPromptError(c, `Evaluation failed: ${result.evaluation.error ?? "unknown error"}`, 400);
    }
    return c.redirect(`/config/prompts?notice=evaluated`, 302);
  });

  const scanPageData = (c: Context<AppEnv>, extra: Pick<ScanPageData, "error"> = {}): ScanPageData => {
    const profileRevision = ctx.store.configs.getActiveRevision("default");
    const recentScans = ctx.store
      .listJobs(75)
      .filter((job) => job.job_type === "health_scan" && job.state === "completed")
      .slice(0, 8)
      .map((job) => ({ id: job.id, repoFullName: job.repo_full_name, headSha: job.head_sha }));
    return {
      canScan: Boolean(c.get("identity")),
      identity: c.get("identity"),
      csrfToken: gateOn ? ensureCsrfToken(c, ctx.config.uiSessionSecret) : undefined,
      issueCreationEnabled: ctx.config.issueCreationEnabled,
      profileRevision: profileRevision ? { id: profileRevision.id, name: profileRevision.name } : null,
      recentScans,
      ...extra,
    };
  };
  const renderScanDenied = (c: Context<AppEnv>, message: string) =>
    c.html(renderScanPage(scanPageData(c, { error: message })), 403);

  /** Selection state for the issue-creation form on a completed scan's job page. */
  const scanIssueCreationData = (job: JobRow): ScanIssueCreationData | undefined => {
    if (job.job_type !== "health_scan" || job.state !== "completed") return undefined;
    const findings = scanOpenFindings(ctx.store, job).map((entry) => ({
      fingerprint: entry.row.fingerprint,
      summary: entry.row.summary,
      severity: entry.row.severity ?? "info",
      confidence: entry.row.confidence,
      agreed: entry.agreed,
      worthy: entry.worth.worthy,
      unworthyReason: entry.worth.worthy ? undefined : entry.worth.reason,
    }));
    const enabled =
      ctx.config.issueCreationEnabled &&
      Boolean(ctx.github && isReviewGithub(ctx.github) && ctx.github.createIssue && ctx.github.listOpenIssuesByMarker);
    return { enabled, jobId: job.id, findings };
  };

  // ---- On-demand repository health scans (/scan) ----
  const parseRepoInput = (raw: string): { owner: string; repo: string } | undefined => {
    const trimmed = raw.trim();
    const short = trimmed.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (short) return { owner: short[1], repo: short[2].replace(/\.git$/, "") };
    try {
      const url = new URL(trimmed);
      if (url.hostname !== "github.com") return undefined;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length < 2) return undefined;
      return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
    } catch {
      return undefined;
    }
  };

  app.get("/scan", (c) => {
    if (!gateOn) return c.redirect("/", 302);
    return c.html(renderScanPage(scanPageData(c)));
  });

  app.post("/scan", async (c) => {
    if (!gateOn) return c.redirect("/", 302);
    const actor = configActor(c);
    if (!actor) {
      return c.html(
        renderScanPage(scanPageData(c, { error: "Scanning requires an operator GitHub OAuth identity." })),
        403,
      );
    }
    if (!ctx.github || !isReviewGithub(ctx.github)) {
      return c.html(
        renderScanPage(scanPageData(c, { error: "GitHub App client is not configured on this process." })),
        503,
      );
    }
    const body = await c.req.parseBody();
    const parsed = parseRepoInput(typeof body.repo === "string" ? body.repo : "");
    if (!parsed) {
      return c.html(
        renderScanPage(scanPageData(c, { error: "Enter a repository as owner/repo or a GitHub URL." })),
        400,
      );
    }
    try {
      const installation = await ctx.github.getRepoInstallation(parsed.owner, parsed.repo);
      const accountAuth = authorizeGithubAccount(ctx.config, {
        installationId: installation.installationId,
        accountId: installation.accountId,
      });
      if (!accountAuth.ok) {
        logAuthorizationRejection({ installationId: installation.installationId, reason: accountAuth.reason });
        return renderScanDenied(c, "Not authorized to scan this installation or repository.");
      }
      const repository = await ctx.github.getRepository(parsed.owner, parsed.repo, installation.installationId);
      const repoAuth = rejectUnauthorized(ctx.config, {
        installationId: installation.installationId,
        accountId: installation.accountId,
        repositoryId: repository.id,
      });
      if (!repoAuth.ok) {
        return renderScanDenied(c, "Not authorized to scan this installation or repository.");
      }
      // The rate limiter and the job row both key on this id; a malformed one must not
      // fall through and masquerade as a rate limit (or as an unkeyed job).
      if (!Number.isSafeInteger(repository.id) || repository.id <= 0) {
        return c.html(
          renderScanPage(scanPageData(c, { error: "Could not resolve a valid repository id for this scan." })),
          502,
        );
      }
      if (!ctx.github.getRepositoryHead || !ctx.github.getCommitDiff) {
        return renderScanDenied(c, "This GitHub client does not support repository scans.");
      }
      const head = await ctx.github.getRepositoryHead(installation.installationId, parsed.owner, parsed.repo);

      // Same per-repository budget as manual PR reviews (and webhook reviews).
      // Previewing a confirmation must not consume budget, so the check is a
      // wouldAllow probe; the hit is recorded only when a job is actually created
      // (duplicate no-ops don't count).
      const rateOn = repoRateLimitActive(ctx.config.repoRateLimitPerWindow, ctx.config.repoRateWindowMs);
      if (
        rateOn &&
        !rateLimiter.wouldAllow(repository.id, ctx.config.repoRateLimitPerWindow, ctx.config.repoRateWindowMs)
      ) {
        logRateLimited({ installationId: installation.installationId, repositoryId: repository.id });
        return c.html(
          renderScanPage(scanPageData(c, { error: "Rate limited for this repository; try again later." })),
          429,
        );
      }

      // Two-step start: the operator first sees the exact revision, then confirms it.
      // An all-empty confirmation payload means the POST came from the step-1 form
      // (repo only) — a preview, not a failed confirmation. A confirming POST is
      // valid only for what the operator was shown: revision id, sha, and branch must
      // all match the freshly resolved head. Any mismatch re-renders the confirmation
      // with current values and a notice; no job is enqueued from a confirmation
      // that fails this check.
      const confirmedSha = typeof body.sha === "string" ? body.sha.trim() : "";
      const confirmedBranch = typeof body.branch === "string" ? body.branch.trim() : "";
      const confirmedRevision = typeof body.revision_id === "string" ? body.revision_id.trim() : "";
      const activeRevision = ctx.store.configs.getActiveRevision("default");
      const shaConfirmed = confirmedSha === head.headSha;
      const branchConfirmed = confirmedBranch === head.defaultBranch;
      const revisionConfirmed = confirmedRevision === (activeRevision ? String(activeRevision.id) : "");
      if (!shaConfirmed || !branchConfirmed || !revisionConfirmed) {
        const notice: ScanConfirmNotice | undefined =
          confirmedSha === "" && confirmedBranch === "" && confirmedRevision === ""
            ? undefined
            : confirmedSha !== "" && confirmedSha !== head.headSha
              ? { kind: "sha", fromSha: confirmedSha }
              : confirmedBranch !== "" && confirmedBranch !== head.defaultBranch
                ? { kind: "branch", fromBranch: confirmedBranch }
                : !revisionConfirmed
                  ? { kind: "revision" }
                  : { kind: "incomplete" };
        return c.html(
          renderScanConfirmPage({
            identity: c.get("identity"),
            csrfToken: ensureCsrfToken(c, ctx.config.uiSessionSecret),
            repo: `${parsed.owner}/${parsed.repo}`,
            branch: head.defaultBranch,
            sha: head.headSha,
            profileRevision: activeRevision ? { id: activeRevision.id, name: activeRevision.name } : null,
            severityFloor: activeRevision?.definition.minPublishableSeverity ?? "info",
            limits: {
              diffCapBytes: ctx.config.maxDiffBytes > 0 ? ctx.config.maxDiffBytes : null,
              reviewerTimeoutMs: ctx.config.opencode.timeoutMs,
              maxRetries: ctx.config.opencode.maxRetries,
            },
            notice,
          }),
        );
      }

      const created = ctx.store.enqueue({
        repoFullName: `${parsed.owner}/${parsed.repo}`,
        repoOwner: parsed.owner,
        repoName: parsed.repo,
        installationId: installation.installationId,
        githubAccountId: installation.accountId,
        githubRepositoryId: repository.id,
        prNumber: 0,
        prTitle: `Repository health scan (${head.defaultBranch})`,
        prBody: `Manual health scan of the default branch (${head.defaultBranch}) at a pinned SHA.`,
        prHtmlUrl: `https://github.com/${parsed.owner}/${parsed.repo}`,
        prAuthor: actor.login,
        baseSha: head.headSha,
        headSha: head.headSha,
        baseRef: head.defaultBranch,
        headRef: head.defaultBranch,
        webhookEvent: "manual.scan",
        jobType: "health_scan",
        scanBranch: head.defaultBranch,
        // Exactly the revision the operator confirmed, not whatever is active now.
        profileRevisionId: activeRevision?.id,
        reviewers: [],
      });
      if (created.created && rateOn) {
        rateLimiter.record(repository.id, ctx.config.repoRateLimitPerWindow, ctx.config.repoRateWindowMs);
      }
      ctx.store.log(created.job.id, `Health scan enqueued by ${actor.login} for ${head.defaultBranch} @ ${head.headSha}`);
      dispatchEnqueue(ctx.queue, created);
      return c.redirect(`/jobs/${created.job.id}?notice=${created.created ? "scan-queued" : "exists"}`, 302);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`scan: could not start scan for ${parsed.owner}/${parsed.repo}: ${message}`);
      return c.html(renderScanPage(scanPageData(c, { error: message })), 400);
    }
  });

  type ScanIssuePort = ManualTriggerPort & {
    createIssue: NonNullable<GithubPort["createIssue"]>;
    listOpenIssuesByMarker: NonNullable<GithubPort["listOpenIssuesByMarker"]>;
    searchOpenIssues?: NonNullable<GithubPort["searchOpenIssues"]>;
  };
  // Shared preconditions for previewing and publishing scan issues: operator
  // identity, enabled capability, a capable GitHub client, a completed scan
  // job, and allowlists re-checked at write time (they may have changed since
  // the scan ran).
  const scanIssueGuard = async (
    c: Context<AppEnv>,
  ): Promise<{ actor: { login: string }; job: JobRow; port: ScanIssuePort } | { failure: Response }> => {
    const actor = configActor(c);
    if (!actor) {
      return {
        failure: c.html(
          renderScanPage(scanPageData(c, { error: "Creating issues requires an operator GitHub OAuth identity." })),
          403,
        ),
      };
    }
    if (!ctx.config.issueCreationEnabled) {
      return {
        failure: c.html(
          renderScanPage(scanPageData(c, { error: "Issue creation is disabled (GITHUB_ISSUE_CREATION_ENABLED=false)." })),
          403,
        ),
      };
    }
    if (!ctx.github || !isReviewGithub(ctx.github)) {
      return { failure: renderScanDenied(c, "GitHub App client is not configured on this process.") };
    }
    const github = ctx.github;
    if (!github.createIssue || !github.listOpenIssuesByMarker) {
      return { failure: renderScanDenied(c, "This GitHub client does not support issue creation.") };
    }
    const body = await c.req.parseBody();
    const jobId = Number(body.job_id);
    const job = Number.isFinite(jobId) ? ctx.store.getJob(jobId) : undefined;
    if (!job || job.job_type !== "health_scan" || job.state !== "completed") {
      return { failure: renderScanDenied(c, "Issue creation requires a completed health-scan job.") };
    }
    const writeAuth = authorizeGithubTarget(ctx.config, {
      installationId: job.installation_id,
      accountId: job.github_account_id ?? undefined,
      repositoryId: job.github_repository_id ?? undefined,
    });
    if (!writeAuth.ok) {
      logAuthorizationRejection({ installationId: job.installation_id, reason: writeAuth.reason });
      return { failure: renderScanDenied(c, "Not authorized to create issues in this installation or repository.") };
    }
    return { actor, job, port: github as ScanIssuePort };
  };

  app.post("/scan/issues/preview", async (c) => {
    const guard = await scanIssueGuard(c);
    if ("failure" in guard) return guard.failure;
    const { job, port } = guard;
    const body = await c.req.parseBody();
    const fingerprints = fingerprintList(body["fp[]"]);
    if (fingerprints.length === 0) {
      return renderScanDenied(c, "Select at least one finding to preview.");
    }
    const selection = scanIssueSelection(ctx.store, job, fingerprints);
    if (selection.unknown.length > 0) {
      return renderScanDenied(c, `${selection.unknown.length} selected finding(s) do not belong to this scan.`);
    }
    const rejected: string[] = [];
    const items: ScanIssuePreviewItem[] = [];
    for (const entry of selection.selected) {
      if (!entry.worth.worthy) {
        rejected.push(`${entry.row.summary || entry.row.fingerprint}: ${entry.worth.reason}`);
        continue;
      }
      const markerBase = scanIssueMarkerBase(entry.row.fingerprint);
      const { title, body: issueBody } = buildScanIssue(ctx.config, job, entry.row);
      let skip: { reason: string; url?: string } | undefined;
      // Repo-scoped on purpose: an issue recorded by an earlier scan of the same
      // repository still tracks this fingerprint. issue_number 0 = pending claim.
      const local = ctx.store.getScanIssue(job.repo_full_name, entry.row.fingerprint);
      if (local) {
        skip = {
          reason: local.issue_number === 0 ? "a publication claim for this finding is already in flight" : "a Maomao issue already tracks this finding",
          url: local.issue_url || undefined,
        };
      }
      let dedupCheckFailed = false;
      try {
        const remote = await port.listOpenIssuesByMarker(job.installation_id, job.repo_owner, job.repo_name, `${markerBase} `);
        if (!skip && remote.length > 0) {
          skip = { reason: "an existing Maomao issue already tracks this finding", url: remote[0]?.url };
        }
      } catch (error) {
        dedupCheckFailed = true;
        ctx.store.log(job.id, `Remote dedup check failed for ${entry.row.fingerprint}: ${error instanceof Error ? error.message : String(error)}`, "warn");
      }
      // Best-effort surfacing of likely human-authored duplicates; the operator
      // reviews them, Maomao never modifies them, and a failed search blocks nothing.
      let duplicates: Array<{ number: number; title: string; url: string }> = [];
      const query = duplicateSearchQuery(entry.row.summary ?? "");
      if (port.searchOpenIssues && !skip && query) {
        try {
          duplicates = await port.searchOpenIssues(job.installation_id, job.repo_owner, job.repo_name, query);
        } catch (error) {
          ctx.store.log(job.id, `Duplicate search failed for ${entry.row.fingerprint}: ${error instanceof Error ? error.message : String(error)}`, "warn");
        }
      }
      items.push({
        fingerprint: entry.row.fingerprint,
        severity: entry.row.severity ?? "info",
        title,
        body: issueBody,
        agreed: entry.agreed,
        skip,
        dedupCheckFailed,
        duplicates: Array.isArray(duplicates) ? duplicates : [],
      });
    }
    if (items.length === 0) {
      return renderScanDenied(c, `No selected finding passes the publication bar. ${rejected.join(" ")}`);
    }
    return c.html(
      renderScanIssuePreviewPage({
        identity: c.get("identity"),
        csrfToken: ensureCsrfToken(c, ctx.config.uiSessionSecret),
        job: { id: job.id, repoFullName: job.repo_full_name, headSha: job.head_sha },
        items,
        rejected,
      }),
    );
  });

  app.post("/scan/issues", async (c) => {
    const guard = await scanIssueGuard(c);
    if ("failure" in guard) return guard.failure;
    const { actor, job, port } = guard;
    const body = await c.req.parseBody();
    const fingerprints = fingerprintList(body["fp[]"]);
    if (fingerprints.length === 0) {
      return renderScanDenied(c, "Select at least one finding to create issues for.");
    }
    const selection = scanIssueSelection(ctx.store, job, fingerprints);
    if (selection.unknown.length > 0) {
      return renderScanDenied(c, `${selection.unknown.length} selected finding(s) do not belong to this scan.`);
    }
    // The publication bar is re-verified here so a crafted POST cannot publish
    // speculative findings by skipping the preview.
    const creatable = selection.selected.filter((entry) => entry.worth.worthy);
    if (creatable.length === 0) {
      return renderScanDenied(c, "No selected finding passes the publication bar (confidence and specialist consensus).");
    }
    const droppedReasons = selection.selected.flatMap((entry) => (entry.worth.worthy ? [] : [entry.worth.reason]));
    if (droppedReasons.length > 0) {
      ctx.store.log(
        job.id,
        `Skipped ${droppedReasons.length} selected finding(s) below the publication bar: ${droppedReasons.join("; ")}`,
        "warn",
      );
    }
    let createdCount = 0;
    let skipped = 0;
    let failed = 0;
    let permissionDenied = false;
    for (const entry of creatable) {
      const finding = entry.row;
      const markerBase = scanIssueMarkerBase(finding.fingerprint);
      try {
        const existingLocal = ctx.store.hasScanIssue(job.repo_full_name, finding.fingerprint);
        if (existingLocal) {
          skipped += 1;
          continue;
        }
        // Atomic claim: a concurrent submit loses the race and counts as skipped.
        const claimed = ctx.store.claimScanIssue({
          jobId: job.id,
          repoFullName: job.repo_full_name,
          fingerprint: finding.fingerprint,
          title: finding.summary ?? finding.fingerprint,
        });
        if (!claimed) {
          skipped += 1;
          continue;
        }
        const remote = await port.listOpenIssuesByMarker(job.installation_id, job.repo_owner, job.repo_name, `${markerBase} `);
        if (remote.length > 0) {
          ctx.store.recordScanIssue({
            jobId: job.id,
            repoFullName: job.repo_full_name,
            fingerprint: finding.fingerprint,
            issueNumber: remote[0].number,
            issueUrl: remote[0].url,
            title: `maomao: ${finding.summary ?? finding.fingerprint}`,
          });
          ctx.store.log(
            job.id,
            `Linked existing issue #${remote[0].number} (${remote[0].url}) to finding ${finding.fingerprint}`,
          );
          skipped += 1;
          continue;
        }
        const { title, body: issueBody } = buildScanIssue(ctx.config, job, finding);
        const issue = await port.createIssue(job.installation_id, job.repo_owner, job.repo_name, title, issueBody);
        try {
          ctx.store.recordScanIssue({
            jobId: job.id,
            repoFullName: job.repo_full_name,
            fingerprint: finding.fingerprint,
            issueNumber: issue.number,
            issueUrl: issue.url,
            title,
          });
        } catch (recordError) {
          // The issue exists on GitHub; never report it as a failed creation.
          ctx.store.log(
            job.id,
            `Issue #${issue.number} created (${issue.url}) but provenance recording failed: ${recordError instanceof Error ? recordError.message : String(recordError)} — verify before retrying.`,
            "warn",
          );
        }
        // Credential-free audit trail: actor is in the summary line below, and
        // each created issue is tied to its finding fingerprint here.
        ctx.store.log(job.id, `Created issue #${issue.number} (${issue.url}) for finding ${finding.fingerprint}`);
        createdCount += 1;
      } catch (error) {
        failed += 1;
        // Release the claim so a later retry can try this finding again. Cleanup
        // must not throw out of the handler: an orphaned pending claim would
        // make every future attempt see this finding as already tracked.
        try {
          ctx.store.clearScanIssue(job.repo_full_name, finding.fingerprint);
        } catch (cleanupError) {
          ctx.store.log(
            job.id,
            `Could not release the pending claim for ${finding.fingerprint}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            "error",
          );
        }
        if (isPermissionDenied(error)) {
          permissionDenied = true;
          ctx.store.log(
            job.id,
            `Issue creation stopped: GitHub refused the write (status ${String((error as { status?: unknown }).status)}): ${error instanceof Error ? error.message : String(error)} — the App installation likely lacks the "Issues: write" permission. Grant it, then retry; already-created issues are skipped.`,
            "warn",
          );
          break;
        }
        ctx.store.log(job.id, `Issue creation failed for ${finding.fingerprint}: ${error instanceof Error ? error.message : String(error)}`, "warn");
      }
    }
    const notAttempted = permissionDenied ? creatable.length - (createdCount + skipped + failed) : 0;
    ctx.store.log(
      job.id,
      `Issue creation by ${actor.login}: ${createdCount} created, ${skipped} skipped (already present), ${failed} failed${notAttempted > 0 ? `, ${notAttempted} not attempted` : ""}`,
    );
    if (permissionDenied) {
      return c.redirect(`/jobs/${job.id}?notice=issues-permission`, 302);
    }
    if (failed > 0) {
      return c.redirect(`/jobs/${job.id}?notice=issues-partial:${failed}`, 302);
    }
    if (createdCount === 0) {
      return c.redirect(`/jobs/${job.id}?notice=issues-none:${skipped}`, 302);
    }
    return c.redirect(`/jobs/${job.id}?notice=issues-created`, 302);
  });

  type ScanRepoOption = { fullName: string; installationId: number; repositoryId: number; accountId: number | null };
  const SCAN_REPO_CACHE_TTL_MS = 5 * 60 * 1000;
  let scanRepoCache: { at: number; options: ScanRepoOption[] } | null = null;
  let scanRepoInflight: Promise<ScanRepoOption[]> | null = null;

  const enumerateScanRepos = async (): Promise<ScanRepoOption[]> => {
    const github = ctx.github;
    if (!github || !github.listAppInstallations || !github.listInstallationRepositories) {
      throw new Error("this GitHub client does not support repository search");
    }
    const options: ScanRepoOption[] = [];
    const installations = await github.listAppInstallations();
    for (const installation of installations) {
      const subject = {
        installationId: installation.id,
        accountId: installation.accountId,
      };
      if (!authorizeGithubAccount(ctx.config, subject).ok) continue;
      try {
        const repos = await github.listInstallationRepositories(installation.id);
        for (const repo of repos) {
          if (!authorizeGithubRepository(ctx.config, { ...subject, repositoryId: repo.id }).ok) continue;
          options.push({
            fullName: repo.fullName,
            installationId: installation.id,
            repositoryId: repo.id,
            accountId: installation.accountId,
          });
        }
      } catch (error) {
        console.warn(
          `scan: could not list repositories for installation ${installation.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return options.sort((a, b) => a.fullName.localeCompare(b.fullName)).slice(0, 500);
  };

  // Allowlist-filtered installation repositories for the scan-page typeahead.
  // Enumeration is cached: installations×repos is expensive and the allowlists
  // change rarely; the confirm step re-validates against live allowlists anyway.
  // Empty results are NOT cached — a transient outage would otherwise pin an
  // empty suggestion list for the full TTL. Concurrent cold-cache requests share
  // one in-flight enumeration instead of stampeding GitHub.
  app.get("/api/scan/repositories", async (c) => {
    if (!c.get("identity")) {
      return c.json({ error: "repository search requires an operator GitHub OAuth identity" }, 403);
    }
    if (!ctx.github || !ctx.github.listAppInstallations || !ctx.github.listInstallationRepositories) {
      return c.json({ error: "this GitHub client does not support repository search" }, 503);
    }
    const now = Date.now();
    if (!scanRepoCache || now - scanRepoCache.at > SCAN_REPO_CACHE_TTL_MS) {
      scanRepoCache = null;
      if (!scanRepoInflight) {
        scanRepoInflight = enumerateScanRepos().finally(() => {
          scanRepoInflight = null;
        });
      }
      try {
        const options = await scanRepoInflight;
        if (options.length > 0) scanRepoCache = { at: now, options };
      } catch (error) {
        console.warn(`scan: repository enumeration failed: ${error instanceof Error ? error.message : String(error)}`);
        return c.json({ error: "could not enumerate installation repositories" }, 502);
      }
    }
    return c.json({ repositories: scanRepoCache?.options ?? [] });
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

/**
 * Parses home-queue pagination cursors. Malformed, zero, negative, or
 * beyond-MAX_SAFE_INTEGER values are dropped (caller renders the first page)
 * — pagination input must never 500. Well-formed but out-of-range cursors
 * pass through untouched: the store's exclusive `id <` query already serves
 * the newest page for a before cursor above the newest id, and the GET /
 * route re-renders the first page if a cursor would otherwise show an empty
 * list.
 */
function jobsPageCursor(beforeRaw: string | undefined, afterRaw: string | undefined): { before?: number; after?: number } {
  const parse = (raw: string | undefined): number | undefined => {
    if (!raw || !/^-?\d+$/.test(raw.trim())) return undefined;
    const value = Number(raw.trim());
    if (!Number.isSafeInteger(value) || value <= 0) return undefined;
    return value;
  };
  const before = parse(beforeRaw);
  const after = parse(afterRaw);
  // before wins when both are present (links only ever carry one).
  if (before != null) return { before };
  if (after != null) return { after };
  return {};
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
  if (code === "scan-queued") {
    return "Health scan queued for the pinned default-branch head SHA.";
  }
  if (code === "issues-created") {
    return "GitHub issues created for the selected findings (deduplicated).";
  }
  if (code === "issues-permission") {
    return "Issue creation stopped: GitHub refused the write — the App installation likely lacks the Issues: write permission. Grant it, then retry; already-created issues are skipped.";
  }
  if (code?.startsWith("issues-none")) {
    return `No new issues created: ${code.split(":")[1] ?? "0"} finding(s) already tracked or publication-claimed.`;
  }
  if (code?.startsWith("issues-partial")) {
    return `Some issues could not be created (${code.split(":")[1] ?? "unknown"} failures). Retrying is safe: already-created issues are skipped.`;
  }
  if (code === "exists") {
    return "A job already exists for this repository, pull request, and head SHA.";
  }
  if (code === "retry") {
    return "Re-queued failed reviewer(s) for this head SHA.";
  }
  if (code === "dequeued") {
    return "Job dequeued. It will not run; history and logs are preserved. Nothing was posted to GitHub.";
  }
  if (code === "dequeue-already") {
    return "This job was already dequeued.";
  }
  if (code === "cancelled-review") {
    return "Review cancelled. Work stops at the next checkpoint and the review will not be completed; if a review already reached GitHub it is linked from the job page.";
  }
  if (code === "cancel-already") {
    return "This job was already cancelled.";
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

function retryJob(c: Context<AppEnv>, ctx: ServerContext, pageOpts: PageOptions, jobId: number, runId?: number) {
  const job = ctx.store.getJob(jobId);
  if (!job) return c.text("Not found", 404);
  const result = ctx.store.retryFailedReviewers(jobId, runId);
  if (!result.ok) {
    return renderJobError(c, ctx, pageOpts, job, result.error);
  }
  ctx.queue.enqueue(jobId);
  return c.redirect(`/jobs/${jobId}?notice=retry`, 302);
}

/**
 * Operator attribution for manual queue actions. Password-gate sessions (and
 * an open UI) have no identity: persist null and let the copy layer say
 * "an operator" rather than writing a plausible-looking login into the audit.
 */
function actionActor(c: Context<AppEnv>): string | undefined {
  return c.get("identity")?.login;
}

function renderJobError(
  c: Context<AppEnv>,
  ctx: ServerContext,
  pageOpts: PageOptions,
  job: JobRow,
  error: string,
) {
  const latest = ctx.store.findLatestJobForPull(job.repo_full_name, job.pr_number);
  return c.html(
    renderJob(job, ctx.store.listReviewerRuns(job.id), ctx.store.listLogs(job.id), {
      ...pageOpts,
      identity: c.get("identity"),
      csrfToken: pageOpts.showLogout ? ensureCsrfToken(c, ctx.config.uiSessionSecret) : undefined,
      prHeadSha: latest?.head_sha ?? job.head_sha,
      error,
      prFindings: ctx.store.listFindings(job.repo_full_name, job.pr_number),
    }),
    400,
  );
}

/**
 * Removes a queued job through the shared cancellation service: atomic,
 * idempotent, history preserved, and nothing is posted to GitHub.
 */
function dequeueJob(c: Context<AppEnv>, ctx: ServerContext, pageOpts: PageOptions, jobId: number) {
  const job = ctx.store.getJob(jobId);
  if (!job) return c.text("Not found", 404);
  if (job.state !== "queued") {
    // Repeated clicks and stale UI submissions are idempotent, not errors.
    if (job.state === "cancelled" && job.cancelled_reason === "manual_dequeue") {
      return c.redirect(`/jobs/${jobId}?notice=dequeue-already`, 302);
    }
    return renderJobError(c, ctx, pageOpts, job, `Only queued jobs can be dequeued; this one is ${job.state}.`);
  }
  const result = cancelJob(ctx.store, jobId, {
    reason: "manual_dequeue",
    actor: actionActor(c),
    onCancelled: (ids) => ctx.queue.abortMany(ids),
  });
  if (!result.ok) {
    return renderJobError(c, ctx, pageOpts, job, result.error);
  }
  return c.redirect(`/jobs/${jobId}?notice=${result.already ? "dequeue-already" : "dequeued"}`, 302);
}

function renderCancelConfirm(c: Context<AppEnv>, ctx: ServerContext, pageOpts: PageOptions, jobId: number) {
  const job = ctx.store.getJob(jobId);
  if (!job) return c.text("Not found", 404);
  if (!LIVE_JOB_STATES.includes(job.state)) {
    // The click must not just disappear: tell the operator why there is no form.
    const error =
      job.state === "queued"
        ? "This job is queued, not running — use Dequeue to remove it."
        : `This job is no longer running (${job.state}); there is nothing to cancel.`;
    return c.redirect(`/jobs/${jobId}?error=${encodeURIComponent(error)}`, 302);
  }
  return c.html(
    renderCancelConfirmPage({
      identity: c.get("identity"),
      csrfToken: pageOpts.showLogout ? ensureCsrfToken(c, ctx.config.uiSessionSecret) : undefined,
      showLogout: pageOpts.showLogout,
      job: {
        id: job.id,
        repoFullName: job.repo_full_name,
        prNumber: job.pr_number,
        prTitle: job.pr_title,
        headSha: job.head_sha,
        jobType: job.job_type,
      },
    }),
  );
}

function cancelRunningJob(c: Context<AppEnv>, ctx: ServerContext, pageOpts: PageOptions, jobId: number) {
  const job = ctx.store.getJob(jobId);
  if (!job) return c.text("Not found", 404);
  // A resubmission against an already-cancelled job is idempotent, not an
  // error — whatever cancelled it (this route, the merge webhook, a dequeue).
  if (job.state === "cancelled") {
    return c.redirect(`/jobs/${jobId}?notice=cancel-already`, 302);
  }
  if (!LIVE_JOB_STATES.includes(job.state)) {
    return renderJobError(
      c,
      ctx,
      pageOpts,
      job,
      `Only running reviews can be cancelled this way; this one is ${job.state}.`,
    );
  }
  const result = cancelJob(ctx.store, jobId, {
    reason: "manual_cancel",
    actor: actionActor(c),
    onCancelled: (ids) => ctx.queue.abortMany(ids),
  });
  if (!result.ok) {
    return renderJobError(c, ctx, pageOpts, job, result.error);
  }
  return c.redirect(`/jobs/${jobId}?notice=cancelled-review`, 302);
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
