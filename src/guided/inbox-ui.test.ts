import { describe, expect, it } from "vitest";
import { CSRF_COOKIE, SESSION_COOKIE, issueCsrfToken, signOAuthSession, signSession } from "../auth.js";
import { loadConfig } from "../config.js";
import { openDb } from "../db.js";
import type { GithubPort, ManualTriggerPort, ResolvedPull } from "../github/client.js";
import type { JobQueue } from "../jobs/queue.js";
import { JobStore } from "../jobs/store.js";
import { createApp } from "../server.js";
import { GuidedWalkthroughStore } from "./walkthrough-store.js";

const secret = "guided-inbox-test-secret";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

function pull(overrides: Partial<ResolvedPull> = {}): ResolvedPull {
  return {
    installationId: 10,
    accountId: 100,
    repositoryId: 200,
    repoOwner: "acme",
    repoName: "widgets",
    repoFullName: "acme/widgets",
    prNumber: 12,
    prTitle: "Add guided review target",
    prBody: "",
    prHtmlUrl: "https://github.com/acme/widgets/pull/12",
    prAuthor: "octocat",
    baseSha,
    headSha,
    baseRef: "main",
    headRef: "feature",
    draft: false,
    state: "open",
    updatedAt: "2026-11-27T10:00:00Z",
    requestedReviewers: ["reviewer"],
    ...overrides,
  };
}

function githubFake(currentPull = pull()): ManualTriggerPort & Partial<GithubPort> {
  return {
    async getRepoInstallation() {
      return { installationId: 10, accountId: 100 };
    },
    async getRepository() {
      return { id: 200 };
    },
    async getPull() {
      return currentPull;
    },
    async listAppInstallations() {
      return [{ id: 10, accountId: 100 }];
    },
    async listInstallationRepositories() {
      return [{ id: 200, fullName: "acme/widgets" }];
    },
    async listOpenPulls() {
      return [currentPull];
    },
    async getFileContent() {
      return "export const surrounding = true;\n";
    },
    async getCompareDiff() {
      return `diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1,2 +1,2 @@\n const safe = 1;\n-oldLine();\n+newLine();\n`;
    },
  };
}


function seedInbox(store: JobStore, currentPull = pull()): void {
  store.upsertGuidedInboxPull({
    installationId: currentPull.installationId,
    githubAccountId: currentPull.accountId,
    githubRepositoryId: currentPull.repositoryId,
    repoFullName: currentPull.repoFullName,
    prNumber: currentPull.prNumber,
    prTitle: currentPull.prTitle,
    prHtmlUrl: currentPull.prHtmlUrl,
    prAuthor: currentPull.prAuthor,
    baseSha: currentPull.baseSha,
    headSha: currentPull.headSha,
    draft: currentPull.draft,
    state: currentPull.state ?? "open",
    pullUpdatedAt: currentPull.updatedAt,
    reviewRequested: currentPull.requestedReviewers === undefined ? undefined : currentPull.requestedReviewers.length > 0,
  });
}

function testApp(github?: ManualTriggerPort & Partial<GithubPort>, env: Record<string, string> = {}, contextExtras: Partial<Parameters<typeof createApp>[0]> = {}) {
  const config = loadConfig({
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "k",
    REVIEWER_ROLES: "correctness",
    UI_PASSWORD: "hunter2",
    UI_SESSION_SECRET: secret,
    MAOMAO_ADMIN_GITHUB_IDS: "1001,2002",
    ...env,
  });
  const db = openDb(":memory:");
  const store = new JobStore(db);
  const walkthroughStore = new GuidedWalkthroughStore(db);
  const queue = { enqueue() {}, abortMany() {} } as unknown as JobQueue;
  const guidedWalkthrough = contextExtras.guidedWalkthrough ?? {
    store: walkthroughStore,
    service: {
      model: () => "opencode-default",
      ensure(session: { provider: string; provider_instance: string; repo_full_name: string; pr_number: number; base_sha: string; head_sha: string }) {
        return walkthroughStore.open({
          provider: session.provider,
          instance: session.provider_instance,
          repoFullName: session.repo_full_name,
          prNumber: session.pr_number,
          baseSha: session.base_sha,
          headSha: session.head_sha,
        }, "opencode-default");
      },
      retry(row: import("./walkthrough-store.js").GuidedWalkthroughRow) { return row; },
      cancel(row: import("./walkthrough-store.js").GuidedWalkthroughRow) { return walkthroughStore.requestCancel(row.id); },
    } as never,
  };
  return { app: createApp({ config, store, queue, github, startedAt: Date.now(), env: {}, guidedWalkthrough, ...contextExtras }), store, walkthroughStore };
}

