import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff.js";
import { renderGuidedDiffWorkspace } from "../ui/guided.js";

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
    expect(html).toContain("+new('<\\/script>')");
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
});
