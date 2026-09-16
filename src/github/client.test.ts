import { describe, expect, it } from "vitest";
import { findingMarker } from "../findings/identity.js";
import { buildIssueSearchQuery, findingComment, parseThreadFindingMarker } from "./client.js";
import type { ReviewThread } from "./client.js";

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
