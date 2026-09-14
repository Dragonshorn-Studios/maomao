import { describe, expect, it } from "vitest";
import { assertRuntimeConfig, loadConfig } from "./config.js";
import { parseBoolean, parseCsv, parseIdList } from "./util.js";

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
    expect(config.allowedGithubAccountIds).toEqual([]);
    expect(config.allowedGithubRepositoryIds).toEqual([]);
    expect(config.maxDiffBytes).toBe(1_048_576);
    expect(config.repoRateLimitPerWindow).toBe(6);
    expect(config.opencode.maxRetries).toBe(1);
  });

  it("parses numeric GitHub allowlists and defense-in-depth limits", () => {
    const config = loadConfig({
      ALLOWED_GITHUB_ACCOUNT_IDS: "1001, 2002, 1001",
      ALLOWED_GITHUB_REPOSITORY_IDS: " 555 777 ",
      MAX_DIFF_BYTES: "2048",
      REPO_RATE_LIMIT_PER_WINDOW: "3",
      REPO_RATE_WINDOW_MS: "1000",
      OPENCODE_MAX_RETRIES: "99",
    });
    expect(config.allowedGithubAccountIds).toEqual([1001, 2002]);
    expect(config.allowedGithubRepositoryIds).toEqual([555, 777]);
    expect(config.maxDiffBytes).toBe(2048);
    expect(config.repoRateLimitPerWindow).toBe(3);
    expect(config.repoRateWindowMs).toBe(1000);
    expect(config.opencode.maxRetries).toBe(5);
  });

  it("fails fast when an allowlist contains non-numeric tokens", () => {
    expect(() =>
      loadConfig({
        ALLOWED_GITHUB_ACCOUNT_IDS: "1001, not-an-id, 2002",
      }),
    ).toThrow(/ALLOWED_GITHUB_ACCOUNT_IDS/);
    expect(() =>
      loadConfig({
        ALLOWED_GITHUB_REPOSITORY_IDS: "R_kgDOabc",
      }),
    ).toThrow(/REST numeric IDs/);
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

  it("parses positive numeric GitHub ids and fails fast on junk", () => {
    expect(parseIdList("")).toEqual([]);
    expect(parseIdList("1, 02, 1")).toEqual([1, 2]);
    expect(parseIdList(" 9\n10 ")).toEqual([9, 10]);
    expect(() => parseIdList("1, -3, foo", "ALLOWED_GITHUB_ACCOUNT_IDS")).toThrow(
      /ALLOWED_GITHUB_ACCOUNT_IDS contains non-numeric/,
    );
    expect(() => parseIdList(",", "ALLOWED_GITHUB_REPOSITORY_IDS")).toThrow(
      /ALLOWED_GITHUB_REPOSITORY_IDS is set but contains no positive/,
    );
  });
});
