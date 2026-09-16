import { describe, expect, it } from "vitest";
import { buildIssueSearchQuery } from "./client.js";

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
