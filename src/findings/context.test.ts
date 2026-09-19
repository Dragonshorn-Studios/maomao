import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchoredDiffHunk, diffCommentAnchor, readSnippet, resolveSafeRepoPath } from "./context.js";

describe("safe repo path", () => {
  it("rejects lexical traversal and committed symlinks that escape the repo", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "maomao-repo-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "maomao-out-"));
    const secret = join(outsideDir, "secret.txt");
    await writeFile(secret, "host-secret\n", "utf8");
    await writeFile(join(repoDir, "ok.ts"), "export const n = 1;\n", "utf8");
    await symlink(secret, join(repoDir, "escape.ts"));

    expect(await resolveSafeRepoPath(repoDir, "../secret.txt")).toBeUndefined();
    expect(await resolveSafeRepoPath(repoDir, "escape.ts")).toBeUndefined();
    expect(await resolveSafeRepoPath(repoDir, "ok.ts")).toBe(await realpath(join(repoDir, "ok.ts")));
    expect(await readSnippet(repoDir, "escape.ts", 1)).toBeUndefined();
    expect(await readSnippet(repoDir, "ok.ts", 1)).toContain("export const n = 1;");
  });
});

describe("anchored diff hunk", () => {
  const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,7 +10,9 @@ export function boot() {
  const a = 1;
  const b = 2;
-  const c = 3;
+  const c = 30;
+  const d = 40;
   return a + b + c;
 }
@@ -40,4 +42,6 @@ export function stop() {
  done();
}`;
  // synthetic: markers below show the hunk body lines (space-prefixed context)

  it("anchors an addition inside the hunk with context lines", () => {
    const result = anchoredDiffHunk(diff, "src/app.ts", 13);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hunk.lines.some((l) => l.startsWith("+   const c = 30;"))).toBe(true);
    expect(result.hunk.lines.some((l) => l.startsWith("+   const d = 40;"))).toBe(true);
    expect(result.hunk.lines.some((l) => l.startsWith("    return a + b + c;"))).toBe(true);
    expect(result.hunk.truncated).toBe(false);
  });

  it("anchors a deletion via the old line number", () => {
    const result = anchoredDiffHunk(diff, "src/app.ts", 12);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hunk.lines.some((l) => l.startsWith("-   const c = 3;"))).toBe(true);
  });

  it("rejects lines outside every hunk instead of guessing", () => {
    const result = anchoredDiffHunk(diff, "src/app.ts", 200);
    expect(result).toEqual({ ok: false, reason: "outside_hunk" });
  });

  it("reports unchanged and binary files explicitly", () => {
    expect(anchoredDiffHunk(diff, "src/missing.ts", 3)).toEqual({ ok: false, reason: "file_unchanged" });
    const binary = `diff --git a/asset.png b/asset.png
--- a/asset.png
+++ b/asset.png
GIT binary patch
literal 10`;
    expect(anchoredDiffHunk(binary, "asset.png", 1)).toEqual({ ok: false, reason: "binary" });
  });

  it("truncates oversized hunks and marks them", () => {
    const padded = Array.from({ length: 40 }, (_, i) => `+  const pad${i} = ${i};`).join("\n");
    const bigDiff = `diff --git a/big.ts b/big.ts
--- a/big.ts
+++ b/big.ts
@@ -1,40 +1,40 @@
${padded}`;
    const result = anchoredDiffHunk(bigDiff, "big.ts", 20, 4, 200);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hunk.truncated).toBe(true);
    expect(result.hunk.lines.join("\n").length).toBeLessThanOrEqual(240);
  });

  it("falls back to the first hunk when no line hint exists", () => {
    const result = anchoredDiffHunk(diff, "src/app.ts", null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hunk.lines.length).toBeGreaterThan(0);
  });
});

describe("anchored diff hunk edge cases", () => {
  it("resolves renamed files by either header path without cross-file matching", () => {
    const renameDiff = `diff --git a/old/name.ts b/new/name.ts
similarity index 90%
rename from old/name.ts
rename to new/name.ts
--- a/old/name.ts
+++ b/new/name.ts
@@ -1,3 +1,3 @@
  keep();
-deleted();
+added();`;
    const byNew = anchoredDiffHunk(renameDiff, "new/name.ts", 2);
    expect(byNew.ok).toBe(true);
    const byOld = anchoredDiffHunk(renameDiff, "old/name.ts", 2);
    expect(byOld.ok).toBe(true);
    // A superstring path from another file must not match.
    const other = `diff --git a/infra/new/name.ts b/infra/new/name.ts
--- a/infra/new/name.ts
+++ b/infra/new/name.ts
@@ -1,1 +1,1 @@
-wrong();
+right();`;
    expect(anchoredDiffHunk(other, "new/name.ts", 1)).toEqual({ ok: false, reason: "file_unchanged" });
  });

  it("shows whole-file deletions as deletion lines", () => {
    const deleted = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-broken();
-line two();`;
    const result = anchoredDiffHunk(deleted, "gone.ts", 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hunk.lines.every((l) => l.startsWith("-"))).toBe(true);
  });

  it("never lets a single oversized line exceed the char budget", () => {
    const huge = "x".repeat(100_000);
    const bigDiff = `diff --git a/min.ts b/min.ts
--- a/min.ts
+++ b/min.ts
@@ -1,1 +1,2 @@
+${huge}
+small();`;
    const result = anchoredDiffHunk(bigDiff, "min.ts", 1, 4, 1_600);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = result.hunk.lines.join("\n");
    expect(rendered.length).toBeLessThanOrEqual(1_700);
    expect(result.hunk.truncated).toBe(true);
  });
});

describe("diff comment anchor", () => {
  // Hunk body: keep (old 5 / new 5), two deletions (old 6, 7), keep (old 8 / new 6).
  // The deletions shift the new numbering, so line 7 only exists on the old side.
  const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -5,4 +5,2 @@
 keep
-gone six
-gone seven
 keep
`;

  it("anchors new-side lines on the RIGHT", () => {
    expect(diffCommentAnchor(diff, "src/app.ts", 5)).toEqual({ ok: true, side: "RIGHT" });
  });

  it("prefers RIGHT when the line exists on both sides", () => {
    expect(diffCommentAnchor(diff, "src/app.ts", 6)).toEqual({ ok: true, side: "RIGHT" });
  });

  it("anchors deleted lines on the LEFT", () => {
    expect(diffCommentAnchor(diff, "src/app.ts", 7)).toEqual({ ok: true, side: "LEFT" });
  });

  it("rejects lines outside every hunk", () => {
    expect(diffCommentAnchor(diff, "src/app.ts", 99)).toEqual({ ok: false, reason: "outside_hunk" });
  });

  it("reports missing files, binaries, and missing locations explicitly", () => {
    expect(diffCommentAnchor(diff, "src/other.ts", 5)).toEqual({ ok: false, reason: "file_unchanged" });
    expect(diffCommentAnchor("", "src/app.ts", 5)).toEqual({ ok: false, reason: "missing_location" });
    expect(diffCommentAnchor(diff, "src/app.ts", 0)).toEqual({ ok: false, reason: "missing_location" });
    const binary = `diff --git a/asset.png b/asset.png
--- a/asset.png
+++ b/asset.png
GIT binary patch
literal 10`;
    expect(diffCommentAnchor(binary, "asset.png", 1)).toEqual({ ok: false, reason: "binary" });
  });
});
