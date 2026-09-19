import { describe, expect, it } from "vitest";
import {
  buildReviewBody,
  findExistingReview,
  inlineCommentFingerprints,
  selectInlineComments,
  toInlineComments,
} from "./client.js";
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
      "abc123",
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]?.path).toBe("a.ts");
    expect(comments[0]?.side).toBe("RIGHT");
    expect(comments[0]?.body).toContain("maomao-finding");
    expect(comments[0]?.body).toContain("sha=abc123");
  });

  it("extracts fingerprints from posted inline comments", () => {
    const comments = toInlineComments(
      [{ file: "a.ts", line: 1, summary: "one", severity: "high", fingerprint: "abcdabcdabcdabcd" }],
      12,
      "abc123",
    );
    expect(inlineCommentFingerprints(comments)).toEqual(["abcdabcdabcdabcd"]);
  });

  it("detects an already posted Maomao review for the SHA", () => {
    const existing = findExistingReview(
      [{ id: "9", body: `${reviewMarker("deadbeef")}\nhello`, htmlUrl: "https://example.test/r" }],
      "deadbeef",
    );
    expect(existing?.id).toBe("9");
    expect(findExistingReview([{ id: "1", body: "unrelated" }], "deadbeef")).toBeUndefined();
  });
});

describe("inline comment selection", () => {
  // Hunk body: keep (old 5 / new 5), two deletions (old 6, 7), keep (old 8 / new 6);
  // line 7 only exists on the old side, line 99 in neither.
  const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -5,4 +5,2 @@
 keep
-gone six
-gone seven
 keep
`;

  it("keeps anchorable findings inline and demotes the rest with a reason", () => {
    const { comments, demoted } = selectInlineComments(
      [
        { file: "src/app.ts", line: 5, summary: "anchored", severity: "high" },
        { file: "src/app.ts", line: 99, summary: "floating", severity: "medium" },
        { file: "src/app.ts", line: 7, summary: "on a deleted line", severity: "low" },
        { summary: "no location", severity: "low" },
      ],
      { limit: 12, headSha: "abc123", diff },
    );
    expect(comments.map((c) => `${c.path}:${c.line}:${c.side}`)).toEqual([
      "src/app.ts:5:RIGHT",
      "src/app.ts:7:LEFT",
    ]);
    expect(comments[0]?.body).toContain("sha=abc123");
    expect(demoted).toHaveLength(1);
    expect(demoted[0]?.reason).toBe("outside_hunk");
    expect(demoted[0]?.finding.summary).toBe("floating");
  });

  it("still demotes findings beyond the inline cap instead of dropping them silently", () => {
    const { comments, demoted } = selectInlineComments(
      [
        { file: "src/app.ts", line: 5, summary: "one", severity: "high" },
        { file: "src/app.ts", line: 6, summary: "two", severity: "high" },
        { file: "src/app.ts", line: 99, summary: "floating", severity: "medium" },
      ],
      { limit: 1, headSha: "abc123", diff },
    );
    expect(comments).toHaveLength(1);
    expect(demoted.map((d) => d.finding.summary)).toEqual(["floating"]);
  });

  it("passes every located finding through when no diff is available", () => {
    const { comments, demoted } = selectInlineComments(
      [{ file: "a.ts", line: 1, summary: "one", severity: "high" }],
      { limit: 12, headSha: "abc123" },
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]?.side).toBe("RIGHT");
    expect(demoted).toEqual([]);
  });

  it("lists demoted findings in the review body, capped", () => {
    const demoted = Array.from({ length: 12 }, (_, i) => ({
      finding: { file: "a.ts", line: i + 1, summary: `s${i}`, severity: "high" },
      reason: "outside_hunk",
    }));
    const body = buildReviewBody({
      headSha: "abc123",
      summary: "sum",
      findingsCount: 12,
      reviewerCount: 1,
      demoted,
    });
    expect(body).toContain("#### Findings not shown inline");
    expect(body).toContain("`a.ts:1`");
    expect(body).toContain("… and 2 more");
    expect(body).not.toContain("`a.ts:11`");
  });

  it("keeps the body unchanged when nothing was demoted", () => {
    const body = buildReviewBody({ headSha: "abc123", summary: "sum", findingsCount: 0, reviewerCount: 1 });
    expect(body).not.toContain("not shown inline");
  });
});
