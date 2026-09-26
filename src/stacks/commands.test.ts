import { describe, expect, it } from "vitest";
import { extractStackBodyMarker, looksLikeStackCommand, parseStackCommand, resolveStackChain, validateStackMembers } from "./commands.js";
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

  it("accepts the trigger without a stack id, colon, or comma separators", () => {
    expect(parseStackCommand("@maomao top of stack : #56, #57")).toEqual({
      kind: "top",
      stackId: undefined,
      prNumbers: [56, 57],
    });
    expect(parseStackCommand("top of stack: #56, #57")).toEqual({
      kind: "top",
      stackId: undefined,
      prNumbers: [56, 57],
    });
    expect(parseStackCommand("top of stack ship-it #56 #57")).toEqual({
      kind: "top",
      stackId: "ship-it",
      prNumbers: [56, 57],
    });
    expect(parseStackCommand("top of stack ship-it: #56, and #57")).toEqual({
      kind: "top",
      stackId: "ship-it",
      prNumbers: [56, 57],
    });
  });

  it("parses start/end stack commands", () => {
    expect(parseStackCommand("@maomao start of stack 6f9e2c")).toEqual({ kind: "start", stackId: "6f9e2c" });
    expect(parseStackCommand("start of stack")).toEqual({ kind: "start", stackId: undefined });
    expect(parseStackCommand("@maomao end of stack 6f9e2c")).toEqual({ kind: "end", stackId: "6f9e2c" });
    expect(parseStackCommand("end of stack")).toEqual({ kind: "end", stackId: undefined });
  });

  it("detects malformed stack commands for a usage reply", () => {
    expect(looksLikeStackCommand("top of stack : broken")).toBe(true);
    expect(looksLikeStackCommand("issue 5 of 5 in stack")).toBe(true);
    // Prose that mentions an "issue X of Y" form without "in stack" is not intent.
    expect(looksLikeStackCommand("issue 2 of 3 tasks left")).toBe(false);
    expect(looksLikeStackCommand("issue 1 of 4 pages")).toBe(false);
    expect(looksLikeStackCommand("end of stack : #41")).toBe(true);
    // A free-form tail reads as prose, not a mangled command.
    expect(looksLikeStackCommand("end of stack traces are hard to debug")).toBe(false);
    expect(looksLikeStackCommand("end of stack extra words")).toBe(false);
    expect(looksLikeStackCommand("please review the stack")).toBe(false);
    expect(looksLikeStackCommand("LGTM")).toBe(false);
  });

  it("rejects prose that merely contains the words", () => {
    expect(parseStackCommand("please review issue 2 of 3 in stack x")).toBeNull();
    expect(parseStackCommand("issue 0 of 3 in stack x")).toBeNull();
    expect(parseStackCommand("issue 4 of 3 in stack x")).toBeNull();
    expect(parseStackCommand("top of stack x:")).toBeNull();
    expect(parseStackCommand("top of stack x: #1")).toBeNull();
    expect(parseStackCommand("top of stack x: #1, #1")).toBeNull();
    expect(parseStackCommand("top of stack x: #1, abc")).toBeNull();
    expect(parseStackCommand("start of stack a b")).toBeNull();
    expect(parseStackCommand("")).toBeNull();
  });
});

