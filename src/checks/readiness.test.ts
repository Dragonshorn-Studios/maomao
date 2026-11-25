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
