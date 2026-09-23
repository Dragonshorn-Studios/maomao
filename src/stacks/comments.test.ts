import { describe, expect, it } from "vitest";
import { renderStackComment, stackCommentMarker, upsertStackComment } from "./comments.js";

const members = [
  { position: 1, prNumber: 41, headSha: "h41aaaaaa" },
  { position: 2, prNumber: 42, headSha: "h42bbbbbb" },
];

describe("renderStackComment", () => {
  it("names the member's position and marks its own row", () => {
    const body = renderStackComment({ stackId: "ship-it", selfPrNumber: 42, expectedCount: 2, members });
    expect(body).toContain(stackCommentMarker("ship-it"));
    expect(body).toContain("issue 2 of 2");
    expect(body).toContain("**#42** 🍃");
    expect(body).toContain("#41");
    expect(body).toContain("top of the stack");
    expect(body).toContain("h42bbbbb");
  });

  it("handles a partial member list before the full stack is known", () => {
    const body = renderStackComment({
      stackId: "ship-it",
      selfPrNumber: 41,
      expectedCount: 3,
      members: [{ position: 1, prNumber: 41 }],
    });
    expect(body).toContain("issue 1 of 3");
    expect(body).not.toContain("#42");
  });
});

describe("upsertStackComment", () => {
  const github = (comments: { id: number; body: string }[], posted: string[], updated: string[]) => ({
    listIssueComments: async () => comments.map((c) => ({ id: c.id, body: c.body })),
    createIssueComment: async (input: { body: string }) => {
      posted.push(input.body);
      return { id: "9", url: "u" };
    },
    updateIssueComment: async (input: { commentId: number; body: string }) => {
      updated.push(input.body);
      const target = comments.find((c) => c.id === input.commentId);
      if (target) target.body = input.body;
      return { id: String(input.commentId), url: "u" };
    },
  });

  const args = {
    installationId: 1,
    repoOwner: "acme",
    repoName: "widgets",
    selfPrNumber: 41,
    stackId: "ship-it",
    expectedCount: 2,
    members,
  };

  it("creates the marker comment when none exists", async () => {
    const posted: string[] = [];
    const updated: string[] = [];
    await upsertStackComment({ ...args, github: github([], posted, updated) });
    expect(posted).toHaveLength(1);
    expect(updated).toHaveLength(0);
  });

  it("edits the existing marker comment in place", async () => {
    const existing = [{ id: 7, body: `${stackCommentMarker("ship-it")}\nold` }];
    const posted: string[] = [];
    const updated: string[] = [];
    await upsertStackComment({ ...args, github: github(existing, posted, updated) });
    expect(posted).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(existing[0]?.body).toContain("issue 1 of 2");
  });

  it("skips the edit when the rendered body is unchanged", async () => {
    const body = renderStackComment(args);
    const posted: string[] = [];
    const updated: string[] = [];
    await upsertStackComment({ ...args, github: github([{ id: 7, body }], posted, updated) });
    expect(posted).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });
});
