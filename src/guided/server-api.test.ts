import { describe, expect, it } from "vitest";
import { CSRF_COOKIE, SESSION_COOKIE, issueCsrfToken, signOAuthSession, signSession } from "../auth.js";
import { loadConfig } from "../config.js";
import { openDb } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { JobStore } from "../jobs/store.js";
import { createApp } from "../server.js";
import type { ManualTriggerPort } from "../github/client.js";
import { GuidedWalkthroughStore } from "./walkthrough-store.js";
import { fingerprintFinding } from "../findings/identity.js";
import { GuidedHumanPublishStore, guidedHumanPublishMarker } from "./human-publish.js";

const secret = "guided-review-test-secret";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const nextHeadSha = "c".repeat(40);

function guidedTestApp(github?: ManualTriggerPort, contextExtras: Partial<Parameters<typeof createApp>[0]> = {}, env: Record<string, string> = {}) {
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
  const guidedHumanPublish = contextExtras.guidedHumanPublish ?? new GuidedHumanPublishStore(db, secret);
  return { app: createApp({ config, store, queue, github, startedAt: Date.now(), env: {}, guidedWalkthrough, guidedHumanPublish, ...contextExtras }), store, walkthroughStore, db, guidedHumanPublish };
}

function operator(id: number, login = `operator-${id}`) {
  const csrfToken = issueCsrfToken(secret);
  return {
    csrfToken,
    cookies: `${SESSION_COOKIE}=${signOAuthSession(secret, { id, login, avatarUrl: null })}; ${CSRF_COOKIE}=${csrfToken}`,
  };
}

function passwordOperator() {
  const csrfToken = issueCsrfToken(secret);
  return {
    csrfToken,
    cookies: `${SESSION_COOKIE}=${signSession(secret)}; ${CSRF_COOKIE}=${csrfToken}`,
  };
}

function openBody(csrfToken: string, overrides: Record<string, unknown> = {}) {
  return {
    provider: "github",
    instance: "github.com",
    repoFullName: "acme/widgets",
    prNumber: 12,
    baseSha,
    headSha,
    csrf_token: csrfToken,
    ...overrides,
  };
}

