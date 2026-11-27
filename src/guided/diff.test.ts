import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff.js";
import { renderGuidedDiffWorkspace, renderGuidedPublishPanel } from "../ui/guided.js";

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
        summary: { agreement: 0, humanOnly: 1, maomaoOnly: 1, uncertain: 1, verdictDifference: 1, inactive: 0 },
        agreements: [],
        uncertain: [{ human, maomao, match: "uncertain" as const, confidence: 0.5, signals: ["same path"], severityDifference: "human medium vs Maomao high", confirmed: false }],
        humanOnly: [human],
        maomaoOnly: [maomao],
        inactiveMaomao: [],
        overrides: {},
      },
    });
    expect(html).toContain("Compare with Maomao");
    expect(html).toContain("not a score for agreeing with AI");
    expect(html).toContain("Confirm same issue");
    expect(html).toContain("Mark unrelated");
    expect(html).toContain("Pair selected findings");
    expect(html).toContain("Severity differs: human medium vs Maomao high");
    expect(html).toContain("Verdict differs: human APPROVE vs Maomao REQUEST_CHANGES");
    expect(html).toContain("Human &lt;note&gt;");
    expect(html).not.toContain("Human <note>");

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
        overrides: {},
      },
    });
    expect(missing).toContain("No exact-head Maomao review exists");
    expect(missing).toContain("Deliberately enqueue Maomao review for the current pull head");
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
