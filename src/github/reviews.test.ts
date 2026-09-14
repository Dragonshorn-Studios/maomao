import { describe, expect, it } from "vitest";
import { buildReviewBody, findExistingReview, toInlineComments } from "./client.js";
import { reviewMarker } from "../prompts.js";

describe("GitHub review payload", () => {
  it("always builds a COMMENT-oriented body anchored to the SHA", () => {
    const body = buildReviewBody({
      headSha: "abc123",
      summary: "Looks fine.",
      findingsCount: 0,
      reviewerCount: 6,
    });
    expect(body).toContain(reviewMarker("abc123"));
    expect(body).toContain("abc123");
    expect(body.toLowerCase()).not.toContain("event: approve");
  });

  it("caps inline comments and skips findings without locations", () => {
    const comments = toInlineComments(
      [
        { file: "a.ts", line: 1, summary: "one", severity: "high" },
        { summary: "no loc", severity: "low" },
        { file: "b.ts", line: 2, summary: "two", severity: "medium" },
      ],
      1,
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]?.path).toBe("a.ts");
    expect(comments[0]?.side).toBe("RIGHT");
  });

  it("detects an already posted Maomao review for the SHA", () => {
    const existing = findExistingReview(
      [{ id: 9, body: `${reviewMarker("deadbeef")}\nhello`, htmlUrl: "https://example.test/r" }],
      "deadbeef",
    );
    expect(existing?.id).toBe("9");
    expect(findExistingReview([{ id: 1, body: "unrelated" }], "deadbeef")).toBeUndefined();
  });
});
