import { describe, expect, it } from "vitest";
import { CSRF_COOKIE, SESSION_COOKIE, issueCsrfToken, signOAuthSession, signSession } from "../auth.js";
import { loadConfig } from "../config.js";
import { openDb } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { JobStore } from "../jobs/store.js";
import { createApp } from "../server.js";
import type { ManualTriggerPort } from "../github/client.js";

const secret = "guided-review-test-secret";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const nextHeadSha = "c".repeat(40);

function guidedTestApp(github?: ManualTriggerPort) {
  const config = loadConfig({
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "k",
    REVIEWER_ROLES: "correctness",
    UI_PASSWORD: "hunter2",
    UI_SESSION_SECRET: secret,
    MAOMAO_ADMIN_GITHUB_IDS: "1001,2002",
  });
  const store = new JobStore(openDb(":memory:"));
  const queue = { enqueue() {}, abortMany() {} } as unknown as JobQueue;
  return { app: createApp({ config, store, queue, github, startedAt: Date.now(), env: {} }), store };
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
});
