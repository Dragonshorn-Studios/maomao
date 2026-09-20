import { describe, expect, it } from "vitest";
import { changeIdentifier, forgeBadgeTitle, forgeBadgeTitleHtml, providerLabel } from "./forge-badge.js";

describe("forge badge rendering", () => {
  it("labels the known providers and collapses canonical public instances", () => {
    expect(
      forgeBadgeTitle({ provider: "github", provider_instance: "github.com" }, "acme/widgets", 7),
    ).toBe("[GitHub] acme/widgets #7");
    expect(
      forgeBadgeTitle({ provider: "gitlab", provider_instance: "gitlab.com" }, "acme/widgets", 7),
    ).toBe("[GitLab] acme/widgets !7");
  });

  it("shows the hostname for self-managed instances", () => {
    expect(
      forgeBadgeTitle({ provider: "gitlab", provider_instance: "gitlab.corp.internal" }, "team/project", 17),
    ).toBe("[GitLab · gitlab.corp.internal] team/project !17");
  });

  it("uses # for GitHub and ! for GitLab regardless of number", () => {
    expect(changeIdentifier("github", 12)).toBe("#12");
    expect(changeIdentifier("gitlab", 12)).toBe("!!12".replace("!!", "!"));
    expect(changeIdentifier("gitlab", 0)).toBe("!0");
  });

  it("never emits raw HTML through the escaped form", () => {
    const html = forgeBadgeTitleHtml(
      { provider: "gitlab", provider_instance: '<script>alert(1)</script>' },
      "acme/project",
      3,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("!3");
  });

  it("labels unknown providers verbatim", () => {
    expect(providerLabel("gitea")).toBe("gitea");
    expect(providerLabel("GitHub")).toBe("GitHub");
  });
});
