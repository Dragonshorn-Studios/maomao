import { describe, expect, it } from "vitest";
import { changeIdentifier, forgeBadgeTitle, forgeBadgeTitleHtml, forgeMarkLabel, providerLabel } from "./forge-badge.js";

describe("forge badge rendering", () => {
  it("names providers in plain titles without square-bracket prefixes", () => {
    expect(
      forgeBadgeTitle({ provider: "github", provider_instance: "github.com" }, "acme/widgets", 7),
    ).toBe("GitHub · acme/widgets #7");
    expect(
      forgeBadgeTitle({ provider: "gitlab", provider_instance: "gitlab.com" }, "acme/widgets", 7),
    ).toBe("GitLab · acme/widgets !7");
  });

  it("shows the hostname for self-managed instances after the provider", () => {
    expect(
      forgeBadgeTitle({ provider: "gitlab", provider_instance: "gitlab.corp.internal" }, "team/project", 17),
    ).toBe("GitLab · gitlab.corp.internal · team/project !17");
  });

  it("uses # for GitHub and ! for GitLab regardless of number", () => {
    expect(changeIdentifier("github", 12)).toBe("#12");
    expect(changeIdentifier("gitlab", 12)).toBe("!!12".replace("!!", "!"));
    expect(changeIdentifier("gitlab", 0)).toBe("!0");
  });

  it("renders GitHub and GitLab marks instead of [GitHub]/[GitLab] prefixes", () => {
    const github = forgeBadgeTitleHtml({ provider: "github", provider_instance: "github.com" }, "acme/widgets", 7);
    const gitlab = forgeBadgeTitleHtml(
      { provider: "gitlab", provider_instance: "gitlab.corp.internal" },
      "team/project",
      17,
    );
    expect(github).toContain("c4.42 0 8 3.58");
    expect(github).toContain("forge-mark");
    expect(github).toContain("acme/widgets #7");
    expect(github).toContain('aria-label="GitHub"');
    expect(github).not.toContain("[GitHub]");
    expect(gitlab).toContain("forge-mark");
    expect(gitlab).toContain("team/project !17");
    expect(gitlab).toContain("gitlab.corp.internal");
    expect(gitlab).not.toContain("[GitLab");
    expect(forgeMarkLabel({ provider: "gitlab", provider_instance: "gitlab.com" })).toBe("GitLab");
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
    const html = forgeBadgeTitleHtml({ provider: "gitea", provider_instance: "git.example" }, "acme/app", 4);
    expect(html).toContain("gitea");
    expect(html).toContain("acme/app #4");
    expect(html).not.toContain("[gitea]");
  });
});
