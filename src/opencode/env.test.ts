import { describe, expect, it } from "vitest";
import {
  GITHUB_SECRET_KEYS,
  reviewerPermissionConfig,
  reviewerPermissionsV2Config,
  sanitizeChildEnv,
} from "./env.js";

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
      ZHIPU_API_KEY: "sk-zhipu",
      ZAI_API_KEY: "sk-zai",
      ZAI_CODING_PLAN_TOKEN: "should-not-pass",
      AZURE_RESOURCE_NAME: "my-resource",
      AZURE_API_KEY: "sk-azure",
      AWS_SECRET_ACCESS_KEY: "stripped-by-secret-pattern",
      AWS_SESSION_TOKEN: "stripped-by-token-pattern",
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
    expect(env.ZHIPU_API_KEY).toBe("sk-zhipu");
    expect(env.ZAI_API_KEY).toBe("sk-zai");
    expect(env.ZAI_CODING_PLAN_TOKEN).toBeUndefined();
    expect(env.AZURE_RESOURCE_NAME).toBe("my-resource");
    expect(env.AZURE_API_KEY).toBe("sk-azure");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(env.OPENCODE_REVIEWER_MODEL).toBe("anthropic/claude");
    expect(env.MAOMAO_INTERNAL).toBeUndefined();
    expect(env.UI_PASSWORD).toBeUndefined();
    expect(env.UI_SESSION_SECRET).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBe("AKIAEXAMPLE");
    expect(JSON.stringify(env)).not.toContain("super-secret-pem");
    expect(JSON.stringify(env)).not.toContain("ghs_xxx");
  });
});

describe("reviewer permission configs", () => {
  it("v1 denies external_directory except the job workspace carve-out", () => {
    const config = reviewerPermissionConfig({ externalAllow: ["/ws/job-1"] });
    const permission = config.permission as Record<string, unknown>;
    expect(permission["*"]).toBe("deny");
    expect(permission.read).toBe("allow");
    expect(permission.glob).toBe("allow");
    expect(permission.grep).toBe("allow");
    const external = permission.external_directory as Record<string, string>;
    expect(external["*"]).toBe("deny");
    expect(external["/ws/job-1"]).toBe("allow");
    expect(external["/ws/job-1/**"]).toBe("allow");
  });

  it("v1 denies external_directory outright with no carve-outs", () => {
    const config = reviewerPermissionConfig();
    const permission = config.permission as Record<string, unknown>;
    expect(permission.external_directory).toBe("deny");
  });

  it("v2 denies external_directory and places the workspace allows after the deny", () => {
    const config = reviewerPermissionsV2Config({ externalAllow: ["/ws/job-1"] });
    const permissions = config.permissions as Array<{ action: string; resource: string; effect: string }>;
    expect(permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    const external = permissions.filter((rule) => rule.action === "external_directory");
    // Last matching rule wins — the blanket deny must precede the carve-outs.
    expect(external[0]).toEqual({ action: "external_directory", resource: "*", effect: "deny" });
    expect(external).toContainEqual({ action: "external_directory", resource: "/ws/job-1", effect: "allow" });
    expect(external).toContainEqual({ action: "external_directory", resource: "/ws/job-1/**", effect: "allow" });
  });
});