async function postJson(app: ReturnType<typeof createApp>, path: string, cookies: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { cookie: cookies, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Guided Review session API", () => {
  it("persists SHA-scoped private drafts through authenticated CSRF-protected JSON writes", async () => {
    const { app } = guidedTestApp();
    const auth = operator(1001);

    const openedResponse = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(auth.csrfToken));
    expect(openedResponse.status).toBe(200);
    const opened = (await openedResponse.json()) as {
      session: { id: number; version: number; headSha: string; actorId: string };
      staleFrom: unknown;
    };
    expect(opened.session.headSha).toBe(headSha);
    expect(opened.session.actorId).toBe("1001");
    expect(opened.staleFrom).toBeNull();

    const repeated = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(auth.csrfToken));
    expect(((await repeated.json()) as { session: { id: number } }).session.id).toBe(opened.session.id);

    const updateBody = {
      version: 1,
      draftSummary: "human summary",
      draftVerdict: "COMMENT",
      viewedFiles: ["src/index.ts"],
      mutationId: "mutation-1",
      csrf_token: auth.csrfToken,
    };
    const updatedResponse = await postJson(app, `/api/guided-review/sessions/${opened.session.id}`, auth.cookies, updateBody);
    expect(updatedResponse.status).toBe(200);
    const updated = (await updatedResponse.json()) as { session: { version: number; draftSummary: string } };
    expect(updated.session.version).toBe(2);
    expect(updated.session.draftSummary).toBe("human summary");

    const replay = await postJson(app, `/api/guided-review/sessions/${opened.session.id}`, auth.cookies, {
      ...updateBody,
      draftSummary: "retry must not overwrite",
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { session: { draftSummary: string } }).session.draftSummary).toBe("human summary");

    const conflict = await postJson(app, `/api/guided-review/sessions/${opened.session.id}`, auth.cookies, {
      version: 1,
      draftSummary: "other tab",
      mutationId: "mutation-2",
      csrf_token: auth.csrfToken,
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toBe("guided_review_version_conflict");

    const commentResponse = await postJson(app, `/api/guided-review/sessions/${opened.session.id}/comments`, auth.cookies, {
      version: 2,
      clientId: "note-1",
      kind: "inline",
      body: "Please explain this branch",
      path: "src/index.ts",
      side: "RIGHT",
      line: 20,
      severity: "medium",
      publishable: true,
      mutationId: "comment-1",
      csrf_token: auth.csrfToken,
    });
    expect(commentResponse.status).toBe(200);
    const commentBody = (await commentResponse.json()) as {
      session: { version: number };
      comment: { path: string; publishable: boolean };
    };
    expect(commentBody.session.version).toBe(3);
    expect(commentBody.comment).toMatchObject({ path: "src/index.ts", publishable: true });

    const read = await app.request(`/api/guided-review/sessions/${opened.session.id}`, { headers: { cookie: auth.cookies } });
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { comments: unknown[] };
    expect(readBody.comments).toHaveLength(1);
  });

  it("lists only same-pull unresolved discussions and resolves them after write-permission validation", async () => {
    const resolved: string[] = [];
    const discussions = [
      {
        id: "thread-open",
        path: "src/index.ts",
        line: 20,
        isResolved: false,
        comments: [
          { authorLogin: "maomao[bot]", body: "Maomao finding", path: "src/index.ts", line: 20 },
          { authorLogin: "operator-1001", body: "handled", path: "src/index.ts", line: 20 },
        ],
      },
      { id: "thread-resolved", path: "src/other.ts", line: 3, isResolved: true, comments: [] },
    ];
    const port = {
      listDiscussions: async () => discussions,
      resolveDiscussion: async (_target: unknown, discussionId: string) => { resolved.push(discussionId); },
    };
    const forge = { forJob: () => port };
    let permission = "read";
    const github = {
      async getRepoInstallation() { return { installationId: 1, accountId: 1001 }; },
      getCollaboratorPermission: async () => permission,
    } as unknown as ManualTriggerPort;
    const { app, store } = guidedTestApp(github, { forge: forge as never }, { GITHUB_APP_SLUG: "maomao" });
    const auth = operator(1001);
    const opened = store.guidedReview.open({
      actorProvider: "github",
      actorId: "1001",
      provider: "github",
      instance: "github.com",
      repoFullName: "acme/widgets",
      prNumber: 12,
      baseSha,
      headSha,
    }).session;

    const deniedList = await app.request(`/api/guided-review/sessions/${opened.id}/discussions`, { headers: { cookie: auth.cookies } });
    expect(deniedList.status).toBe(403);
    const deniedResolve = await postJson(app, `/api/guided-review/sessions/${opened.id}/discussions/resolve`, auth.cookies, {
      discussionId: "thread-open",
      csrf_token: auth.csrfToken,
    });
    expect(deniedResolve.status).toBe(403);
    expect(resolved).toEqual([]);

    permission = "write";
    const listed = await app.request(`/api/guided-review/sessions/${opened.id}/discussions`, { headers: { cookie: auth.cookies } });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { discussions: Array<{ id: string; maomaoAuthored: boolean; comments: unknown[] }> };
    expect(listedBody.discussions).toHaveLength(1);
    expect(listedBody.discussions[0]).toMatchObject({ id: "thread-open", maomaoAuthored: true });
    expect(listedBody.discussions[0].comments).toHaveLength(2);

    const missing = await postJson(app, `/api/guided-review/sessions/${opened.id}/discussions/resolve`, auth.cookies, {
      discussionId: "thread-resolved",
      csrf_token: auth.csrfToken,
    });
    expect(missing.status).toBe(404);
    expect(resolved).toEqual([]);

    const resolvedResponse = await postJson(app, `/api/guided-review/sessions/${opened.id}/discussions/resolve`, auth.cookies, {
      discussionId: "thread-open",
      csrf_token: auth.csrfToken,
    });
    expect(resolvedResponse.status).toBe(200);
    expect(resolved).toEqual(["thread-open"]);
  });

  it("reports discussion resolution as unsupported without a forge port", async () => {
    const { app, store } = guidedTestApp();
    const auth = operator(1001);
    const opened = store.guidedReview.open({
      actorProvider: "github",
      actorId: "1001",
      provider: "github",
      instance: "github.com",
      repoFullName: "acme/widgets",
      prNumber: 12,
      baseSha,
      headSha,
    }).session;
    const listed = await app.request(`/api/guided-review/sessions/${opened.id}/discussions`, { headers: { cookie: auth.cookies } });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ discussions: [], unsupported: true });
    const resolved = await postJson(app, `/api/guided-review/sessions/${opened.id}/discussions/resolve`, auth.cookies, {
      discussionId: "thread-open",
      csrf_token: auth.csrfToken,
    });
    expect(resolved.status).toBe(422);
    expect(await resolved.json()).toEqual({ error: "unsupported" });
  });

  it("rejects password-only attribution and isolates drafts between operators", async () => {
    const { app } = guidedTestApp();
    const first = operator(1001);
    const second = operator(2002);
    const passwordOnly = passwordOperator();

    const denied = await postJson(
      app,
      "/api/guided-review/sessions/open",
      passwordOnly.cookies,
      openBody(passwordOnly.csrfToken),
    );
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toBe("guided_review_identity_required");

    const openedResponse = await postJson(app, "/api/guided-review/sessions/open", first.cookies, openBody(first.csrfToken));
    const opened = (await openedResponse.json()) as { session: { id: number } };
    const readAsSecond = await app.request(`/api/guided-review/sessions/${opened.session.id}`, {
      headers: { cookie: second.cookies },
    });
    expect(readAsSecond.status).toBe(404);
    const writeAsSecond = await postJson(app, `/api/guided-review/sessions/${opened.session.id}`, second.cookies, {
      version: 1,
      draftSummary: "not mine",
      csrf_token: second.csrfToken,
    });
    expect(writeAsSecond.status).toBe(404);
  });

  it("rejects missing and mismatched CSRF tokens before mutating state", async () => {
    const { app, store } = guidedTestApp();
    const auth = operator(1001);
    const missing = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(""));
    expect(missing.status).toBe(403);

    const mismatchedCookie = `${SESSION_COOKIE}=${signOAuthSession(secret, { id: 1001, login: "operator-1001", avatarUrl: null })}; ${CSRF_COOKIE}=${issueCsrfToken(secret)}`;
    const mismatched = await postJson(app, "/api/guided-review/sessions/open", mismatchedCookie, openBody(auth.csrfToken));
    expect(mismatched.status).toBe(403);

    const valid = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(auth.csrfToken));
    expect(valid.status).toBe(200);
    expect(store.guidedReview.getOwned(1, { actorProvider: "github", actorId: "1001" })).toBeTruthy();
  });

  it("rejects malformed inline coordinates", async () => {
    const { app } = guidedTestApp();
    const auth = operator(1001);
    const openedResponse = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(auth.csrfToken));
    const opened = (await openedResponse.json()) as { session: { id: number } };

    const invalid = await postJson(app, `/api/guided-review/sessions/${opened.session.id}/comments`, auth.cookies, {
      version: 1,
      clientId: "bad-path",
      kind: "inline",
      body: "invalid",
      path: "../secret",
      side: "RIGHT",
      line: 10,
      csrf_token: auth.csrfToken,
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: string }).error).toBe("invalid_input");
  });

  it("marks superseded SHA drafts historical and copies inline notes as unplaced", async () => {
    const { app } = guidedTestApp();
    const auth = operator(1001);
    const openedResponse = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(auth.csrfToken));
    const opened = (await openedResponse.json()) as { session: { id: number } };

    const commentResponse = await postJson(app, `/api/guided-review/sessions/${opened.session.id}/comments`, auth.cookies, {
      version: 1,
      clientId: "note-1",
      kind: "inline",
      body: "publishable while current",
      path: "src/index.ts",
      side: "RIGHT",
      line: 20,
      publishable: true,
      csrf_token: auth.csrfToken,
    });
    expect(commentResponse.status).toBe(200);

    const movedResponse = await postJson(
      app,
      "/api/guided-review/sessions/open",
      auth.cookies,
      openBody(auth.csrfToken, { headSha: nextHeadSha }),
    );
    expect(movedResponse.status).toBe(200);
    const moved = (await movedResponse.json()) as {
      session: { id: number };
      staleFrom: { id: number; historicalAt: string | null } | null;
    };
    expect(moved.staleFrom?.id).toBe(opened.session.id);

    const staleWrite = await postJson(app, `/api/guided-review/sessions/${opened.session.id}`, auth.cookies, {
      version: 2,
      draftSummary: "too late",
      csrf_token: auth.csrfToken,
    });
    expect(staleWrite.status).toBe(409);
    expect(((await staleWrite.json()) as { error: string }).error).toBe("guided_review_session_historical");

    const copiedResponse = await postJson(app, `/api/guided-review/sessions/${opened.session.id}/copy`, auth.cookies, {
      targetBaseSha: baseSha,
      targetHeadSha: nextHeadSha,
      csrf_token: auth.csrfToken,
    });
    expect(copiedResponse.status).toBe(200);
    const copied = (await copiedResponse.json()) as { session: { id: number }; copied: number };
    expect(copied.session.id).toBe(moved.session.id);
    expect(copied.copied).toBe(1);

    const targetRead = await app.request(`/api/guided-review/sessions/${moved.session.id}`, { headers: { cookie: auth.cookies } });
    const target = (await targetRead.json()) as {
      comments: { anchorStatus: string; publishable: boolean; path: string }[];
    };
    expect(target.comments[0]).toMatchObject({ anchorStatus: "unplaced", publishable: false, path: "src/index.ts" });
  });

  it("binds GitHub opens to live PR metadata and detects head movement", async () => {
    const liveBaseSha = "d".repeat(40);
    let liveHeadSha = "e".repeat(40);
    let pullCalls = 0;
    const github: ManualTriggerPort = {
      getRepoInstallation: async () => ({ installationId: 1, accountId: 1001 }),
      getRepository: async () => ({ id: 2002 }),
      getPull: async (installationId, owner, repo, prNumber) => {
        pullCalls += 1;
        return {
          installationId,
          accountId: 1001,
          repositoryId: 2002,
          repoOwner: owner,
          repoName: repo,
          repoFullName: `${owner}/${repo}`,
          prNumber,
          prTitle: "Live PR",
          prBody: "",
          prHtmlUrl: "https://github.com/acme/widgets/pull/12",
          prAuthor: "dev",
          baseSha: liveBaseSha,
          headSha: liveHeadSha,
          baseRef: "main",
          headRef: "feature",
          draft: false,
        };
      },
    };
    const { app } = guidedTestApp(github);
    const auth = operator(1001);

    const firstResponse = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(auth.csrfToken));
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as { session: { id: number; baseSha: string; headSha: string } };
    expect(first.session).toMatchObject({ baseSha: liveBaseSha, headSha: "e".repeat(40) });

    liveHeadSha = "f".repeat(40);
    const movedResponse = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(auth.csrfToken));
    expect(movedResponse.status).toBe(200);
    const moved = (await movedResponse.json()) as {
      session: { headSha: string };
      staleFrom: { id: number } | null;
    };
    expect(moved.session.headSha).toBe(liveHeadSha);
    expect(moved.staleFrom?.id).toBe(first.session.id);
    expect(pullCalls).toBe(2);
  });

  it("returns an exact publication preview without writes and keeps private/unplaced feedback out", async () => {
    const { app } = guidedTestApp();
    const auth = operator(1001);
    const openedResponse = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(auth.csrfToken));
    const opened = (await openedResponse.json()) as { session: { id: number; version: number } };
    const write = await postJson(app, `/api/guided-review/sessions/${opened.session.id}`, auth.cookies, {
      version: 1,
      draftSummary: "Publish this summary",
      draftVerdict: "APPROVE",
      csrf_token: auth.csrfToken,
    });
    expect(write.status).toBe(200);
    const comment = await postJson(app, `/api/guided-review/sessions/${opened.session.id}/comments`, auth.cookies, {
      version: 2,
      clientId: "inline-1",
      kind: "inline",
      body: "Inline approval rationale",
      path: "src/index.ts",
      side: "RIGHT",
      line: 7,
      publishable: true,
      csrf_token: auth.csrfToken,
    });
    expect(comment.status).toBe(200);
    const privateNote = await postJson(app, `/api/guided-review/sessions/${opened.session.id}/comments`, auth.cookies, {
      version: 3,
      clientId: "private-1",
      kind: "general",
      body: "Private only",
      publishable: false,
      csrf_token: auth.csrfToken,
    });
    expect(privateNote.status).toBe(200);

    const before = await app.request(`/api/guided-review/sessions/${opened.session.id}`, { headers: { cookie: auth.cookies } });
    const beforeJson = (await before.json()) as { session: { version: number } };
    const previewResponse = await app.request(`/api/guided-review/sessions/${opened.session.id}/preview`, { headers: { cookie: auth.cookies } });
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json()) as {
      preview: { event: string; body: string; comments: unknown[]; omittedInlineCount: number; target: { headSha: string } };
    };
    expect(preview.preview).toMatchObject({ event: "APPROVE", comments: [], omittedInlineCount: 1 });
    expect(preview.preview.target.headSha).toBe(headSha);
    expect(preview.preview.body).toContain("Publish this summary");
    expect(preview.preview.body).toContain("Inline approval rationale");
    expect(preview.preview.body).not.toContain("Private only");
    const after = await app.request(`/api/guided-review/sessions/${opened.session.id}`, { headers: { cookie: auth.cookies } });
    expect(((await after.json()) as { session: { version: number } }).session.version).toBe(beforeJson.session.version);
  });


  it("serves actor-scoped walkthrough status without writes and supports deliberate cancellation", async () => {
    const { app, walkthroughStore } = guidedTestApp();
    const auth = operator(1001);
    const other = operator(2002);
    const openedResponse = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(auth.csrfToken));
    const opened = (await openedResponse.json()) as { session: { id: number; version: number } };
    const row = walkthroughStore.open({
      provider: "github",
      instance: "github.com",
      repoFullName: "acme/widgets",
      prNumber: 12,
      baseSha,
      headSha,
    }, "opencode-default");

    const denied = await app.request(`/api/guided-review/sessions/${opened.session.id}/walkthrough`, { headers: { cookie: other.cookies } });
    expect(denied.status).toBe(404);

    const before = await app.request(`/api/guided-review/sessions/${opened.session.id}`, { headers: { cookie: auth.cookies } });
    const beforeVersion = ((await before.json()) as { session: { version: number } }).session.version;
    const statusResponse = await app.request(`/api/guided-review/sessions/${opened.session.id}/walkthrough`, { headers: { cookie: auth.cookies } });
    expect(statusResponse.status).toBe(200);
    const status = (await statusResponse.json()) as { walkthrough: { fingerprint: string; status: string } };
    expect(status.walkthrough).toMatchObject({ fingerprint: row.fingerprint, status: "pending" });
    const after = await app.request(`/api/guided-review/sessions/${opened.session.id}`, { headers: { cookie: auth.cookies } });
    expect(((await after.json()) as { session: { version: number } }).session.version).toBe(beforeVersion);

    const missingCsrf = await postJson(app, `/api/guided-review/sessions/${opened.session.id}/walkthrough/cancel`, auth.cookies, {});
    expect(missingCsrf.status).toBe(403);
    const cancel = await postJson(app, `/api/guided-review/sessions/${opened.session.id}/walkthrough/cancel`, auth.cookies, { csrf_token: auth.csrfToken });
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as { walkthrough: { status: string } }).walkthrough.status).toBe("cancelled");
  });

  it("returns cached structured walkthrough evidence for the same exact-SHA fingerprint", async () => {
    const { app, walkthroughStore } = guidedTestApp();
    const auth = operator(1001);
    const openedResponse = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(auth.csrfToken));
    const opened = (await openedResponse.json()) as { session: { id: number } };
    const row = walkthroughStore.open({
      provider: "github",
      instance: "github.com",
      repoFullName: "acme/widgets",
      prNumber: 12,
      baseSha,
      headSha,
    }, "opencode-default");
    expect(walkthroughStore.claim(row.id)).toBe(true);
    walkthroughStore.markReady(row.id, {
      schema_version: 1,
      kind: "guided_walkthrough",
      intent: { text: "The PR documents a cache.", uncertainty: "No migration note was found." },
      changeMap: [{ path: "src/cache.ts", summary: "Adds cache reuse.", evidence: "src/cache.ts hunk 1" }],
      flow: "Requests consult the cache first.",
      decisions: [{ title: "SHA fingerprint", details: "Invalidates moved heads.", evidence: "fingerprint fields" }],
      tests: "Store tests cover reuse.",
      risks: [{ question: "Are prompt revisions included?", path: "src/cache.ts", line: 4, evidence: "model key" }],
      generatedAt: new Date().toISOString(),
    });
    const response = await app.request(`/api/guided-review/sessions/${opened.session.id}/walkthrough`, { headers: { cookie: auth.cookies } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { walkthrough: { status: string; payload?: { changeMap: Array<{ path: string }>; risks: Array<{ line?: number }> } } };
    expect(body.walkthrough.status).toBe("ready");
    expect(body.walkthrough.payload?.changeMap[0]?.path).toBe("src/cache.ts");
    expect(body.walkthrough.payload?.risks[0]?.line).toBe(4);
  });



  it("stores deliberate comparison pairing corrections behind ownership, version and CSRF boundaries", async () => {
    const { app, store } = guidedTestApp();
    const auth = operator(1001);
    const aiFinding = {
      severity: "medium",
      category: "correctness",
      file: "src/index.ts",
      line: 20,
      summary: "Retry can duplicate delivery",
      body: "The retry branch can emit the same event twice.",
    };
    const aiFingerprint = fingerprintFinding({ file: aiFinding.file, category: aiFinding.category, summary: aiFinding.summary, body: aiFinding.body });
    const aiOnlyFinding = {
      severity: "medium",
      category: "correctness",
      file: "src/index.ts",
      line: 24,
      summary: "Rollback path is not bounded",
      body: "The rollback branch can continue past the intended retry boundary.",
    };
    const aiOnlyFingerprint = fingerprintFinding({ file: aiOnlyFinding.file, category: aiOnlyFinding.category, summary: aiOnlyFinding.summary, body: aiOnlyFinding.body });
    const aiFileOnlyFinding = {
      severity: "low",
      category: "maintainability",
      file: "package.json",
      summary: "Package metadata should name the guided review workflow",
      body: "The package metadata does not describe the new operator workflow.",
    };
    const aiFileOnlyFingerprint = fingerprintFinding({ file: aiFileOnlyFinding.file, category: aiFileOnlyFinding.category, summary: aiFileOnlyFinding.summary, body: aiFileOnlyFinding.body });
    const enqueued = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 1,
      provider: "github",
      providerInstance: "github.com",
      prNumber: 12,
      prTitle: "Test pull request",
      prBody: "",
      prHtmlUrl: "https://github.com/acme/widgets/pull/12",
      prAuthor: "author",
      baseSha,
      headSha,
      baseRef: "main",
      headRef: "feature",
      reviewers: [],
    });
    store.setJobState(enqueued.job.id, "completed", {
      aggregator_normalized: JSON.stringify({ schema_version: 1, verdict: "comment", summary: "summary", findings: [aiFinding, aiOnlyFinding, aiFileOnlyFinding] }),
    });
    const openedResponse = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(auth.csrfToken));
    const opened = (await openedResponse.json()) as { session: { id: number; version: number } };
    const commentResponse = await postJson(app, `/api/guided-review/sessions/${opened.session.id}/comments`, auth.cookies, {
      version: opened.session.version,
      clientId: "note-1",
      kind: "inline",
      body: "Retry can duplicate delivery",
      path: "src/index.ts",
      side: "RIGHT",
      line: 20,
      csrf_token: auth.csrfToken,
    });
    expect(commentResponse.status).toBe(200);
    const commented = (await commentResponse.json()) as { session: { version: number } };

    const missingCsrf = await app.request(`/guided/sessions/${opened.session.id}/comparison/pair`, {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ version: String(commented.session.version), humanClientId: "note-1", fingerprint: aiFingerprint, decision: "confirm" }).toString(),
    });
    expect(missingCsrf.status).toBe(403);

    const response = await app.request(`/guided/sessions/${opened.session.id}/comparison/pair`, {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ version: String(commented.session.version), humanClientId: "note-1", fingerprint: aiFingerprint, decision: "confirm", csrf_token: auth.csrfToken }).toString(),
    });
    expect(response.status).toBe(303);
    const row = store.guidedReview.getOwned(opened.session.id, { actorProvider: "github", actorId: "1001" });
    expect(row?.comparison_state_json).toContain('"decision":"confirm"');
    expect(row?.version).toBe(commented.session.version + 1);

    const adoptPaired = await app.request(`/guided/sessions/${opened.session.id}/comparison/pair`, {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ version: String(row!.version), fingerprint: aiFingerprint, decision: "adopt", csrf_token: auth.csrfToken }).toString(),
    });
    expect(adoptPaired.status).toBe(400);

    const excluded = await app.request(`/guided/sessions/${opened.session.id}/comparison/pair`, {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ version: String(row!.version), fingerprint: aiOnlyFingerprint, decision: "exclude", csrf_token: auth.csrfToken }).toString(),
    });
    expect(excluded.status).toBe(303);
    const excludedRow = store.guidedReview.getOwned(opened.session.id, { actorProvider: "github", actorId: "1001" });
    expect(excludedRow?.comparison_state_json).toContain('"decision":"exclude"');
    const restore = await app.request(`/guided/sessions/${opened.session.id}/comparison/pair`, {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ version: String(excludedRow!.version), humanClientId: `maomao-exclude-${aiOnlyFingerprint}`, decision: "clear", csrf_token: auth.csrfToken }).toString(),
    });
    expect(restore.status).toBe(303);
    const restored = store.guidedReview.getOwned(opened.session.id, { actorProvider: "github", actorId: "1001" });
    const adopt = await app.request(`/guided/sessions/${opened.session.id}/comparison/pair`, {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ version: String(restored!.version), fingerprint: aiOnlyFingerprint, decision: "adopt", csrf_token: auth.csrfToken }).toString(),
    });
    expect(adopt.status).toBe(303);
    const adoptedComment = store.guidedReview.listComments(opened.session.id).find((comment) => comment.client_id === `maomao-${aiOnlyFingerprint}`);
    expect(adoptedComment).toMatchObject({ kind: "inline", path: "src/index.ts", line: 24, publishable: 1 });

    const afterInlineAdopt = store.guidedReview.getOwned(opened.session.id, { actorProvider: "github", actorId: "1001" });
    const staleAdopt = await app.request(`/guided/sessions/${opened.session.id}/comparison/pair`, {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ version: String(restored!.version), fingerprint: aiFileOnlyFingerprint, decision: "adopt", csrf_token: auth.csrfToken }).toString(),
    });
    expect(staleAdopt.status).toBe(409);
    const adoptFileOnly = await app.request(`/guided/sessions/${opened.session.id}/comparison/pair`, {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ version: String(afterInlineAdopt!.version), fingerprint: aiFileOnlyFingerprint, decision: "adopt", csrf_token: auth.csrfToken }).toString(),
    });
    expect(adoptFileOnly.status).toBe(303);
    const adoptedGeneral = store.guidedReview.listComments(opened.session.id).find((comment) => comment.client_id === `maomao-${aiFileOnlyFingerprint}`);
    expect(adoptedGeneral).toMatchObject({ kind: "general", path: null, side: null, line: null, publishable: 1 });
    expect(adoptedGeneral?.body).toBe(`package.json: ${aiFileOnlyFinding.summary}`);

    const stranger = operator(2002);
    const strangerResponse = await app.request(`/guided/sessions/${opened.session.id}/comparison/pair`, {
      method: "POST",
      headers: { cookie: stranger.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ version: String(commented.session.version), humanClientId: "note-1", fingerprint: aiFingerprint, decision: "confirm", csrf_token: stranger.csrfToken }).toString(),
    });
    expect(strangerResponse.status).toBe(404);
    const conflict = await app.request(`/guided/sessions/${opened.session.id}/comparison/pair`, {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ version: String(commented.session.version), humanClientId: "note-1", fingerprint: aiFingerprint, decision: "confirm", csrf_token: auth.csrfToken }).toString(),
    });
    expect(conflict.status).toBe(409);

    const nextHead = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 1,
      provider: "github",
      providerInstance: "github.com",
      prNumber: 12,
      prTitle: "Test pull request",
      prBody: "",
      prHtmlUrl: "https://github.com/acme/widgets/pull/12",
      prAuthor: "author",
      baseSha,
      headSha: nextHeadSha,
      baseRef: "main",
      headRef: "feature",
      reviewers: [],
    });
    store.setJobState(nextHead.job.id, "completed", {
      aggregator_normalized: JSON.stringify({ schema_version: 1, verdict: "comment", summary: "summary", findings: [{ severity: "low", category: "style", file: "src/other.ts", line: 1, summary: "Newer commit-only finding" }] }),
    });
    const comparison = await app.request(`/api/guided-review/sessions/${opened.session.id}/comparison`, { headers: { cookie: auth.cookies } });
    expect(comparison.status).toBe(200);
    const comparisonBody = (await comparison.json()) as { comparison: { state: string; headSha: string; agreements: Array<{ maomao: { summary: string } }>; maomaoOnly: Array<{ summary: string }> } };
    expect(comparisonBody.comparison).toMatchObject({ state: "stale", headSha });
    expect([...comparisonBody.comparison.agreements.map((item) => item.maomao.summary), ...comparisonBody.comparison.maomaoOnly.map((item) => item.summary)]).toContain("Retry can duplicate delivery");
    expect([...comparisonBody.comparison.agreements.map((item) => item.maomao.summary), ...comparisonBody.comparison.maomaoOnly.map((item) => item.summary)]).not.toContain("Newer commit-only finding");
  });


  it("reads comparison evidence from the newest exact-head review even when re-review retired the old dedup key", async () => {
    const { app, store } = guidedTestApp();
    const auth = operator(1001);
    const input = {
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 1,
      provider: "github",
      providerInstance: "github.com",
      prNumber: 12,
      prTitle: "Test pull request",
      prBody: "",
      prHtmlUrl: "https://github.com/acme/widgets/pull/12",
      prAuthor: "author",
      baseSha,
      headSha,
      baseRef: "main",
      headRef: "feature",
      reviewers: [],
    };
    const artifact = (summary: string) => JSON.stringify({ schema_version: 1, verdict: "comment", summary: "summary", findings: [{ severity: "medium", category: "correctness", file: "src/index.ts", line: 20, summary }] });
    const oldJob = store.enqueue(input);
    store.setJobState(oldJob.job.id, "completed", { aggregator_normalized: artifact("Old exact-head artifact") });
    expect(store.retireJobDedupKey(oldJob.job.id, `rereview:${oldJob.job.id}`)).toBe(true);
    const newJob = store.enqueue(input);
    store.setJobState(newJob.job.id, "completed", { aggregator_normalized: artifact("Replacement exact-head artifact") });

    const openedResponse = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(auth.csrfToken));
    const opened = (await openedResponse.json()) as { session: { id: number } };
    const comparison = await app.request(`/api/guided-review/sessions/${opened.session.id}/comparison`, { headers: { cookie: auth.cookies } });
    expect(comparison.status).toBe(200);
    const body = (await comparison.json()) as { comparison: { jobId: number; maomaoOnly: Array<{ summary: string }> } };
    expect(body.comparison.jobId).toBe(newJob.job.id);
    expect(body.comparison.maomaoOnly.map((item) => item.summary)).toEqual(["Replacement exact-head artifact"]);
  });


  it("publishes a confirmed preview through the encrypted human credential without exposing the token", async () => {
    const posts: string[] = [];
    let reviewVisible = false;
    const githubFetch = async (url: string | URL, init?: RequestInit) => {
      const text = String(url);
      if (text.endsWith("/user")) return Response.json({ id: 1001, login: "operator-1001" });
      if (text.includes("/pulls/12/reviews") && (init?.method ?? "GET") === "GET") {
        return Response.json(reviewVisible ? [{ id: 123, html_url: "https://github.com/acme/widgets/pull/12#pullrequestreview-123", body: guidedHumanPublishMarker(1), user: { id: 1001 } }] : []);
      }
      if (text.includes("/pulls/12") && (init?.method ?? "GET") === "GET") return Response.json({ state: "open", head: { sha: headSha } });
      if (text.includes("/pulls/12/reviews") && init?.method === "POST") {
        posts.push(typeof init.body === "string" ? init.body : "");
        reviewVisible = true;
        return Response.json({ id: 123, html_url: "https://github.com/acme/widgets/pull/12#pullrequestreview-123" }, { status: 201 });
      }
      return Response.json({}, { status: 404 });
    };
    const { app, db, guidedHumanPublish: humanPublish } = guidedTestApp(undefined, { oauthFetch: githubFetch as typeof fetch });
    const auth = operator(1001);
    humanPublish.saveCredential({ actorProvider: "github", actorId: "1001" }, "human-token", "public_repo");

    const openedResponse = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(auth.csrfToken));
    const opened = (await openedResponse.json()) as { session: { id: number; version: number } };
    const updated = await postJson(app, `/api/guided-review/sessions/${opened.session.id}`, auth.cookies, {
      version: opened.session.version,
      draftSummary: "Publish this human summary",
      draftVerdict: "COMMENT",
      csrf_token: auth.csrfToken,
    });
    const version = ((await updated.json()) as { session: { version: number } }).session.version;
    const form = new URLSearchParams({ version: String(version), confirm: "yes", csrf_token: auth.csrfToken });
    const response = await app.request(`/guided/sessions/${opened.session.id}/publish`, {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(response.status).toBe(303);
    expect(posts).toHaveLength(1);
    const payload = JSON.parse(posts[0]) as { commit_id?: string; event?: string; body?: string };
    expect(payload).toMatchObject({ commit_id: headSha, event: "COMMENT" });
    expect(payload.body).toContain("Publish this human summary");
    expect(payload.body).toContain(`maomao-guided-human-publish:${opened.session.id}`);
    const stored = db.prepare(`SELECT token_encrypted FROM guided_human_credentials`).get() as { token_encrypted: string };
    expect(stored.token_encrypted).not.toContain("human-token");
    expect(humanPublish.publicationForSession(opened.session.id)).toMatchObject({ status: "published", review_id: 123 });
    const replay = await app.request(`/guided/sessions/${opened.session.id}/publish`, {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(replay.status).toBe(303);
    expect(posts).toHaveLength(1);
  });


  it("records poison-alert attention decisions only for permitted collaborators, the exact head, and first writer", async () => {
    const reevaluated: number[] = [];
    let permission = "write";
    const permissionChecks: string[] = [];
    const github = {
      async getRepoInstallation() { return { installationId: 1, accountId: 1001 }; },
      async getRepository() { return { id: 2002, private: false }; },
      async getPull(installationId: number, owner: string, repo: string, prNumber: number) {
        return {
          installationId,
          accountId: 1001,
          repositoryId: 2002,
          repoOwner: owner,
          repoName: repo,
          repoFullName: `${owner}/${repo}`,
          prNumber,
          prTitle: "risk",
          prBody: "",
          prHtmlUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
          prAuthor: "dev",
          baseSha,
          headSha,
          baseRef: "main",
          headRef: "feature",
          draft: false,
          state: "open",
        };
      },
      getCollaboratorPermission: async (_installationId: number, _owner: string, _repo: string, login: string) => {
        permissionChecks.push(login);
        return permission;
      },
    } as ManualTriggerPort;
    const { app, store, db } = guidedTestApp(github, { guidedAttentionReevaluate: async (jobId) => { reevaluated.push(jobId); } });
    const auth = operator(1001);
    const stranger = operator(2002);
    const openedResponse = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(auth.csrfToken));
    const opened = (await openedResponse.json()) as { session: { id: number } };
    const job = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 1,
      prNumber: 12,
      prTitle: "risk",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "dev",
      baseSha,
      headSha,
      baseRef: "main",
      headRef: "feature",
      reviewers: [],
    }).job;
    store.patchJob(job.id, { routing_profile: "poison-alert" });

    const form = new URLSearchParams({ action: "delegate_to_maomao", reasonTag: "risk-review", reasonDetail: "security-sensitive", csrf_token: auth.csrfToken });
    const postDecision = () => app.request(`/guided/sessions/${opened.session.id}/attention`, {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    permission = "read";
    const denied = await postDecision();
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain("cannot release a poison-alert human-attention gate");
    expect(store.guidedAttention.decisionFor({ provider: "github", instance: "github.com", repoFullName: "acme/widgets", prNumber: 12, headSha })).toBeUndefined();

    permission = "write";
    const skipForm = new URLSearchParams({ action: "skip_guided_review", reasonTag: "risk-review", csrf_token: auth.csrfToken });
    const skipDenied = await app.request(`/guided/sessions/${opened.session.id}/attention`, {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: skipForm.toString(),
    });
    expect(skipDenied.status).toBe(400);
    expect(await skipDenied.text()).toContain("optional skip action is not available");
    expect(store.guidedAttention.decisionFor({ provider: "github", instance: "github.com", repoFullName: "acme/widgets", prNumber: 12, headSha })).toBeUndefined();

    const draft = store.configs.createDraft({
      definition: {
        name: "default",
        reviewers: [{ role: "correctness" }],
        minPublishableSeverity: "info",
        guidedReview: { poisonAlertAttention: "optional" },
      },
      createdBy: "octocat",
    });
    if (!("revision" in draft)) throw new Error("optional profile draft failed");
    store.configs.activateRevision(draft.revision.id, "octocat");
    db.prepare(`UPDATE jobs SET profile_revision_id = ? WHERE id = ?`).run(draft.revision.id, job.id);
    const postSkip = () => app.request(`/guided/sessions/${opened.session.id}/attention`, {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: skipForm.toString(),
    });
    const response = await postSkip();
    expect(response.status).toBe(303);
    expect(reevaluated).toEqual([job.id]);
    expect(store.guidedAttention.decisionFor({ provider: "github", instance: "github.com", repoFullName: "acme/widgets", prNumber: 12, headSha })).toMatchObject({ actor_id: "1001", action: "skip_guided_review", head_sha: headSha });

    const strangerOpenedResponse = await postJson(app, "/api/guided-review/sessions/open", stranger.cookies, openBody(stranger.csrfToken));
    const strangerOpened = (await strangerOpenedResponse.json()) as { session: { id: number } };
    const conflictForm = new URLSearchParams({ action: "review_myself", reasonTag: "policy", csrf_token: stranger.csrfToken });
    const conflict = await app.request(`/guided/sessions/${strangerOpened.session.id}/attention`, {
      method: "POST",
      headers: { cookie: stranger.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: conflictForm.toString(),
    });
    expect(conflict.status).toBe(303);
    expect(store.guidedAttention.decisionFor({ provider: "github", instance: "github.com", repoFullName: "acme/widgets", prNumber: 12, headSha })).toMatchObject({ actor_id: "2002", action: "review_myself" });
    const afterSuperseded = new URLSearchParams({ action: "delegate_to_maomao", reasonTag: "risk-review", csrf_token: auth.csrfToken });
    const supersededConflict = await app.request(`/guided/sessions/${opened.session.id}/attention`, {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: afterSuperseded.toString(),
    });
    expect(supersededConflict.status).toBe(409);
    expect(await supersededConflict.text()).toContain("Another exact-SHA human-attention decision already exists");
    const stolen = await app.request(`/guided/sessions/${opened.session.id}/attention`, {
      method: "POST",
      headers: { cookie: stranger.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: conflictForm.toString(),
    });
    expect(stolen.status).toBe(404);
    expect(store.guidedAttention.decisionFor({ provider: "github", instance: "github.com", repoFullName: "acme/widgets", prNumber: 12, headSha: nextHeadSha })).toBeUndefined();
    expect(permissionChecks).toContain("operator-1001");
  });


  it("blocks concurrent retries of a failed publication behind one pending reservation", async () => {
    const posts: string[] = [];
    const githubFetch = async (url: string | URL, init?: RequestInit) => {
      const text = String(url);
      if (text.endsWith("/user")) return Response.json({ id: 1001, login: "operator-1001" });
      if (text.includes("/pulls/12/reviews") && (init?.method ?? "GET") === "GET") return Response.json([]);
      if (text.includes("/pulls/12") && (init?.method ?? "GET") === "GET") return Response.json({ state: "open", head: { sha: headSha } });
      if (text.includes("/pulls/12/reviews") && init?.method === "POST") {
        posts.push(typeof init.body === "string" ? init.body : "");
        await new Promise((resolve) => setTimeout(resolve, 30));
        return Response.json({ id: 123, html_url: "https://github.com/acme/widgets/pull/12#pullrequestreview-123" }, { status: 201 });
      }
      return Response.json({}, { status: 404 });
    };
    const { app, guidedHumanPublish: humanPublish } = guidedTestApp(undefined, { oauthFetch: githubFetch as typeof fetch });
    const auth = operator(1001);
    humanPublish.saveCredential({ actorProvider: "github", actorId: "1001" }, "human-token", "public_repo");
    const openedResponse = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(auth.csrfToken));
    const opened = (await openedResponse.json()) as { session: { id: number; version: number } };
    const updated = await postJson(app, `/api/guided-review/sessions/${opened.session.id}`, auth.cookies, {
      version: opened.session.version,
      draftSummary: "Retry this publication",
      draftVerdict: "COMMENT",
      csrf_token: auth.csrfToken,
    });
    const version = ((await updated.json()) as { session: { version: number } }).session.version;
    const reserved = humanPublish.reservePublication({
      sessionId: opened.session.id,
      actor: { actorProvider: "github", actorId: "1001" },
      repoFullName: "acme/widgets",
      prNumber: 12,
      headSha,
      event: "COMMENT",
      payloadHash: "prior-payload",
    });
    humanPublish.finishPublication(reserved.row.id, "failed", { errorCode: "inline_coordinates_rejected" });

    const form = new URLSearchParams({ version: String(version), confirm: "yes", csrf_token: auth.csrfToken }).toString();
    const request = () => app.request(`/guided/sessions/${opened.session.id}/publish`, {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const [first, second] = await Promise.all([request(), request()]);
    expect([first.status, second.status].sort()).toEqual([303, 409]);
    expect(posts).toHaveLength(1);
    expect(humanPublish.publicationForSession(opened.session.id)?.status).toBe("published");
  });

  it("reclaims only lease-expired pending publications after a crash while fresh pending rows stay blocked", async () => {
    const posts: string[] = [];
    const githubFetch = async (url: string | URL, init?: RequestInit) => {
      const text = String(url);
      if (text.endsWith("/user")) return Response.json({ id: 1001, login: "operator-1001" });
      if (text.includes("/pulls/12/reviews") && (init?.method ?? "GET") === "GET") return Response.json([]);
      if (text.includes("/pulls/12") && (init?.method ?? "GET") === "GET") return Response.json({ state: "open", head: { sha: headSha } });
      if (text.includes("/pulls/12/reviews") && init?.method === "POST") {
        posts.push("");
        return Response.json({ id: 124, html_url: "https://github.com/acme/widgets/pull/12#pullrequestreview-124" }, { status: 201 });
      }
      return Response.json({}, { status: 404 });
    };
    const { app, db, guidedHumanPublish: humanPublish } = guidedTestApp(undefined, { oauthFetch: githubFetch as typeof fetch });
    const auth = operator(1001);
    humanPublish.saveCredential({ actorProvider: "github", actorId: "1001" }, "human-token", "public_repo");
    const openedResponse = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(auth.csrfToken));
    const opened = (await openedResponse.json()) as { session: { id: number; version: number } };
    const updated = await postJson(app, `/api/guided-review/sessions/${opened.session.id}`, auth.cookies, {
      version: opened.session.version,
      draftSummary: "Recover publication",
      draftVerdict: "COMMENT",
      csrf_token: auth.csrfToken,
    });
    const version = ((await updated.json()) as { session: { version: number } }).session.version;
    const reserved = humanPublish.reservePublication({
      sessionId: opened.session.id,
      actor: { actorProvider: "github", actorId: "1001" },
      repoFullName: "acme/widgets",
      prNumber: 12,
      headSha,
      event: "COMMENT",
      payloadHash: "crash-payload",
    });
    const form = new URLSearchParams({ version: String(version), confirm: "yes", csrf_token: auth.csrfToken }).toString();
    const request = () => app.request(`/guided/sessions/${opened.session.id}/publish`, {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });

    const fresh = await request();
    expect(fresh.status).toBe(409);
    expect(posts).toHaveLength(0);

    db.prepare("UPDATE guided_human_publications SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 121_000).toISOString(), reserved.row.id);
    const recovered = await request();
    expect(recovered.status).toBe(303);
    expect(posts).toHaveLength(1);
    expect(humanPublish.publicationForSession(opened.session.id)?.status).toBe("published");
  });

  it("connects a purpose-bound human publication credential with narrow scope, rejects actor mismatch, and revokes on disconnect", async () => {
    const github: ManualTriggerPort = {
      async getRepoInstallation() { return { installationId: 10, accountId: 100 }; },
      async getRepository() { return { id: 200, private: false }; },
      async getPull(installationId: number, owner: string, repo: string, prNumber: number) {
        return {
          installationId,
          accountId: 100,
          repositoryId: 200,
          repoOwner: owner,
          repoName: repo,
          repoFullName: `${owner}/${repo}`,
          prNumber,
          prTitle: "Test pull request",
          prBody: "",
          prHtmlUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
          prAuthor: "author",
          baseSha,
          headSha,
          baseRef: "main",
          headRef: "feature",
          draft: false,
          state: "open",
        };
      },
    };
    let callbackUserId = 1001;
    const oauthFetch = async (url: string | URL, init?: RequestInit) => {
      const text = String(url);
      if (text === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "human-token", scope: "public_repo", expires_in: 3600 });
      }
      if (text === "https://api.github.com/user") return Response.json({ id: callbackUserId, login: `operator-${callbackUserId}`, avatar_url: null });
      return Response.json({}, { status: 404 });
    };
    const oauthEnv = {
      GITHUB_OAUTH_CLIENT_ID: "client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
      MAOMAO_PUBLIC_URL: "https://maomao.example.test",
    };
    const { app, db, guidedHumanPublish: humanPublish } = guidedTestApp(github, { oauthFetch: oauthFetch as typeof fetch }, oauthEnv);
    const auth = operator(1001);
    const connect = await app.request(`/guided/publish/github/connect?next=${encodeURIComponent("/guided/github/acme/widgets/12")}`, { headers: { cookie: auth.cookies } });
    expect(connect.status).toBe(302);
    const authorize = new URL(connect.headers.get("location") ?? "");
    expect(authorize.searchParams.get("scope")).toBe("public_repo");
    const state = authorize.searchParams.get("state") ?? "";
    expect(state).toBeTruthy();

    const callback = await app.request(`/login/github/callback?code=code&state=${encodeURIComponent(state)}`, { headers: { cookie: auth.cookies } });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/guided/github/acme/widgets/12#publish");
    expect(humanPublish.credentialStatus({ actorProvider: "github", actorId: "1001" }).state).toBe("ready");
    const stored = db.prepare("SELECT token_encrypted, scope FROM guided_human_credentials").get() as { token_encrypted: string; scope: string };
    expect(stored.scope).toBe("public_repo");
    expect(stored.token_encrypted).not.toContain("human-token");

    callbackUserId = 2002;
    const mismatchConnect = await app.request(`/guided/publish/github/connect?next=${encodeURIComponent("/guided/github/acme/widgets/12")}`, { headers: { cookie: auth.cookies } });
    const mismatchState = new URL(mismatchConnect.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const mismatch = await app.request(`/login/github/callback?code=code&state=${encodeURIComponent(mismatchState)}`, { headers: { cookie: auth.cookies } });
    expect(mismatch.status).toBe(403);
    expect((db.prepare("SELECT COUNT(*) AS count FROM guided_human_credentials").get() as { count: number }).count).toBe(1);

    const disconnect = await app.request("/guided/publish/github/disconnect", {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded", referer: "https://maomao.example.test/guided" },
      body: new URLSearchParams({ csrf_token: auth.csrfToken }).toString(),
    });
    expect(disconnect.status).toBe(303);
    expect(humanPublish.credentialStatus({ actorProvider: "github", actorId: "1001" }).state).toBe("revoked");

    const openedResponse = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(auth.csrfToken));
    const opened = (await openedResponse.json()) as { session: { id: number; version: number } };
    const updated = await postJson(app, `/api/guided-review/sessions/${opened.session.id}`, auth.cookies, {
      version: opened.session.version,
      draftSummary: "Disconnected credential cannot publish",
      draftVerdict: "COMMENT",
      csrf_token: auth.csrfToken,
    });
    const version = ((await updated.json()) as { session: { version: number } }).session.version;
    const publish = await app.request(`/guided/sessions/${opened.session.id}/publish`, {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ version: String(version), confirm: "yes", csrf_token: auth.csrfToken }).toString(),
    });
    expect(publish.status).toBe(403);
  });


  it("rejects unconfirmed, stale-version, and historical publish attempts before any GitHub review write", async () => {
    const posts: string[] = [];
    const githubFetch = async (url: string | URL, init?: RequestInit) => {
      const text = String(url);
      if (text.endsWith("/user")) return Response.json({ id: 1001, login: "operator-1001" });
      if (text.includes("/pulls/12/reviews") && (init?.method ?? "GET") === "GET") return Response.json([]);
      if (text.includes("/pulls/12") && (init?.method ?? "GET") === "GET") return Response.json({ state: "open", head: { sha: headSha } });
      if (text.includes("/pulls/12/reviews") && init?.method === "POST") {
        posts.push(typeof init.body === "string" ? init.body : "");
        return Response.json({ id: 125, html_url: "https://github.com/acme/widgets/pull/12#pullrequestreview-125" }, { status: 201 });
      }
      return Response.json({}, { status: 404 });
    };
    const { app, guidedHumanPublish: humanPublish } = guidedTestApp(undefined, { oauthFetch: githubFetch as typeof fetch });
    const auth = operator(1001);
    humanPublish.saveCredential({ actorProvider: "github", actorId: "1001" }, "human-token", "public_repo");
    const openedResponse = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(auth.csrfToken));
    const opened = (await openedResponse.json()) as { session: { id: number; version: number } };
    const updated = await postJson(app, `/api/guided-review/sessions/${opened.session.id}`, auth.cookies, {
      version: opened.session.version,
      draftSummary: "Guarded publication",
      draftVerdict: "COMMENT",
      csrf_token: auth.csrfToken,
    });
    const version = ((await updated.json()) as { session: { version: number } }).session.version;
    const publish = (fields: Record<string, string>) => app.request(`/guided/sessions/${opened.session.id}/publish`, {
      method: "POST",
      headers: { cookie: auth.cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });

    const unconfirmed = await publish({ version: String(version), csrf_token: auth.csrfToken });
    expect(unconfirmed.status).toBe(400);
    const staleVersion = await publish({ version: String(version - 1), confirm: "yes", csrf_token: auth.csrfToken });
    expect(staleVersion.status).toBe(409);

    const movedResponse = await postJson(app, "/api/guided-review/sessions/open", auth.cookies, openBody(auth.csrfToken, { headSha: nextHeadSha }));
    expect(movedResponse.status).toBe(200);
    const historical = await publish({ version: String(version), confirm: "yes", csrf_token: auth.csrfToken });
    expect(historical.status).toBe(409);
    expect(posts).toHaveLength(0);
  });

});
