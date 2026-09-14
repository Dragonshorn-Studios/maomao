import { describe, expect, it } from "vitest";
import { GITHUB_SECRET_KEYS, sanitizeChildEnv } from "./env.js";

describe("sanitizeChildEnv", () => {
  it("strips GitHub and Maomao secrets while keeping provider keys", () => {
    const env = sanitizeChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/maomao",
      GITHUB_APP_PRIVATE_KEY: "super-secret-pem",
      GITHUB_WEBHOOK_SECRET: "whsec",
      GITHUB_TOKEN: "ghs_xxx",
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-openai",
      OPENCODE_REVIEWER_MODEL: "anthropic/claude",
      MAOMAO_INTERNAL: "nope",
      UI_PASSWORD: "pw",
      UI_SESSION_SECRET: "sess",
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
    });
    for (const key of GITHUB_SECRET_KEYS) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(env.OPENAI_API_KEY).toBe("sk-openai");
    expect(env.OPENCODE_REVIEWER_MODEL).toBe("anthropic/claude");
    expect(env.MAOMAO_INTERNAL).toBeUndefined();
    expect(env.UI_PASSWORD).toBeUndefined();
    expect(env.UI_SESSION_SECRET).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBe("AKIAEXAMPLE");
    expect(JSON.stringify(env)).not.toContain("super-secret-pem");
    expect(JSON.stringify(env)).not.toContain("ghs_xxx");
  });
});
