import { describe, expect, it } from "vitest";
import { annotationForLine, diffLayoutOptions, nextLayout, synthesisePatch } from "./pierre-glue.js";

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

  it("corrects count-less headers while preserving the real start numbers", () => {
    const patch = synthesisePatch("@@ -48 +48 @@\n-old\n+new\n keep", "a.ts");
    expect(patch).toContain("@@ -48,2 +48,2 @@");
  });

  it("keeps annotation numbering aligned with the rendered diff (start != count)", () => {
    // Regression: discarding the start numbers made annotations unanchorable.
    const raw = "@@ -48 +48 @@\n unchanged\n-removed\n+added\n unchanged2";
    expect(synthesisePatch(raw, "src/auth.ts")).toContain("@@ -48,3 +48,3 @@");
    // annotationForLine reads the raw header start; rendered rows use the same
    // start now, so lineNumber 49 is a real row on the additions side.
    expect(annotationForLine(raw, 49)).toEqual({ side: "additions", lineNumber: 49 });
  });

  it("handles the numberless 'first hunk' fallback header", () => {
    const patch = synthesisePatch("@@ first hunk (no line recorded)\n+only", "a.ts");
    expect(patch).toContain("@@ -1,0 +1,1 @@");
    expect(patch).toContain("+only");
  });

  it("falls back to a placeholder path when none is recorded", () => {
    const patch = synthesisePatch(RAW, "");
    expect(patch).toContain("diff --git a/unknown b/unknown");
  });

  it("passes headerless input through unchanged (defensive: apply.ts always emits a header)", () => {
    const body = "-removed\n+added";
    expect(synthesisePatch(body, "a.ts")).toContain(body);
  });

  it("does not count trailing empty lines or no-newline markers as context", () => {
    const trailing = synthesisePatch("@@ -51 +54 @@\n keep\n-old\n+new\n keep2\n", "a.ts");
    expect(trailing).toContain("@@ -51,3 +54,3 @@");
    expect(trailing).not.toContain("@@ -51,4 +54,4 @@");

    const marker = synthesisePatch("@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file", "a.ts");
    expect(marker).toContain("@@ -1,1 +1,1 @@");
    expect(marker).toContain("\\ No newline at end of file");
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

describe("diffLayoutOptions", () => {
  it("pins the maomao finding-diff option subset", () => {
    const options = diffLayoutOptions("split", "dark");
    expect(options).toEqual({
      diffStyle: "split",
      disableFileHeader: true,
      lineDiffType: "word",
      diffIndicators: "bars",
      overflow: "scroll",
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType: "dark",
    });
  });

  it("toggles layouts", () => {
    expect(nextLayout("split")).toBe("unified");
    expect(nextLayout("unified")).toBe("split");
  });
});

describe("pierre-entry mount contract", () => {
  it("mounts FileDiff via containerWrapper so diffs-container can adopt its stylesheet", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./pierre-entry.ts", import.meta.url), "utf8");
    expect(source).toContain("containerWrapper: container");
    expect(source).not.toMatch(/fileContainer:\s*container/);
    expect(source).toContain("diffs-container");
  });
});