describe("resolveStackChain", () => {
  const openPulls = () => [
    pull({ prNumber: 41, baseRef: "main", headRef: "feat-a" }),
    pull({ prNumber: 42, baseRef: "feat-a", headRef: "feat-b" }),
    pull({ prNumber: 43, baseRef: "feat-b", headRef: "feat-c" }),
    pull({ prNumber: 99, baseRef: "main", headRef: "unrelated" }),
  ];

  it("walks the branch chain from the end PR down to the start PR", () => {
    const result = resolveStackChain({ pulls: openPulls(), startPrNumber: 41, endPrNumber: 43 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pulls.map((p) => p.prNumber)).toEqual([41, 42, 43]);
  });

  it("walks to the natural base when no start is given", () => {
    const result = resolveStackChain({ pulls: openPulls(), endPrNumber: 43 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pulls.map((p) => p.prNumber)).toEqual([41, 42, 43]);
  });

  it("fails when the chain breaks before the declared start", () => {
    const pulls = [pull({ prNumber: 41, baseRef: "main", headRef: "feat-a" }), pull({ prNumber: 43, baseRef: "feat-b", headRef: "feat-c" })];
    const result = resolveStackChain({ pulls, startPrNumber: 41, endPrNumber: 43 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/feat-b.*broken|broken.*feat-b/i);
  });

  it("fails on an ambiguous fork in the chain", () => {
    const pulls = [...openPulls(), pull({ prNumber: 44, baseRef: "main", headRef: "feat-b" })];
    const result = resolveStackChain({ pulls, startPrNumber: 41, endPrNumber: 43 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ambiguous/i);
  });

  it("rejects a stack of one and a missing start", () => {
    expect(resolveStackChain({ pulls: openPulls(), startPrNumber: 41, endPrNumber: 41 }).ok).toBe(false);
    expect(resolveStackChain({ pulls: openPulls(), startPrNumber: 55, endPrNumber: 43 }).ok).toBe(false);
    expect(resolveStackChain({ pulls: [pull({ prNumber: 9, baseRef: "main", headRef: "x" })], endPrNumber: 9 }).ok).toBe(false);
  });

  it("stops the natural-bottom walk at a start-declaring PR", () => {
    // #80's head IS the stack's base branch — without the marker boundary it
    // would be spliced in under whatever stack it happens to declare.
    const foreign = pull({ prNumber: 80, baseRef: "release", headRef: "main" });
    const result = resolveStackChain({ pulls: [...openPulls(), foreign], startPrNumbers: new Set([41]), endPrNumber: 43 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pulls.map((p) => p.prNumber)).toEqual([41, 42, 43]);
  });

  it("ignores a fork PR based on the top's head branch", () => {
    const forkOnTop = pull({ prNumber: 77, baseRef: "feat-c", headRef: "fork-x", headRepoFullName: "mallory/widgets" });
    const result = resolveStackChain({ pulls: [...openPulls(), forkOnTop], startPrNumber: 41, endPrNumber: 43 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pulls.map((p) => p.prNumber)).toEqual([41, 42, 43]);
  });

  it("excludes a PR whose head repo was deleted", () => {
    // headRepoFullName null = deleted fork: without exclusion it would make
    // the 'feat-b' head match ambiguous.
    const ghost = pull({ prNumber: 78, baseRef: "main", headRef: "feat-b", headRepoFullName: null });
    const result = resolveStackChain({ pulls: [...openPulls(), ghost], startPrNumber: 41, endPrNumber: 43 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pulls.map((p) => p.prNumber)).toEqual([41, 42, 43]);
  });

  it("fails once the chain exceeds 100 pull requests", () => {
    const many = [pull({ prNumber: 1, baseRef: "main", headRef: "b1" })];
    for (let i = 2; i <= 101; i++) many.push(pull({ prNumber: i, baseRef: `b${i - 1}`, headRef: `b${i}` }));
    const result = resolveStackChain({ pulls: many, endPrNumber: 101 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/exceeds 100/);
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

describe("extractStackBodyMarker", () => {
  it("finds a marker on its own line inside a prose body", () => {
    expect(extractStackBodyMarker("Adds a thing.\n\n<!-- start of stack u1 -->\nMore text."))
      .toEqual({ kind: "start", stackId: "u1" });
    expect(extractStackBodyMarker("<!-- end of stack -->")).toEqual({ kind: "end", stackId: undefined });
    expect(extractStackBodyMarker("<!-- part of stack u1 -->")).toEqual({ kind: "part", stackId: "u1" });
    expect(extractStackBodyMarker("<!-- issue 2 of 3 in stack u1 -->")).toEqual({ kind: "declare", stackId: "u1", position: 2, expectedCount: 3 });
  });

  it("requires the HTML-comment wrapper or a leading @mention — bare lines are prose", () => {
    expect(extractStackBodyMarker("Adds a thing.\n\nstart of stack u1")).toBeNull();
    expect(extractStackBodyMarker("end of stack u1")).toBeNull();
    expect(extractStackBodyMarker("part of stack u1")).toBeNull();
    expect(extractStackBodyMarker("part of stack traces and the heap")).toBeNull();
    expect(extractStackBodyMarker("end of stack overflow handling")).toBeNull();
    expect(extractStackBodyMarker("@maomao end of stack u1")).toEqual({ kind: "end", stackId: "u1" });
    // A promoted top PR keeps its old 'part' line: the 'end' marker wins.
    expect(extractStackBodyMarker("<!-- part of stack u1 -->\n<!-- end of stack u1 -->")).toEqual({ kind: "end", stackId: "u1" });
    expect(extractStackBodyMarker("@devin-ai-integration[bot] issue 1 of 2 in stack u1"))
      .toEqual({ kind: "declare", stackId: "u1", position: 1, expectedCount: 2 });
  });

  it("ignores prose that merely mentions the phrases mid-line", () => {
    expect(extractStackBodyMarker("This is the start of stack work.\nPlease review.")).toBeNull();
    expect(extractStackBodyMarker("no markers here")).toBeNull();
    expect(extractStackBodyMarker("")).toBeNull();
  });

  it("flags a malformed marker line as invalid", () => {
    expect(extractStackBodyMarker("Body.\n<!-- end of stack : with junk -->")).toEqual({ kind: "invalid" });
  });
});

describe("resolveStackChain boundaries", () => {
  const chain = () => [
    pull({ prNumber: 41, baseRef: "main", headRef: "feat-a" }),
    pull({ prNumber: 42, baseRef: "feat-a", headRef: "feat-b" }),
    pull({ prNumber: 43, baseRef: "feat-b", headRef: "feat-c" }),
  ];

  it("rejects an end PR that is not the top of its stack", () => {
    const pulls = [...chain(), pull({ prNumber: 44, baseRef: "feat-c", headRef: "feat-d" })];
    const result = resolveStackChain({ pulls, startPrNumber: 41, endPrNumber: 43 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not the top.*#44/);
  });

  it("rejects a declared start that is not the bottom of its stack", () => {
    const pulls = [pull({ prNumber: 40, baseRef: "dev", headRef: "main" }), ...chain()];
    const result = resolveStackChain({ pulls, startPrNumber: 41, endPrNumber: 43 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not the bottom/);
  });

  it("rejects a cyclic branch chain", () => {
    // The cycle sits below the end PR: 44 bases into the 42⇄43 loop.
    const pulls = [
      pull({ prNumber: 42, baseRef: "feat-b", headRef: "feat-a" }),
      pull({ prNumber: 43, baseRef: "feat-a", headRef: "feat-b" }),
      pull({ prNumber: 44, baseRef: "feat-b", headRef: "feat-d" }),
      pull({ prNumber: 45, baseRef: "feat-d", headRef: "feat-e" }),
    ];
    const result = resolveStackChain({ pulls, endPrNumber: 45 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/loops back/);
  });

  it("rejects a chain over 100 pull requests", () => {
    const pulls = Array.from({ length: 103 }, (_, i) =>
      pull({ prNumber: i + 1, baseRef: i === 0 ? "main" : `b${i}`, headRef: `b${i + 1}` }),
    );
    const result = resolveStackChain({ pulls, endPrNumber: 103 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/exceeds 100/);
  });
});
