import { describe, expect, it } from "vitest";
import { annotationForLine, synthesisePatch } from "./pierre-glue.js";

const RAW = ["@@ -48,6 +48,8 @@", " unchanged", "-removed secret", "+added secret", "+added more", " unchanged2", " unchanged3"].join(
  "\n",
);

describe("synthesisePatch", () => {
  it("wraps the hunk in a single-file patch with the finding's path", () => {
    const patch = synthesisePatch(RAW, "src/auth.ts");
    expect(patch.split("\n")[0]).toBe("diff --git a/src/auth.ts b/src/auth.ts");
    expect(patch).toContain("--- a/src/auth.ts");
    expect(patch).toContain("+++ b/src/auth.ts");
    expect(patch).toContain("-removed secret");
  });

  it("corrects count-less headers with counts derived from the body", () => {
    const patch = synthesisePatch("@@ -48 +48 @@\n-old\n+new\n keep", "a.ts");
    expect(patch).toContain("@@ -2,2 +2,2 @@");
  });

  it("handles the numberless 'first hunk' fallback header", () => {
    const patch = synthesisePatch("@@ first hunk (no line recorded)\n+only", "a.ts");
    expect(patch).toContain("@@ -0,0 +1,1 @@");
    expect(patch).toContain("+only");
  });

  it("falls back to a placeholder path when none is recorded", () => {
    const patch = synthesisePatch(RAW, "");
    expect(patch).toContain("diff --git a/unknown b/unknown");
  });
});

describe("annotationForLine", () => {
  it("maps a new-file line number onto an additions annotation", () => {
    // Header says new side starts at 48: unchanged=48, added=49, added=50, unchanged=51.
    expect(annotationForLine(RAW, 49)).toEqual({ side: "additions", lineNumber: 49 });
    expect(annotationForLine(RAW, 51)).toEqual({ side: "additions", lineNumber: 51 });
  });

  it("returns undefined for lines outside the hunk window", () => {
    expect(annotationForLine(RAW, 8)).toBeUndefined();
    expect(annotationForLine(RAW, 99)).toBeUndefined();
  });

  it("returns undefined for missing or invalid target lines", () => {
    expect(annotationForLine(RAW, null)).toBeUndefined();
    expect(annotationForLine(RAW, undefined)).toBeUndefined();
    expect(annotationForLine(RAW, 0)).toBeUndefined();
  });

  it("returns undefined for the numberless fallback header (no line to anchor to)", () => {
    expect(annotationForLine("@@ first hunk (no line recorded)\n+only", 1)).toBeUndefined();
  });
});
