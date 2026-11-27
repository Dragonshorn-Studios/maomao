import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff.js";
import { renderGuidedAttentionPanel, renderGuidedDiffWorkspace, renderGuidedPublishPanel } from "../ui/guided.js";

describe("parseUnifiedDiff", () => {
  it("tracks both-side line numbers, statuses, and renames", () => {
    const files = parseUnifiedDiff(`diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -10,2 +10,3 @@
 ctx
-old
+new
+added
`);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "new.ts", status: "renamed", additions: 2, deletions: 1 });
    expect(files[0].hunks[0].lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ["ctx", 10, 10],
      ["del", 11, undefined],
      ["add", undefined, 11],
      ["add", undefined, 12],
    ]);
  });

  it("parses quoted paths containing spaces", () => {
    const [file] = parseUnifiedDiff(`diff --git "a/dir one/old file.ts" "b/dir one/new file.ts"
rename from dir one/old file.ts
rename to dir one/new file.ts
--- "a/dir one/old file.ts"
+++ "b/dir one/new file.ts"
@@ -1 +1 @@
-a
+b
`);
    expect(file.path).toBe("dir one/new file.ts");
  });

  it("renders exact anchors and escapes untrusted diff content", () => {
    const [file] = parseUnifiedDiff(`diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -4,2 +4,2 @@
-old('<img>')
+new('</script>')
`);
    const html = renderGuidedDiffWorkspace({ files: [file] });
    expect(html).toContain('data-anchor-path="x.ts" data-anchor-side="LEFT" data-anchor-line="4"');
    expect(html).toContain('data-anchor-path="x.ts" data-anchor-side="RIGHT" data-anchor-line="4"');
    expect(html).toContain("old(&#39;&lt;img&gt;&#39;)");
    expect(html).toContain("new(&#39;&lt;/script&gt;&#39;)");
    const match = html.match(/<script type="application\/json" class="guided-patch-raw">([\s\S]*?)<\/script>/);
    expect(match).toBeTruthy();
    expect(JSON.parse(match![1]) as string).toContain("+new('</script>')");
    expect(html).not.toContain("+new('<\\/script>')");
  });

  it("marks binary and oversized file content explicitly", () => {
    const binary = parseUnifiedDiff(`diff --git a/a.png b/a.png
Binary files a/a.png and b/a.png differ
`)[0];
    expect(binary.binary).toBe(true);
    expect(binary.status).toBe("modified");
    const long = parseUnifiedDiff(`diff --git a/x b/x
--- a/x
+++ b/x
@@ -1 +1,4 @@
-a
+b
+c
+d
`, { maxLinesPerFile: 2 })[0];
    expect(long.truncated).toBe(true);
  });

  it("renders the private draft controls and exact comment anchors only for an active actor session", () => {
    const [file] = parseUnifiedDiff(`diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-old
+new
`);
    const sessionView = {
      id: 7,
      actorProvider: "github",
      actorId: "1001",
      provider: "github",
      instance: "github.com",
      repoFullName: "acme/widgets",
      prNumber: 12,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      status: "active" as const,
      currentPath: null,
      currentHunk: null,
      position: {},
      viewedFiles: [],
      draftSummary: "draft <summary>",
      draftVerdict: "COMMENT" as const,
      walkthroughRef: null,
      comparisonState: {},
      version: 3,
      historicalAt: null,
      createdAt: "now",
      updatedAt: "now",
      lastOpenedAt: "now",
    };
    const html = renderGuidedDiffWorkspace({ files: [file], sessionView, comments: [], csrfToken: "csrf" });
    expect(html).toContain("data-guided-draft");
    expect(html).toContain("data-preview-publish");
    expect(html).toContain("data-guided-comment-anchor");
    expect(html).toContain("draft &lt;summary&gt;");
    expect(html).not.toContain("draft <summary>");
    const readOnly = renderGuidedDiffWorkspace({ files: [file], sessionView, comments: [], readOnly: true });
    expect(readOnly).not.toContain("data-guided-draft");
    expect(readOnly).not.toContain("data-guided-comment-anchor");
  });


  it("renders compact manual file state, no file filter, and inline note data", () => {
    const [file] = parseUnifiedDiff(`diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1 +1 @@
-old
+new
`);
    const sessionView = {
      id: 7,
      actorProvider: "github",
      actorId: "1001",
      provider: "github",
      instance: "github.com",
      repoFullName: "acme/widgets",
      prNumber: 12,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      status: "active" as const,
      currentPath: null,
      currentHunk: null,
      position: {},
      viewedFiles: ["src/x.ts"],
      draftSummary: "",
      draftVerdict: null,
      walkthroughRef: null,
      comparisonState: {},
      version: 3,
      historicalAt: null,
      createdAt: "now",
      updatedAt: "now",
      lastOpenedAt: "now",
    };
    const comment = {
      id: 1,
      sessionId: 7,
      clientId: "c-note",
      kind: "inline" as const,
      body: "Inline <note>",
      path: "src/x.ts",
      side: "RIGHT" as const,
      line: 1,
      hunkAnchor: null,
      anchorStatus: "anchored" as const,
      severity: "medium" as const,
      category: "correctness",
      publishable: true,
      sourceCommentId: null,
      deletedAt: null,
      createdAt: "now",
      updatedAt: "now",
    };
    const unplaced = { ...comment, id: 2, clientId: "c-stale", line: 99, anchorStatus: "unplaced" as const, publishable: false };
    const html = renderGuidedDiffWorkspace({ files: [file], sessionId: 7, sessionView, viewedFiles: ["src/x.ts"], comments: [comment, unplaced], csrfToken: "csrf" });
    expect(html).toContain('data-guided-viewed-toggle data-path="src/x.ts" checked');
    expect(html).toContain('class="gd-inline-note-row"');
    expect(html).toContain("Inline &lt;note&gt;");
    expect(html).toContain('class="guided-annotations-raw"');
    expect(html).toContain('data-guided-tree-toggle');
    expect(html).not.toContain('name="file"');
    expect(html).not.toContain("IntersectionObserver");
    expect(html).toContain("guided:wizard-step");
    expect(html).toContain("Unplaced stale-hunk note");
    expect(html).toContain('<details class="gd-draft-details" open>');
    const annotationJson = html.match(/<script type="application\/json" class="guided-annotations-raw">([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(annotationJson).toContain("c-note");
    expect(annotationJson).not.toContain("c-stale");
    const detailsStart = html.indexOf('<details class="gd-draft-details"');
    const detailsEnd = html.indexOf("</details>", detailsStart);
    expect(html.indexOf("data-inline-editor")).toBeGreaterThan(detailsEnd);
  });

  it("renders the optional poison-alert skip action only for optional attention", () => {
    const optional = renderGuidedAttentionPanel({
      attention: { state: "pending", profile: "poison-alert", optional: true, message: "optional attention" },
      sessionId: 7,
      csrfToken: "csrf",
    });
    expect(optional).toContain('value="skip_guided_review"');
    expect(optional).toContain("Continue without Guided Review");
    expect(optional).toContain("gd-button-warning");
    const required = renderGuidedAttentionPanel({
      attention: { state: "pending", profile: "poison-alert", optional: false, message: "required attention" },
      sessionId: 7,
      csrfToken: "csrf",
    });
    expect(required).not.toContain('value="skip_guided_review"');
  });

  it("renders walkthrough progress states and deep-links structured evidence into the exact diff", () => {
    const [file] = parseUnifiedDiff(`diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-old
+new
`);
    const base = {
      fingerprint: "fp",
      error: null,
      cancelRequested: false,
      requestCount: 1,
      createdAt: "now",
      updatedAt: "now",
      startedAt: "now",
      finishedAt: null,
    };
    const running = renderGuidedDiffWorkspace({
      files: [file],
      sessionId: 7,
      csrfToken: "csrf",
      walkthrough: { ...base, status: "running" as const, payload: undefined },
    });
    expect(running).toContain("data-guided-walkthrough");
    expect(running).toContain("background");
    expect(running).toContain("data-walkthrough-cancel");
    expect(running).toContain("data-guided-primer");
    expect(running).toContain("without using Maomao review findings or verdicts");
    const ready = renderGuidedDiffWorkspace({
      files: [file],
      sessionId: 7,
      csrfToken: "csrf",
      walkthrough: {
        ...base,
        status: "ready" as const,
        payload: {
          schema_version: 1,
          kind: "guided_walkthrough",
          intent: { text: "Intent <unsafe>", uncertainty: "No docs" },
          changeMap: [{ path: "x.ts", summary: "Changed behavior", evidence: "hunk evidence" }],
          flow: "Flow",
          decisions: [],
          tests: "Tests unavailable",
          risks: [{ question: "Is it safe?", path: "x.ts", line: 1, evidence: "line evidence" }],
          generatedAt: "now",
        },
      },
    });
    expect(ready).toContain('href="#guided-file-0"');
    expect(ready).toContain("Intent &lt;unsafe&gt;");
    expect(ready).not.toContain("Intent <unsafe>");
    expect(ready).toContain("independent · no findings or verdicts");
    expect(ready).toContain('data-file-primer data-path="x.ts"');
    expect(ready).toContain("Changed behavior");
    expect(ready).toContain("Full exploration evidence");
  });


  it("renders comparison coverage, pairing controls, explicit uncertainty and escaped evidence", () => {
    const [file] = parseUnifiedDiff(`diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-old
+new
`);
    const human = { key: "note-1", fingerprint: "hfp", source: "human" as const, summary: "Human <note>", path: "x.ts", line: 1, severity: "medium" };
    const maomao = { key: "maomao-afp", fingerprint: "afp", source: "maomao" as const, summary: "Maomao finding", path: "x.ts", line: 3, severity: "high", status: "open" as const, rationale: "Aggregator evidence" };
    const outsideHuman = { key: "note-doc", fingerprint: "hdoc", source: "human" as const, summary: "Document note", path: "README.md", line: 2, severity: "low" };
    const outsideMaomao = { key: "maomao-doc", fingerprint: "adoc", source: "maomao" as const, summary: "Document finding", path: "README.md", line: 2, severity: "low", status: "open" as const };
    const unanchoredHuman = { key: "note-general", fingerprint: "hgeneral", source: "human" as const, summary: "General human note", severity: "low" };
    const fileOnlyMaomao = { key: "maomao-package", fingerprint: "apackage", source: "maomao" as const, summary: "Package finding", path: "package.json", severity: "low", status: "open" as const };
    const excludedMaomao = { key: "maomao-excluded", fingerprint: "aexcluded", source: "maomao" as const, summary: "Excluded finding", path: "package.json", severity: "medium", status: "open" as const };
    const html = renderGuidedDiffWorkspace({
      files: [file],
      sessionId: 7,
      sessionVersion: 4,
      csrfToken: "csrf",
      comparison: {
        state: "ready",
        headSha: "b".repeat(40),
        jobId: 9,
        jobState: "completed",
        message: "Comparison pinned",
        verdictDifference: "human APPROVE vs Maomao REQUEST_CHANGES",
        summary: { agreement: 0, humanOnly: 2, maomaoOnly: 2, uncertain: 2, verdictDifference: 1, inactive: 0 },
        agreements: [],
        uncertain: [
          { human, maomao, match: "uncertain" as const, confidence: 0.5, signals: ["same path"], severityDifference: "human medium vs Maomao high", confirmed: false },
          { human: outsideHuman, maomao: outsideMaomao, match: "uncertain" as const, confidence: 0.5, signals: ["same path"], confirmed: false },
        ],
        humanOnly: [human, unanchoredHuman],
        maomaoOnly: [maomao, fileOnlyMaomao],
        inactiveMaomao: [],
        excludedMaomao: [excludedMaomao],
        overrides: {},
      },
    });
    expect(html).toContain("Merge review");
    expect(html).toContain("Maomao's already-published review is never mutated");
    expect(html).toContain("Confirm same issue");
    expect(html).toContain("Mark unrelated");
    expect(html).toContain("Add to my review");
    expect(html).toContain("Remove from merge");
    expect(html).toContain("Pair selected findings");
    expect(html).toContain("Severity differs: human medium vs Maomao high");
    expect(html).toContain("Verdict differs: human APPROVE vs Maomao REQUEST_CHANGES");
    expect(html).toContain("Human &lt;note&gt;");
    expect(html).not.toContain("Human <note>");
    expect(html).toContain("Unanchored or outside the pinned source diff (3)");
    expect((html.match(/Add to my review/g) ?? [])).toHaveLength(2);
    expect((html.match(/Mark unrelated/g) ?? [])).toHaveLength(2);
    expect(html).toContain("Restore to merge review");

    const missing = renderGuidedDiffWorkspace({
      files: [file],
      sessionId: 7,
      sessionVersion: 4,
      csrfToken: "csrf",
      pullUrl: "https://github.com/acme/widgets/pull/12",
      comparison: {
        state: "missing",
        headSha: "b".repeat(40),
        message: "No exact-head Maomao review exists",
        summary: { agreement: 0, humanOnly: 1, maomaoOnly: 0, uncertain: 0, verdictDifference: 0, inactive: 0 },
        agreements: [],
        uncertain: [],
        humanOnly: [human],
        maomaoOnly: [],
        inactiveMaomao: [],
        excludedMaomao: [],
        overrides: {},
      },
    });
    expect(missing).toContain("No exact-head Maomao review exists");
    expect(missing).toContain("Deliberately enqueue Maomao review for the current pull head");
  });

  it("organizes the workspace as review, comparison, then publish wizard steps", () => {
    const [file] = parseUnifiedDiff(`diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-old
+new
`);
    const html = renderGuidedDiffWorkspace({ files: [file] });
    expect(html).toContain('data-guided-wizard');
    expect(html.indexOf('for="gd-step-review"')).toBeLessThan(html.indexOf('for="gd-step-compare"'));
    expect(html.indexOf('for="gd-step-compare"')).toBeLessThan(html.indexOf('for="gd-step-publish"'));
    expect(html).toContain('data-wizard-panel="review"');
    expect(html).toContain('data-wizard-panel="compare"');
    expect(html).toContain('data-wizard-panel="publish"');
    expect(html).toContain("inspect the exact pinned diff first");
  });

});


describe("renderGuidedPublishPanel", () => {
  it("offers deliberate retry forms for failed and uncertain publications", () => {
    for (const state of ["failed", "uncertain", "stale_pending"] as const) {
      const html = renderGuidedPublishPanel({
        publish: { state, message: "retry needed", canConnect: false, login: "operator" },
        sessionId: 7,
        sessionVersion: 3,
        csrfToken: "csrf",
      });
      expect(html).toContain('action="/guided/sessions/7/publish"');
      expect(html).toContain("Retry human review publication as operator");
    }
    const pending = renderGuidedPublishPanel({
      publish: { state: "pending", message: "in progress", canConnect: false, login: "operator" },
      sessionId: 7,
      sessionVersion: 3,
      csrfToken: "csrf",
    });
    expect(pending).not.toContain('action="/guided/sessions/7/publish"');
  });
});