function operator(id = 1001) {
  const csrfToken = issueCsrfToken(secret);
  return {
    csrfToken,
    cookies: `${SESSION_COOKIE}=${signOAuthSession(secret, { id, login: `operator-${id}`, avatarUrl: null })}; ${CSRF_COOKIE}=${csrfToken}`,
  };
}

function passwordOperator() {
  const csrfToken = issueCsrfToken(secret);
  return { csrfToken, cookies: `${SESSION_COOKIE}=${signSession(secret)}; ${CSRF_COOKIE}=${csrfToken}` };
}

describe("Guided Review inbox", () => {
  it("lists authorized open pull requests with review, Maomao, and draft state", async () => {
    const { app, store } = testApp(githubFake());
    seedInbox(store);
    const enqueued = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 10,
      provider: "github",
      providerInstance: "github.com",
      githubAccountId: 100,
      githubRepositoryId: 200,
      prNumber: 12,
      prTitle: "Add guided review target",
      prBody: "",
      prHtmlUrl: "https://github.com/acme/widgets/pull/12",
      prAuthor: "octocat",
      baseSha,
      headSha,
      baseRef: "main",
      headRef: "feature",
      reviewers: [],
    });
    store.setJobState(enqueued.job.id, "completed");
    const auth = operator();
    const sessionOpen = store.guidedReview.open({
      actorProvider: "github",
      actorId: "1001",
      provider: "github",
      instance: "github.com",
      repoFullName: "acme/widgets",
      prNumber: 12,
      baseSha,
      headSha,
    });
    expect(sessionOpen.session.id).toBeGreaterThan(0);

    const response = await app.request("/guided", { headers: { cookie: auth.cookies } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Guided Review");
    expect(html).toContain("Add guided review target");
    expect(html).toContain("acme/widgets#12");
    expect(html).toContain("review requested");
    expect(html).toContain("Maomao completed");
    expect(html).toContain("Draft current");
  });

  it("applies author and review-state filters and keeps filter state in pagination", async () => {
    const unrequested = pull({ requestedReviewers: [] });
    const { app, store } = testApp(githubFake(unrequested));
    seedInbox(store, unrequested);
    const auth = operator();
    const filtered = await app.request("/guided?author=octo&reviewState=unrequested", { headers: { cookie: auth.cookies } });
    expect(filtered.status).toBe(200);
    const html = await filtered.text();
    expect(html).toContain("Add guided review target");
    expect(html).toContain('value="octo"');
    expect(html).toContain('value="unrequested" selected');
    const mismatched = await app.request("/guided?author=someone-else", { headers: { cookie: auth.cookies } });
    expect(await mismatched.text()).toContain("No open pull requests match");
  });

  it("omits installation repositories outside the allowlist", async () => {
    const { app, store } = testApp(githubFake(), { ALLOWED_GITHUB_REPOSITORY_IDS: "999" });
    seedInbox(store);
    const auth = operator();
    const response = await app.request("/guided", { headers: { cookie: auth.cookies } });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("acme/widgets#12");
  });

  it("opens a direct URL into a SHA-pinned OAuth draft and keeps password sessions read-only", async () => {
    const github = githubFake();
    const compareCalls: unknown[][] = [];
    const originalCompare = github.getCompareDiff!.bind(github);
    github.getCompareDiff = async (...args: unknown[]) => {
      compareCalls.push(args);
      return originalCompare(...args as [number, string, string, string, string, number?]);
    };
    const { app, store } = testApp(github);
    const auth = operator();
    const form = new URLSearchParams({ url: "https://github.com/acme/widgets/pull/12", csrf_token: auth.csrfToken });
    const post = await app.request("/guided/open", {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(post.status).toBe(302);
    expect(post.headers.get("location")).toBe("/guided/github/acme/widgets/12");

    const detail = await app.request("/guided/github/acme/widgets/12", { headers: { cookie: auth.cookies } });
    expect(detail.status).toBe(200);
    const html = await detail.text();
    expect(html).toContain("SHA-pinned workspace");
    expect(html).toContain(baseSha);
    expect(html).toContain("Files changed");
    expect(html).toContain("Independent exploration evidence");
    expect(html).toContain("data-guided-primer");
    expect(html).toContain("background");
    expect(html).toContain("new.ts");
    expect(html).toContain("data-anchor-side=\"LEFT\"");
    expect(compareCalls[0]?.slice(1, 5)).toEqual(["acme", "widgets", baseSha, headSha]);
    const session = store.guidedReview.latestForPull({ actorProvider: "github", actorId: "1001" }, "github", "github.com", "acme/widgets", 12);
    expect(session?.head_sha).toBe(headSha);
    const context = await app.request(`/api/guided-review/sessions/${session?.id}/file?path=${encodeURIComponent("new.ts")}&side=head`, { headers: { cookie: auth.cookies } });
    expect(context.status).toBe(200);
    expect(((await context.json()) as { content: string }).content).toContain("surrounding");
    const traversal = await app.request(`/api/guided-review/sessions/${session?.id}/file?path=${encodeURIComponent("../secret")}`, { headers: { cookie: auth.cookies } });
    expect(traversal.status).toBe(400);

    const password = passwordOperator();
    const readOnly = await app.request("/guided/github/acme/widgets/12", { headers: { cookie: password.cookies } });
    expect(readOnly.status).toBe(200);
    expect(await readOnly.text()).toContain("Password-only sessions are read-only");
  });

  it("shows oversized or failed diff fetches explicitly instead of implying coverage", async () => {
    const github = githubFake();
    github.getCompareDiff = async () => {
      throw new Error("diff exceeds MAX_DIFF_BYTES (2000 > 1000)");
    };
    const { app } = testApp(github);
    const auth = operator();
    const response = await app.request("/guided/github/acme/widgets/12", { headers: { cookie: auth.cookies } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Could not load the authoritative pull request diff");
    expect(html).toContain("cannot imply unseen changes");
  });



  it("enforces repository authorization and failure contracts for exact-SHA file context", async () => {
    const auth = operator();
    const openSession = (store: JobStore) => store.guidedReview.open({
      actorProvider: "github",
      actorId: "1001",
      provider: "github",
      instance: "github.com",
      repoFullName: "acme/widgets",
      prNumber: 12,
      baseSha,
      headSha,
    }).session;

    const denied = testApp(githubFake(), { ALLOWED_GITHUB_REPOSITORY_IDS: "999" });
    const deniedSession = openSession(denied.store);
    const forbidden = await denied.app.request(`/api/guided-review/sessions/${deniedSession.id}/file?path=new.ts&side=head`, { headers: { cookie: auth.cookies } });
    expect(forbidden.status).toBe(403);

    const githubWithoutFiles = githubFake();
    delete githubWithoutFiles.getFileContent;
    const unavailable = testApp(githubWithoutFiles);
    const unavailableSession = openSession(unavailable.store);
    const missingCapability = await unavailable.app.request(`/api/guided-review/sessions/${unavailableSession.id}/file?path=new.ts&side=head`, { headers: { cookie: auth.cookies } });
    expect(missingCapability.status).toBe(503);
    expect(((await missingCapability.json()) as { error: string }).error).toBe("guided_review_context_unavailable");

    const absentGithub = githubFake();
    absentGithub.getFileContent = async () => {
      const error = new Error("not found") as Error & { status?: number };
      error.status = 404;
      throw error;
    };
    const absent = testApp(absentGithub);
    const absentSession = openSession(absent.store);
    const absentResponse = await absent.app.request(`/api/guided-review/sessions/${absentSession.id}/file?path=deleted.ts&side=head`, { headers: { cookie: auth.cookies } });
    expect(absentResponse.status).toBe(200);
    expect(await absentResponse.json()).toMatchObject({ path: "deleted.ts", side: "head", absent: true });

    const failingGithub = githubFake();
    failingGithub.getFileContent = async () => {
      throw new Error("upstream failed using webhook-secret");
    };
    const failing = testApp(failingGithub);
    const failingSession = openSession(failing.store);
    const upstreamFailure = await failing.app.request(`/api/guided-review/sessions/${failingSession.id}/file?path=new.ts&side=head`, { headers: { cookie: auth.cookies } });
    expect(upstreamFailure.status).toBe(502);
    const failureBody = await upstreamFailure.json() as { error: string; message: string };
    expect(failureBody.error).toBe("guided_review_context_unavailable");
    expect(failureBody.message).not.toContain("webhook-secret");
  });

  it("keeps normal inbox reads webhook-cached and reconciles deliberately through sync", async () => {
    const github = githubFake();
    let listCalls = 0;
    const originalList = github.listOpenPulls!.bind(github);
    github.listOpenPulls = async (...args: unknown[]) => {
      listCalls += 1;
      return originalList(...args as [number, string, string]);
    };
    const { app, store } = testApp(github);
    const auth = operator();
    const initial = await app.request("/guided", { headers: { cookie: auth.cookies } });
    expect(initial.status).toBe(200);
    expect(await initial.text()).toContain("No open pull requests match");
    expect(listCalls).toBe(0);

    store.upsertGuidedInboxPull({
      installationId: 99,
      githubAccountId: 100,
      githubRepositoryId: 999,
      repoFullName: "ghost/removed",
      prNumber: 99,
      prTitle: "Ghost pull",
      prHtmlUrl: "https://github.com/ghost/removed/pull/99",
      prAuthor: "ghost",
      baseSha,
      headSha,
      draft: false,
      state: "open",
    });
    const sync = await app.request("/guided/sync", {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: auth.csrfToken }).toString(),
    });
    expect(sync.status).toBe(302);
    expect(listCalls).toBe(1);
    expect(store.listGuidedInboxPulls()).toHaveLength(1);
    expect(store.listGuidedInboxPulls()[0]?.repo_full_name).toBe("acme/widgets");
    const cached = await app.request("/guided", { headers: { cookie: auth.cookies } });
    expect(await cached.text()).toContain("Add guided review target");
    expect(listCalls).toBe(1);

    github.listOpenPulls = async () => {
      listCalls += 1;
      return [];
    };
    const closeSync = await app.request("/guided/sync", {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: auth.csrfToken }).toString(),
    });
    expect(closeSync.status).toBe(302);
    expect(store.listGuidedInboxPulls()).toHaveLength(0);
  });

  it("backfills the webhook-cached inbox from the settings panel", async () => {
    const github = githubFake();
    const { app, store } = testApp(github);
    const auth = operator();

    const page = await app.request("/config/guided-inbox", { headers: { cookie: auth.cookies } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Guided Review inbox");
    expect(html).toContain("Backfill open pull requests");
    expect(html).toContain("including PRs opened before webhook caching was enabled");
    expect(html.match(/name="csrf_token"/g)).toHaveLength(2);

    const sync = await app.request("/config/guided-inbox/sync", {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: auth.csrfToken }).toString(),
    });
    expect(sync.status).toBe(303);
    expect(sync.headers.get("location")).toContain("/config/guided-inbox?notice=");
    expect(store.listGuidedInboxPulls()).toHaveLength(1);
    expect(store.guidedInboxCacheStats()).toMatchObject({ totalRows: 1, openPulls: 1, repos: 1 });

    const after = await app.request(sync.headers.get("location")!, { headers: { cookie: auth.cookies } });
    const afterHtml = await after.text();
    expect(afterHtml).toContain("Backfilled 1 open pull request across 1 repository");
    expect(afterHtml).toContain("Open pull requests cached");
  });

  it("reports a partial settings backfill without discarding cached rows", async () => {
    const github = githubFake();
    github.listOpenPulls = async () => {
      throw new Error("github unavailable");
    };
    const { app, store } = testApp(github);
    const auth = operator();
    seedInbox(store);

    const sync = await app.request("/config/guided-inbox/sync", {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: auth.csrfToken }).toString(),
    });
    expect(sync.status).toBe(303);
    expect(sync.headers.get("location")).toContain("/config/guided-inbox?error=");
    expect(store.listGuidedInboxPulls()).toHaveLength(1);

    const after = await app.request(sync.headers.get("location")!, { headers: { cookie: auth.cookies } });
    expect(await after.text()).toContain("Backfill was partial");
  });

  it("rejects closed direct targets and degrades when listing capability is absent", async () => {
    const closed = testApp(githubFake(pull({ state: "closed" })));
    const auth = operator();
    const response = await closed.app.request("/guided/github/acme/widgets/12", { headers: { cookie: auth.cookies } });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Only open pull requests");

    const unavailable = testApp(undefined);
    seedInbox(unavailable.store);
    const cached = await unavailable.app.request("/guided", { headers: { cookie: auth.cookies } });
    expect(cached.status).toBe(200);
    const cachedHtml = await cached.text();
    expect(cachedHtml).toContain("Add guided review target");
    expect(cachedHtml).not.toContain("open-pull listing is unavailable");
  });
});
