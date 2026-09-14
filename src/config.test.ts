import { describe, expect, it } from "vitest";
import { assertRuntimeConfig, loadConfig } from "./config.js";
import { parseBoolean, parseCsv } from "./util.js";

describe("loadConfig", () => {
  it("loads defaults and reviewer roles from env", () => {
    const config = loadConfig({
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN KEY-----\\nABC\\n-----END KEY-----",
      GITHUB_WEBHOOK_SECRET: "secret",
      REVIEWER_ROLES: "correctness,security",
      REVIEW_DRAFTS: "true",
      POST_EMPTY_REVIEW: "0",
      OPENCODE_REVIEWER_CONCURRENCY: "3",
    });
    expect(config.github.appId).toBe("1");
    expect(config.github.privateKey).toContain("BEGIN KEY");
    expect(config.reviewers.map((r) => r.id)).toEqual(["correctness", "security"]);
    expect(config.reviewDrafts).toBe(true);
    expect(config.postEmptyReview).toBe(false);
    expect(config.opencode.reviewerConcurrency).toBe(3);
    expect(config.pullRequestActions).toContain("ready_for_review");
  });

  it("reads UI password aliases and rejects a half-configured gate", () => {
    const config = loadConfig({
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "k",
      GITHUB_WEBHOOK_SECRET: "s",
      MAOMAO_UI_PASSWORD: "pw",
      UI_SESSION_SECRET: "session-secret",
    });
    expect(config.uiPassword).toBe("pw");
    expect(config.uiSessionSecret).toBe("session-secret");
    expect(() =>
      assertRuntimeConfig(
        loadConfig({
          GITHUB_APP_ID: "1",
          GITHUB_APP_PRIVATE_KEY: "k",
          GITHUB_WEBHOOK_SECRET: "s",
          UI_PASSWORD: "pw",
        }),
      ),
    ).toThrow(/UI_PASSWORD and UI_SESSION_SECRET/);
  });

  it("supports unknown reviewer ids", () => {
    const config = loadConfig({
      REVIEWER_ROLES: "perf",
      REVIEWER_PROMPT_PERF: "Look for hot loops.",
    });
    expect(config.reviewers).toEqual([
      expect.objectContaining({ id: "perf", prompt: "Look for hot loops." }),
    ]);
  });
});

describe("env parsers", () => {
  it("parses booleans and csv", () => {
    expect(parseBoolean("yes", false)).toBe(true);
    expect(parseBoolean("off", true)).toBe(false);
    expect(parseCsv("a, b,,c")).toEqual(["a", "b", "c"]);
  });
});
