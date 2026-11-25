import { describe, expect, it } from "vitest";
import { findingMarker } from "../findings/identity.js";
import { loadConfig } from "../config.js";
import {
  buildIssueSearchQuery,
  GithubClient,
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


describe("GithubClient.upsertCheckRun", () => {
  function clientWithChecks(checks: {
    listForRef: (input: Record<string, unknown>) => Promise<{ data: { check_runs: unknown[]; total_count?: number } }>;
    create: (input: Record<string, unknown>) => Promise<{ data: { id: number; html_url?: string } }>;
    update: (input: Record<string, unknown>) => Promise<{ data: { id: number; html_url?: string } }>;
  }) {
    const client = new GithubClient(loadConfig({ GITHUB_APP_ID: "1" }));
    (client as unknown as { installationOctokit: () => unknown }).installationOctokit = () => ({
      rest: { checks: checks },
    });
    return client;
  }

  const input = {
    installationId: 9,
    owner: "acme",
    repo: "widgets",
    headSha: "abc123",
    name: "maomao/review",
    externalId: "maomao-review-external",
    status: "completed" as const,
    conclusion: "success" as const,
    title: "passed",
    summary: "clean",
  };

  it("creates rather than hijacking a same-named check with a different external id", async () => {
    const calls = { create: 0, update: 0 };
    const client = clientWithChecks({
      listForRef: async () => ({
        data: { check_runs: [{ id: 1, name: "maomao/review", external_id: input.externalId, app: { id: 2 } }] },
      }),
      create: async () => {
        calls.create += 1;
        return { data: { id: 2, html_url: "https://example.test/checks/2" } };
      },
      update: async () => {
        calls.update += 1;
        return { data: { id: 1 } };
      },
    });

    await expect(client.upsertCheckRun(input)).resolves.toEqual({ id: "2", url: "https://example.test/checks/2" });
    expect(calls).toEqual({ create: 1, update: 0 });
  });

  it("paginates and updates the newest run with the stable external id", async () => {
    const pages: unknown[] = [];
    let updateInput: Record<string, unknown> | undefined;
    const filler = Array.from({ length: 100 }, (_, index) => ({ id: index + 10, external_id: `other-${index}` }));
    const client = clientWithChecks({
      listForRef: async (request) => {
        pages.push(request.page);
        return {
          data: {
            total_count: 102,
            check_runs:
              request.page === 1
                ? filler
                : [
                    { id: 200, external_id: input.externalId, app: { id: 1 } },
                    { id: 201, external_id: input.externalId, app: { id: 1 } },
                  ],
          },
        };
      },
      create: async () => ({ data: { id: 2 } }),
      update: async (request) => {
        updateInput = request;
        return { data: { id: Number(request.check_run_id), html_url: "https://example.test/checks/201" } };
      },
    });

    await expect(client.upsertCheckRun(input)).resolves.toEqual({ id: "201", url: "https://example.test/checks/201" });
    expect(pages).toEqual([1, 2]);
    expect(updateInput).toMatchObject({
      check_run_id: 201,
      external_id: input.externalId,
      status: "completed",
      conclusion: "success",
    });
  });
});

describe("GithubClient.getMergeCapabilities", () => {
  function clientWithGraphql(repository: unknown, protection?: { data?: unknown; error?: unknown }, observeVariables?: (variables: Record<string, unknown>) => void) {
    const client = new GithubClient(loadConfig({ GITHUB_APP_ID: "1" }));
    (client as unknown as { installationOctokit: () => unknown }).installationOctokit = () => ({
      graphql: async (_query: string, variables: Record<string, unknown>) => {
        observeVariables?.(variables);
        return { repository };
      },
      rest: {
        repos: {
          getBranchProtection: async () => {
            if (protection?.error) throw protection.error;
            return { data: protection?.data ?? {} };
          },
        },
      },
    });
    return client;
  }

  it("reports native queue, auto-merge, and matching protection as read-only capabilities", async () => {
    let variables: Record<string, unknown> | undefined;
    const client = clientWithGraphql({
      autoMergeAllowed: true,
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: false,
      mergeQueue: { url: "https://github.com/acme/widgets/queue/main" },
      pullRequest: { state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" },
    }, {
      data: {
        required_status_checks: { checks: [{ context: "test" }, { context: "maomao/merge-readiness" }] },
        required_pull_request_reviews: { required_approving_review_count: 2 },
      },
    }, (seen) => { variables = seen; });
    expect(variables).toBeUndefined();
    await expect(client.getMergeCapabilities(9, "acme", "widgets", "main", 7)).resolves.toMatchObject({
      mergeMode: "manual",
      nativeAutoMerge: "available",
      githubNativeQueue: "available",
      requiredStatusContexts: ["maomao/merge-readiness", "test"],
      requiredApprovals: 2,
      protectedBranch: true,
      mergeMethods: ["merge", "squash"],
      source: "github-graphql+rest",
      pullState: "OPEN",
      mergeable: "BLOCKED",
    });
    expect(variables).toMatchObject({ owner: "acme", repo: "widgets", branch: "main", pullNumber: 7 });
  });

  it("explains missing native queue and protection without enabling writes", async () => {
    const client = clientWithGraphql({ autoMergeAllowed: false, mergeQueue: null }, { error: Object.assign(new Error("not found"), { status: 404 }) });
    const capabilities = await client.getMergeCapabilities(9, "acme", "widgets", "main", 7);
    expect(capabilities).toMatchObject({ mergeMode: "manual", nativeAutoMerge: "unavailable", githubNativeQueue: "unavailable", requiredStatusContexts: [], protectedBranch: false });
    expect(capabilities.reasons.join(" ")).toContain("merge queue is not configured");
    expect(capabilities.reasons.join(" ")).toContain("No exact branch protection");
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
