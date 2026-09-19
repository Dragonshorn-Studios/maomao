import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEWER_ROLES, buildAggregatorPrompt, buildReviewerPrompt, promptBodyFromRolePrompt } from "./prompts.js";

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
    expect(prompt).not.toContain("UNTRUSTED USER TEXT");
  });

  it("wraps GitHub discussion as untrusted data in specialist and aggregator prompts", () => {
    const digest = "Untrusted pull-request discussion follows.\n<human-comments>\n- issue @Szefowo: by design\n</human-comments>";
    const reviewer = buildReviewerPrompt({
      role: DEFAULT_REVIEWER_ROLES[0]!,
      repoFullName: "acme/widgets",
      prNumber: 1,
      prTitle: "t",
      prBody: "",
      baseSha: "a",
      headSha: "b",
      author: "dev",
      humanOverrideDigest: digest,
    });
    expect(reviewer).toContain("UNTRUSTED USER TEXT");
    expect(reviewer).toContain(digest);
    const aggregator = buildAggregatorPrompt({
      repoFullName: "acme/widgets",
      prNumber: 1,
      prTitle: "t",
      baseSha: "a",
      headSha: "b",
      reviewerEvidence: [],
      humanOverrideDigest: digest,
    });
    expect(aggregator).toContain("UNTRUSTED USER TEXT");
    expect(aggregator).toContain(digest);
  });
});
