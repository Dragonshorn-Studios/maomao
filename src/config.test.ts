import { describe, expect, it } from "vitest";
import { assertRuntimeConfig, loadConfig } from "./config.js";
import { parseBoolean, parseCsv, parseNumber } from "./util.js";

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

  it("loads routing and poison-alert defaults without hardcoded models", () => {
    const config = loadConfig({
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "k",
      GITHUB_WEBHOOK_SECRET: "s",
    });
    expect(config.routing.mode).toBe("hybrid");
    expect(config.poisonAlert.policy).toBe("internal_and_external");
    expect(config.poisonAlert.internal.enabled).toBe(false);
    expect(config.poisonAlert.internal.model).toBe("");
    expect(config.poisonAlert.external.targets).toEqual([]);
    expect(JSON.stringify(config)).not.toMatch(/glm-5\.3/i);
    expect(JSON.stringify(config)).not.toMatch(/marller/i);
  });

  it("loads optional data-integrity roles from the known catalog", () => {
    const config = loadConfig({ REVIEWER_ROLES: "correctness,data-integrity" });
    expect(config.reviewers.map((role) => role.id)).toEqual(["correctness", "data-integrity"]);
  });
});

describe("env parsers", () => {
  it("parses booleans, csv, and numbers", () => {
    expect(parseBoolean("yes", false)).toBe(true);
    expect(parseBoolean("off", true)).toBe(false);
    expect(parseCsv("a, b,,c")).toEqual(["a", "b", "c"]);
    expect(parseNumber("0.30", 0)).toBe(0.3);
  });
});
