import { describe, expect, it } from "vitest";
import { buildGuidedPublishPreview } from "./publish-preview.js";
import type { GuidedCommentView, GuidedSessionView } from "./store.js";

function session(overrides: Partial<GuidedSessionView> = {}): GuidedSessionView {
  return {
    id: 1,
    actorProvider: "github",
    actorId: "1001",
    provider: "github",
    instance: "github.com",
    repoFullName: "acme/widgets",
    prNumber: 12,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    status: "active",
    currentPath: null,
    currentHunk: null,
    position: {},
    viewedFiles: [],
    draftSummary: "Overall summary",
    draftVerdict: "COMMENT",
    walkthroughRef: null,
    comparisonState: {},
    version: 1,
    historicalAt: null,
    createdAt: "now",
    updatedAt: "now",
    lastOpenedAt: "now",
    ...overrides,
  };
}

function comment(overrides: Partial<GuidedCommentView>): GuidedCommentView {
  return {
    id: 1,
    sessionId: 1,
    clientId: `c${Math.random()}`,
    kind: "general",
    body: "note",
    path: null,
    side: null,
    line: null,
    hunkAnchor: null,
    anchorStatus: "anchored",
    severity: null,
    category: null,
    publishable: true,
    sourceCommentId: null,
    deletedAt: null,
    createdAt: "now",
    updatedAt: "now",
    ...overrides,
  };
}

describe("buildGuidedPublishPreview", () => {
  it("keeps publishable inline comments out of approvals by folding them into the summary", () => {
    const preview = buildGuidedPublishPreview(session({ draftVerdict: "APPROVE" }), [
      comment({ kind: "inline", path: "src/a.ts", side: "RIGHT", line: 4, body: "Looks safe because tested" }),
      comment({ kind: "general", body: "General publishable note", publishable: true }),
      comment({ kind: "general", body: "Private note", publishable: false }),
    ]);
    expect(preview.comments).toEqual([]);
    expect(preview.body).toContain("Overall summary");
    expect(preview.body).toContain("Looks safe because tested");
    expect(preview.body).toContain("General publishable note");
    expect(preview.body).not.toContain("Private note");
    expect(preview.omittedInlineCount).toBe(1);
  });

  it("uses exact anchored inline payload for comments and warns about unresolved threads", () => {
    const preview = buildGuidedPublishPreview(session(), [
      comment({ kind: "inline", path: "src/a.ts", side: "LEFT", line: 8, body: "Please explain" }),
    ]);
    expect(preview.comments).toEqual([{ path: "src/a.ts", side: "LEFT", line: 8, body: "Please explain" }]);
    expect(preview.target.headSha).toBe("b".repeat(40));
    expect(preview.unresolvedThreadWarning).toBe(true);
  });

  it("excludes unplaced, deleted, private, and malformed inline notes from publication", () => {
    const preview = buildGuidedPublishPreview(session(), [
      comment({ kind: "inline", path: "src/stale.ts", side: "RIGHT", line: 3, body: "stale", anchorStatus: "unplaced" }),
      comment({ kind: "inline", path: "src/deleted.ts", side: "RIGHT", line: 4, body: "deleted", deletedAt: "later" }),
      comment({ kind: "inline", path: "src/private.ts", side: "RIGHT", line: 5, body: "private", publishable: false }),
      comment({ kind: "inline", path: "src/ok.ts", side: "RIGHT", line: 6, body: "publish me" }),
    ]);
    expect(preview.comments).toEqual([{ path: "src/ok.ts", side: "RIGHT", line: 6, body: "publish me" }]);
  });
});
