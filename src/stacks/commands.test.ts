import { describe, expect, it } from "vitest";
import { parseStackCommand, validateStackMembers } from "./commands.js";
import type { ResolvedPull } from "../github/client.js";
import type { StackDeclarationRow } from "../jobs/store.js";

function pull(overrides: Partial<ResolvedPull> = {}): ResolvedPull {
  return {
    installationId: 42,
    accountId: 1001,
    repositoryId: 2002,
    repoOwner: "acme",
    repoName: "widgets",
    repoFullName: "acme/widgets",
    prNumber: 1,
    prTitle: "t",
    prBody: "",
    prHtmlUrl: "https://github.com/acme/widgets/pull/1",
    prAuthor: "octocat",
    baseSha: "baseaaa",
    headSha: "headaaa",
    baseRef: "main",
    headRef: "feat-a",
    draft: false,
    ...overrides,
  };
}

function decl(overrides: Partial<StackDeclarationRow> = {}): StackDeclarationRow {
  return {
    id: 1,
    provider: "github",
    provider_instance: "github.com",
    repo_full_name: "acme/widgets",
    stack_id: "ship-it",
    pr_number: 1,
    position: 1,
    expected_count: 2,
    actor: "alice",
    comment_id: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("parseStackCommand", () => {
  it("parses a bare declaration", () => {
    expect(parseStackCommand("issue 2 of 3 in stack ship-it")).toEqual({
      kind: "declare",
      stackId: "ship-it",
      position: 2,
      expectedCount: 3,
    });
  });

  it("parses a declaration with an app mention", () => {
    expect(parseStackCommand("@maomao issue 1 of 2 in stack my-stack.1")).toEqual({
      kind: "declare",
      stackId: "my-stack.1",
      position: 1,
      expectedCount: 2,
    });
  });

  it("parses the top-of-stack trigger", () => {
    expect(parseStackCommand("@maomao top of stack ship-it: #41, #42, #43")).toEqual({
      kind: "top",
      stackId: "ship-it",
      prNumbers: [41, 42, 43],
    });
  });

  it("rejects prose that merely contains the words", () => {
    expect(parseStackCommand("please review issue 2 of 3 in stack x")).toBeNull();
    expect(parseStackCommand("issue 0 of 3 in stack x")).toBeNull();
    expect(parseStackCommand("issue 4 of 3 in stack x")).toBeNull();
    expect(parseStackCommand("top of stack x:")).toBeNull();
    expect(parseStackCommand("top of stack x: #1")).toBeNull();
    expect(parseStackCommand("top of stack x: #1, #1")).toBeNull();
    expect(parseStackCommand("top of stack x: #1, abc")).toBeNull();
    expect(parseStackCommand("")).toBeNull();
  });
});

describe("validateStackMembers", () => {
  const members = () => [
    pull({ prNumber: 41, baseRef: "main", headRef: "feat-a", baseSha: "m0", headSha: "h41" }),
    pull({ prNumber: 42, baseRef: "feat-a", headRef: "feat-b", baseSha: "h41", headSha: "h42" }),
  ];
  const declarations = () => [
    decl({ pr_number: 41, position: 1 }),
    decl({ pr_number: 42, position: 2 }),
  ];

  it("accepts a fully declared, correctly chained stack and pins the SHAs", () => {
    const result = validateStackMembers({
      stackId: "ship-it",
      prNumbers: [41, 42],
      pulls: members(),
      declarations: declarations(),
      repoFullName: "acme/widgets",
      commentPrNumber: 42,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.members.map((m) => m.prNumber)).toEqual([41, 42]);
      expect(result.members[1]?.headSha).toBe("h42");
      expect(result.members[0]?.baseSha).toBe("m0");
    }
  });

  it("requires the trigger to land on the top PR", () => {
    const result = validateStackMembers({
      stackId: "ship-it",
      prNumbers: [41, 42],
      pulls: members(),
      declarations: declarations(),
      repoFullName: "acme/widgets",
      commentPrNumber: 41,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/top PR/i);
  });

  it("requires every member to be declared at its listed position", () => {
    const undeclared = validateStackMembers({
      stackId: "ship-it",
      prNumbers: [41, 42],
      pulls: members(),
      declarations: [decl({ pr_number: 41, position: 1 })],
      repoFullName: "acme/widgets",
      commentPrNumber: 42,
    });
    expect(undeclared.ok).toBe(false);

    const wrongPosition = validateStackMembers({
      stackId: "ship-it",
      prNumbers: [41, 42],
      pulls: members(),
      declarations: [decl({ pr_number: 41, position: 2 }), decl({ pr_number: 42, position: 2 })],
      repoFullName: "acme/widgets",
      commentPrNumber: 42,
    });
    expect(wrongPosition.ok).toBe(false);
    if (!wrongPosition.ok) expect(wrongPosition.error).toMatch(/position/i);
  });

  it("requires a consistent declared count", () => {
    const result = validateStackMembers({
      stackId: "ship-it",
      prNumbers: [41, 42],
      pulls: members(),
      declarations: [decl({ pr_number: 41, position: 1, expected_count: 3 }), decl({ pr_number: 42, position: 2 })],
      repoFullName: "acme/widgets",
      commentPrNumber: 42,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/count|declared as issue/i);
  });

  it("requires the dependency chain", () => {
    const result = validateStackMembers({
      stackId: "ship-it",
      prNumbers: [41, 42],
      pulls: [
        pull({ prNumber: 41, baseRef: "main", headRef: "feat-a", headSha: "h41" }),
        pull({ prNumber: 42, baseRef: "main", headRef: "feat-b", headSha: "h42" }),
      ],
      declarations: declarations(),
      repoFullName: "acme/widgets",
      commentPrNumber: 42,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/dependency order/i);
  });

  it("rejects members outside the repository", () => {
    const result = validateStackMembers({
      stackId: "ship-it",
      prNumbers: [41, 42],
      pulls: [pull({ prNumber: 41 }), pull({ prNumber: 42, repoFullName: "acme/other", baseRef: "feat-a" })],
      declarations: declarations(),
      repoFullName: "acme/widgets",
      commentPrNumber: 42,
    });
    expect(result.ok).toBe(false);
  });
});
