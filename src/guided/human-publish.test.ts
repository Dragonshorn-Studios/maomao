import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { GuidedHumanPublishStore, guidedHumanPublishMarker, submitHumanGitHubReview } from "./human-publish.js";
import type { GuidedPublishPreview } from "./publish-preview.js";

const actor = { actorProvider: "github", actorId: "1001" };
const headSha = "b".repeat(40);

function preview(overrides: Partial<GuidedPublishPreview> = {}): GuidedPublishPreview {
  return {
    target: { provider: "github", instance: "github.com", repoFullName: "acme/widgets", prNumber: 12, baseSha: "a".repeat(40), headSha },
    event: "REQUEST_CHANGES",
    body: `Human summary\n\n${guidedHumanPublishMarker(7)}`,
    comments: [{ path: "src/index.ts", side: "RIGHT", line: 3, body: "Please fix this" }],
    omittedInlineCount: 0,
    unresolvedThreadWarning: true,
    ...overrides,
  };
}

function githubFetch(handlers: { userId?: number; pullHead?: string; postStatus?: number; reviews?: unknown[]; failPost?: boolean; onPost?: (body: string) => void }) {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  return {
    calls,
    fetch: async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const text = typeof init?.body === "string" ? init.body : undefined;
      calls.push({ method, url: String(url), body: text });
      const path = String(url);
      if (path.endsWith("/user")) return Response.json({ id: handlers.userId ?? 1001, login: "human" });
      if (path.includes("/pulls/12/reviews") && method === "GET") return Response.json(handlers.reviews ?? []);
      if (path.includes("/pulls/12") && method === "GET") return Response.json({ state: "open", head: { sha: handlers.pullHead ?? headSha } });
      if (path.includes("/pulls/12/reviews") && method === "POST") {
        if (handlers.failPost) throw new Error("socket timeout");
        handlers.onPost?.(text ?? "");
        if ((handlers.postStatus ?? 201) >= 400) return Response.json({ message: "Validation Failed" }, { status: handlers.postStatus });
        return Response.json({ id: 99, html_url: "https://github.com/acme/widgets/pull/12#pullrequestreview-99" }, { status: 201 });
      }
      return Response.json({}, { status: 404 });
    },
  };
}

describe("GuidedHumanPublishStore", () => {
  it("encrypts credentials at rest and tracks expiry and local revocation", () => {
    const db = openDb(":memory:");
    const store = new GuidedHumanPublishStore(db, "test-secret");
    store.saveCredential(actor, "plain-token", "public_repo", new Date(Date.now() + 60_000).toISOString());
    const raw = db.prepare(`SELECT token_encrypted FROM guided_human_credentials`).get() as { token_encrypted: string };
    expect(raw.token_encrypted).not.toContain("plain-token");
    expect(store.accessToken(actor)).toBe("plain-token");
    store.revokeCredential(actor);
    expect(store.credentialStatus(actor).state).toBe("revoked");
    expect(store.accessToken(actor)).toBeUndefined();
  });
});

describe("submitHumanGitHubReview", () => {
  it("verifies actor, access and exact head before posting the human-authored review", async () => {
    const mock = githubFetch({ onPost(body) {
      const payload = JSON.parse(body) as { commit_id?: string; body?: string; comments?: unknown[] };
      expect(payload.commit_id).toBe(headSha);
      expect(payload.body).toContain("maomao-guided-human-publish:7");
      expect(payload.comments).toHaveLength(1);
    } });
    const result = await submitHumanGitHubReview({ fetchImpl: mock.fetch as typeof fetch, token: "token", actorId: "1001", sessionId: 7, repoFullName: "acme/widgets", prNumber: 12, preview: preview() });
    expect(result).toMatchObject({ status: "published", reviewId: 99 });
    expect(mock.calls.map((call) => `${call.method}:${call.url}`).join("\n")).toContain("POST:https://api.github.com/repos/acme/widgets/pulls/12/reviews");
  });

  it("rejects a changed head before any write", async () => {
    const mock = githubFetch({ pullHead: "c".repeat(40) });
    const result = await submitHumanGitHubReview({ fetchImpl: mock.fetch as typeof fetch, token: "token", actorId: "1001", sessionId: 7, repoFullName: "acme/widgets", prNumber: 12, preview: preview() });
    expect(result).toMatchObject({ status: "failed", errorCode: "head_changed" });
    expect(mock.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("rejects actor mismatch before any write", async () => {
    const mock = githubFetch({ userId: 2002 });
    const result = await submitHumanGitHubReview({ fetchImpl: mock.fetch as typeof fetch, token: "token", actorId: "1001", sessionId: 7, repoFullName: "acme/widgets", prNumber: 12, preview: preview() });
    expect(result).toMatchObject({ status: "failed", errorCode: "actor_mismatch" });
    expect(mock.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("surfaces inline coordinate rejection without silently degrading to a partial review", async () => {
    const mock = githubFetch({ postStatus: 422 });
    const result = await submitHumanGitHubReview({ fetchImpl: mock.fetch as typeof fetch, token: "token", actorId: "1001", sessionId: 7, repoFullName: "acme/widgets", prNumber: 12, preview: preview() });
    expect(result).toMatchObject({ status: "failed", errorCode: "inline_coordinates_rejected" });
  });

  it("recovers a timed-out submission through the idempotency marker instead of duplicating it", async () => {
    const existing = [{ id: 77, html_url: "review-url", body: `x ${guidedHumanPublishMarker(7)}`, user: { id: 1001 } }];
    let visible = false;
    const base = githubFetch({ failPost: true });
    const mock = { calls: base.calls, fetch: async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/pulls/12/reviews") && (init?.method ?? "GET") === "GET") {
        const response = Response.json(visible ? existing : []);
        return response;
      }
      if (String(url).includes("/pulls/12/reviews") && init?.method === "POST") visible = true;
      return base.fetch(url, init);
    } };
    const result = await submitHumanGitHubReview({ fetchImpl: mock.fetch as typeof fetch, token: "token", actorId: "1001", sessionId: 7, repoFullName: "acme/widgets", prNumber: 12, preview: preview() });
    expect(result).toMatchObject({ status: "published", reviewId: 77 });
  });
});
