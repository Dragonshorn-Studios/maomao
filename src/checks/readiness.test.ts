import { describe, expect, it } from "vitest";
import { mergeReadinessDecision } from "./readiness.js";

describe("mergeReadinessDecision", () => {
  it("passes only when required exact inputs are successful", () => {
    expect(mergeReadinessDecision({
      reviewConclusion: "success",
      requireReview: true,
      requiredChecks: ["secrets"],
      results: [{ name: "maomao/secrets", status: "success" }],
    })).toMatchObject({ conclusion: "success" });
  });

  it("fails on review or deterministic check failure", () => {
    expect(mergeReadinessDecision({
      reviewConclusion: "failure",
      requireReview: false,
      requiredChecks: [],
      results: [],
    }).conclusion).toBe("failure");
    expect(mergeReadinessDecision({
      reviewConclusion: "success",
      requireReview: false,
      requiredChecks: ["secrets"],
      results: [{ name: "maomao/secrets", status: "failure" }],
    }).conclusion).toBe("failure");
  });

  it("requires action for missing, skipped, or scanner-error inputs", () => {
    for (const results of [
      [],
      [{ name: "maomao/secrets", status: "skipped" }],
      [{ name: "maomao/secrets", status: "error" }],
    ]) {
      expect(mergeReadinessDecision({
        reviewConclusion: "success",
        requireReview: false,
        requiredChecks: ["secrets"],
        results,
      }).conclusion).toBe("action_required");
    }
  });

  it("can require a clean review verdict explicitly", () => {
    expect(mergeReadinessDecision({
      reviewConclusion: "neutral",
      requireReview: true,
      requiredChecks: [],
      results: [],
    }).conclusion).toBe("failure");
  });
});

describe("guided human attention input", () => {
  const base = { reviewConclusion: "success", requireReview: false, requiredChecks: [], results: [] };

  it("makes a missing poison-alert decision action_required without weakening review or check failures", () => {
    expect(mergeReadinessDecision({ ...base, humanAttention: { state: "waiting", detail: "decision required" } })).toMatchObject({
      conclusion: "action_required",
      detail: "unavailable: guided human attention decision missing",
    });
    expect(mergeReadinessDecision({ ...base, reviewConclusion: "failure", humanAttention: { state: "waiting", detail: "decision required" } }).conclusion).toBe("failure");
  });

  it("keeps satisfied and auto-continued attention auditable in successful readiness", () => {
    expect(mergeReadinessDecision({ ...base, humanAttention: { state: "satisfied", detail: "delegated by github:1001" } }).detail).toContain("guided human attention: delegated by github:1001");
    expect(mergeReadinessDecision({ ...base, humanAttention: { state: "auto_continue", detail: "grace expired" } }).detail).toContain("grace expired");
  });
});
