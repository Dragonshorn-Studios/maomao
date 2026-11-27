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
    const { app } = testApp(githubFake(pull({ requestedReviewers: [] })));
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
    const { app } = testApp(githubFake(), { ALLOWED_GITHUB_REPOSITORY_IDS: "999" });
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
    expect(html).toContain("Diff workspace");
    expect(html).toContain("SHA-pinned walkthrough");
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

  it("rejects closed direct targets and degrades when listing capability is absent", async () => {
    const closed = testApp(githubFake(pull({ state: "closed" })));
    const auth = operator();
    const response = await closed.app.request("/guided/github/acme/widgets/12", { headers: { cookie: auth.cookies } });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Only open pull requests");

    const unavailable = testApp(undefined);
    const degraded = await unavailable.app.request("/guided", { headers: { cookie: auth.cookies } });
    expect(degraded.status).toBe(200);
    expect(await degraded.text()).toContain("open-pull listing is unavailable");
  });
});
