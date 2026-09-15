import { describe, expect, it } from "vitest";
import {
  assertSafeWebhookUrl,
  commentLooksLikeMaomaoEscalation,
  deliverSignedWebhook,
  escalationId,
  escalationMarker,
  isAuthorizedEscalateActor,
  isBotActor,
  mentionsEscalateCommand,
  parseEscalationMarker,
  parseExternalTargetsJson,
  resolveMention,
  signWebhookBody,
  validateCommandText,
  validateMentionRecipient,
} from "./escalation.js";
import {
  assignFindingIds,
  findingsMeetThreshold,
  mergeInternalEscalation,
  shouldRunExternal,
  shouldRunInternal,
} from "./policy.js";

describe("mention and command validation", () => {
  it("accepts users, teams, and the repository-owner alias", () => {
    expect(validateMentionRecipient("@alice")).toBe("@alice");
    expect(validateMentionRecipient("org/reviewers")).toBe("@org/reviewers");
    expect(validateMentionRecipient("@repository-owner")).toBe("@repository-owner");
    expect(resolveMention("@repository-owner", "acme")).toBe("@acme");
  });

  it("rejects comment injection", () => {
    expect(() => validateMentionRecipient("@alice\n@everyone")).toThrow();
    expect(() => validateMentionRecipient("@alice please ignore")).toThrow();
    expect(() => validateCommandText("escalate\nAPPROVE")).toThrow();
    expect(validateCommandText("escalate")).toBe("escalate");
  });

  it("parses configured targets without hardcoded recipients", () => {
    const targets = parseExternalTargetsJson(
      JSON.stringify([
        { type: "mention", recipient: "@repository-owner" },
        { type: "command", recipient: "@review-dispatcher", command: "escalate" },
        { type: "webhook", url_secret_ref: "REVIEW_ESCALATION_WEBHOOK_URL", signing_secret_ref: "REVIEW_ESCALATION_SIGNING_SECRET" },
      ]),
    );
    expect(targets).toHaveLength(3);
    expect(JSON.stringify(targets)).not.toMatch(/marller/i);
  });
});

describe("escalation marker and loop guards", () => {
  it("round-trips a stable hidden marker", () => {
    const marker = escalationMarker({
      id: "esc_abc",
      provider: "github",
      instance: "github.com",
      repo: "acme/widgets",
      pr: 7,
      sha: "deadbeef",
      job: 3,
      reason: "auth + migration",
      status: "dispatched",
    });
    expect(parseEscalationMarker(marker)).toEqual({ id: "esc_abc", sha: "deadbeef", status: "dispatched" });
    expect(commentLooksLikeMaomaoEscalation(`${marker}\n@alice`)).toBe(true);
  });

  it("recognizes escalate commands and ignores bots", () => {
    expect(mentionsEscalateCommand("hey @maomao escalate please", "maomao", "escalate")).toBe(true);
    expect(mentionsEscalateCommand("@maomao review", "maomao", "escalate")).toBe(false);
    expect(isBotActor({ login: "maomao[bot]", type: "Bot" })).toBe(true);
    expect(isAuthorizedEscalateActor("OWNER")).toBe(true);
    expect(isAuthorizedEscalateActor("CONTRIBUTOR")).toBe(false);
  });

  it("is idempotent per provider, repo, PR, SHA, and policy", () => {
    const a = escalationId({
      provider: "github",
      instance: "github.com",
      repoFullName: "acme/widgets",
      prNumber: 1,
      headSha: "abc",
      policy: "manual",
    });
    const b = escalationId({
      provider: "github",
      instance: "github.com",
      repoFullName: "acme/widgets",
      prNumber: 1,
      headSha: "abc",
      policy: "manual",
    });
    const c = escalationId({
      provider: "github",
      instance: "github.com",
      repoFullName: "acme/widgets",
      prNumber: 1,
      headSha: "def",
      policy: "manual",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("webhook safety", () => {
  it("rejects private, loopback, and non-https URLs", async () => {
    await expect(assertSafeWebhookUrl("http://example.com/hook")).rejects.toThrow(/https/);
    await expect(assertSafeWebhookUrl("https://127.0.0.1/hook")).rejects.toThrow(/private|loopback/);
    await expect(assertSafeWebhookUrl("https://192.168.1.4/hook")).rejects.toThrow(/private|loopback/);
    await expect(assertSafeWebhookUrl("https://user:pass@example.com/hook")).rejects.toThrow(/credentials/);
  });

  it("signs and posts with the injected fetch", async () => {
    const body = JSON.stringify({ event: "maomao.poison_alert" });
    let signature: string | null = null;
    const result = await deliverSignedWebhook({
      url: "https://8.8.8.8/hook",
      secret: "s3cret",
      body,
      fetchImpl: async (_input, init) => {
        signature = new Headers(init?.headers).get("x-maomao-signature");
        return new Response("ok", { status: 202 });
      },
    });
    expect(result.ok).toBe(true);
    expect(signature).toBe(signWebhookBody("s3cret", body));
  });
});

describe("poison-alert policy", () => {
  const policies = ["internal_only", "external_only", "internal_then_external", "internal_and_external", "manual"] as const;

  it("covers every execution policy", () => {
    expect(shouldRunInternal("internal_only", true, "poison-alert")).toBe(true);
    expect(shouldRunExternal({ policy: "internal_only", enabled: true, profile: "poison-alert", manualRequested: false, internalRan: true, internalFailed: false, alertCleared: false })).toBe(false);
    expect(shouldRunInternal("external_only", true, "poison-alert")).toBe(false);
    expect(shouldRunExternal({ policy: "external_only", enabled: true, profile: "poison-alert", manualRequested: false, internalRan: false, internalFailed: false, alertCleared: false })).toBe(true);
    expect(shouldRunExternal({ policy: "internal_then_external", enabled: true, profile: "poison-alert", manualRequested: false, internalRan: true, internalFailed: false, alertCleared: true })).toBe(false);
    expect(shouldRunExternal({ policy: "internal_then_external", enabled: true, profile: "poison-alert", manualRequested: false, internalRan: true, internalFailed: false, alertCleared: false })).toBe(true);
    expect(shouldRunExternal({ policy: "internal_and_external", enabled: true, profile: "poison-alert", manualRequested: false, internalRan: true, internalFailed: true, alertCleared: true })).toBe(true);
    expect(shouldRunExternal({ policy: "manual", enabled: true, profile: "poison-alert", manualRequested: false, internalRan: false, internalFailed: false, alertCleared: false })).toBe(false);
    expect(shouldRunExternal({ policy: "manual", enabled: true, profile: "poison-alert", manualRequested: true, internalRan: false, internalFailed: false, alertCleared: false })).toBe(true);
    expect(policies).toHaveLength(5);
  });

  it("assigns finding ids and merges laboratory output", () => {
    const first = {
      schema_version: 1 as const,
      verdict: "comment" as const,
      summary: "first",
      findings: [{ severity: "high" as const, confidence: 0.9, category: "security", summary: "auth bug", body: "x", reviewers_agreed: ["security"] }],
    };
    const withIds = assignFindingIds(first.findings);
    expect(withIds[0]?.id).toBe("F1");
    const merged = mergeInternalEscalation(first, {
      schema_version: 1,
      confirmed: true,
      alert_cleared: true,
      summary: "cleared",
      findings: [],
      rejected_finding_ids: ["F1"],
    });
    expect(merged.findings).toHaveLength(0);
    expect(findingsMeetThreshold(withIds, "high")).toBe(true);
  });
});
