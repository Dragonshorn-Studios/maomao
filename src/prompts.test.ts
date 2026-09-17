import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEWER_ROLES, buildAggregatorPrompt, promptBodyFromRolePrompt } from "./prompts.js";

function roleBody(id: string): string {
  const role = DEFAULT_REVIEWER_ROLES.find((item) => item.id === id);
  if (!role) throw new Error(`missing role ${id}`);
  return promptBodyFromRolePrompt(role.prompt);
}

describe("default review prompts", () => {
  it("tells the tests specialist to emit one low/info missing-coverage comment, not a cluster", () => {
    const body = roleBody("tests");
    expect(body).toContain("All low or info missing-coverage notes MUST be a single finding");
    expect(body).toContain("Omit file and line");
    expect(body).toContain("Raise severity to medium only when the untested path can close a GitHub thread");
  });

  it("keeps architecture nits at low/info and out of merge advice", () => {
    const body = roleBody("architecture");
    expect(body).toContain("nits (low or info)");
    expect(body).toContain("Do not file architecture nits as merge advice");
  });

  it("asks the aggregator to fold advisory missing-test notes into one non-inline finding", () => {
    const prompt = buildAggregatorPrompt({
      repoFullName: "Dragonshorn-Studios/maomao",
      prNumber: 58,
      prTitle: "Document Contents write",
      baseSha: "aaa",
      headSha: "bbb",
      reviewerEvidence: [],
    });
    expect(prompt).toContain("exactly one finding, never a cluster of inline comments");
    expect(prompt).toContain("Omit file and line on that finding");
    expect(prompt).toContain("quote the `if` that skips");
  });
});
