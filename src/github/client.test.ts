import { describe, expect, it } from "vitest";
import { findingMarker } from "../findings/identity.js";
import {
  buildIssueSearchQuery,
  createReviewWithFallback,
  findingComment,
  parseThreadFindingMarker,
} from "./client.js";
import type { PullReviewComment, ReviewThread } from "./client.js";

describe("buildIssueSearchQuery", () => {
  it("scopes the search to the repository and open issues", () => {
    expect(buildIssueSearchQuery("acme", "widgets", "secret logged")).toBe(
      "repo:acme/widgets is:issue is:open secret logged",
    );
  });

  it("strips control qualifiers so the caller cannot widen the search", () => {
    // Stripping qualifiers leaves ordinary terms (extra internal spaces are
    // harmless to GitHub search); the repo scope stays intact.
    expect(buildIssueSearchQuery("acme", "widgets", 'secret repo:other/repo "quoted"')).toBe(
      "repo:acme/widgets is:issue is:open secret repo other/repo  quoted",
    );
  });

  it("trims stray whitespace from the caller terms", () => {
    expect(buildIssueSearchQuery("acme", "widgets", "   ")).toBe("repo:acme/widgets is:issue is:open ");
  });
});

describe("finding thread markers", () => {
  it("finds the marker even when a reply is listed first", () => {
    const marker = findingMarker("deadbeefdeadbeef", "abc");
    const thread: ReviewThread = {
      id: "PRRT_1",
      isResolved: true,
      comments: [
        { id: "c-reply", databaseId: 2, body: "thanks" },
        { id: "c-root", databaseId: 1, body: `${marker}\n**high**: leak` },
      ],
    };
    expect(parseThreadFindingMarker(thread)).toEqual({ id: "deadbeefdeadbeef", sha: "abc" });
    expect(findingComment(thread)?.databaseId).toBe(1);
  });
});

describe("createReviewWithFallback", () => {
  const comments: PullReviewComment[] = [
    { path: "a.ts", line: 1, body: "c1" },
    { path: "b.ts", line: 2, body: "c2" },
  ];

  it("returns the accepted comments on success", async () => {
    const calls: Array<{ count: number; body: string }> = [];
    const posted = await createReviewWithFallback({
      comments,
      body: "review",
      post: async (sent, body) => {
        calls.push({ count: sent.length, body });
        return { id: 7, url: "https://example.test/r/7" };
      },
    });
    expect(posted).toEqual({ id: "7", url: "https://example.test/r/7", postedComments: comments });
    expect(calls).toEqual([{ count: 2, body: "review" }]);
  });

  it("falls back to a body-only review when GitHub rejects the inline locations", async () => {
    const calls: Array<{ count: number; body: string }> = [];
    let attempt = 0;
    const posted = await createReviewWithFallback({
      comments,
      body: "review",
      post: async (sent, body) => {
        attempt += 1;
        calls.push({ count: sent.length, body });
        if (attempt === 1) throw new Error("Validation Failed: line is not part of the diff");
        return { id: 8, url: "https://example.test/r/8" };
      },
    });
    expect(posted).toEqual({ id: "8", url: "https://example.test/r/8", postedComments: [] });
    expect(calls[1]?.count).toBe(0);
    expect(calls[1]?.body).toContain("review");
    expect(calls[1]?.body).toContain("Inline comments were omitted");
  });

  it("rethrows the original error when the fallback post also fails", async () => {
    await expect(
      createReviewWithFallback({
        comments,
        body: "review",
        post: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
  });

  it("does not retry when there were no inline comments", async () => {
    let calls = 0;
    await expect(
      createReviewWithFallback({
        comments: [],
        body: "review",
        post: async () => {
          calls += 1;
          throw new Error("nope");
        },
      }),
    ).rejects.toThrow("nope");
    expect(calls).toBe(1);
  });
});
