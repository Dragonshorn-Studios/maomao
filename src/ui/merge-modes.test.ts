import { describe, expect, it } from "vitest";
import { renderMergeModesPage } from "./merge-modes.js";

describe("renderMergeModesPage", () => {
  it("escapes stored scopes and explains the manual default", () => {
    const html = renderMergeModesPage({
      rules: [{
        id: 1,
        provider: "github",
        providerInstance: "github.com",
        repoFullName: "acme/<script>",
        mergeMode: "manual",
        updatedBy: "operator",
        updatedAt: "2026-01-01T00:00:00Z",
      }],
      canWrite: false,
      options: {},
    });
    expect(html).toContain("acme/&lt;script&gt;");
    expect(html).not.toContain("acme/<script>");
    expect(html).toContain("Merge modes");
  });
});
