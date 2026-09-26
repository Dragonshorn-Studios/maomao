import { describe, expect, it } from "vitest";
import { resolveReviewEvent, type ReviewEventInput } from "./verdict.js";

function input(overrides: Partial<ReviewEventInput> = {}): ReviewEventInput {
  return {
    allowApprove: true,
    allowRequestChanges: true,
    minSeverity: "blocker",
    clean: true,
    findings: [],
    allReviewersDone: true,
    aggregatorFallback: false,
    stale: false,
    ...overrides,
  };
}

describe("review event resolution", () => {
  it("approves a clean review only when enabled", () => {
    expect(resolveReviewEvent(input())).toEqual({
      event: "APPROVE",
      reason: "clean review, all reviewers finished",
    });
    expect(resolveReviewEvent(input({ allowApprove: false })).event).toBe("COMMENT");
  });

  it("never approves when a reviewer did not finish or the aggregator fell back", () => {
    const degraded = input({ clean: false, findings: [] });
    expect(resolveReviewEvent({ ...degraded, allReviewersDone: false }).event).toBe("COMMENT");
    expect(resolveReviewEvent({ ...degraded, aggregatorFallback: true }).event).toBe("COMMENT");
    expect(resolveReviewEvent(input({ stale: true })).event).toBe("COMMENT");
  });

  it("escalates to request-changes only for findings at or above the threshold", () => {
    const findings = [{ severity: "blocker" }, { severity: "medium" }];
    const result = resolveReviewEvent(input({ clean: false, findings }));
    expect(result.event).toBe("REQUEST_CHANGES");
    expect(result.reason).toContain("1 finding(s)");

    const below = resolveReviewEvent(input({ clean: false, findings: [{ severity: "high" }] }));
    expect(below.event).toBe("COMMENT");
    const atThreshold = resolveReviewEvent(
      input({ clean: false, findings: [{ severity: "high" }], minSeverity: "high" }),
    );
    expect(atThreshold.event).toBe("REQUEST_CHANGES");
  });

  it("downgrades to comment and preserves the reason when request-changes is disabled", () => {
    const result = resolveReviewEvent(
      input({ clean: false, allowRequestChanges: false, findings: [{ severity: "blocker" }] }),
    );
    expect(result.event).toBe("COMMENT");
    expect(result.reason).toContain("request-changes disabled");
    expect(result.reason).toContain("1 finding(s)");
  });

  it("treats a finding more severe than the threshold as qualifying", () => {
    const result = resolveReviewEvent(
      input({ clean: false, findings: [{ severity: "blocker" }], minSeverity: "high" }),
    );
    expect(result.event).toBe("REQUEST_CHANGES");
  });

  it("comments for findings below the threshold with no approval to give", () => {
    const result = resolveReviewEvent(input({ clean: false, findings: [{ severity: "low" }] }));
    expect(result).toEqual({ event: "COMMENT", reason: "findings below the request-changes threshold" });
  });

  it("approves findings at or below the approve ceiling", () => {
    const result = resolveReviewEvent(
      input({ clean: false, approveMaxSeverity: "low", findings: [{ severity: "low" }, { severity: "info" }] }),
    );
    expect(result).toEqual({ event: "APPROVE", reason: "no findings above low severity" });
  });

  it("still comments when a finding exceeds the approve ceiling", () => {
    const result = resolveReviewEvent(
      input({ clean: false, approveMaxSeverity: "low", findings: [{ severity: "medium" }] }),
    );
    expect(result.event).toBe("COMMENT");
    expect(result.reason).toContain("above the approve ceiling");
    expect(result.reason).toContain("below request-changes threshold");
  });

  it("never approves over the ceiling when approve is disabled or the run is degraded", () => {
    const findings = [{ severity: "low" }];
    expect(
      resolveReviewEvent(input({ clean: false, approveMaxSeverity: "low", allowApprove: false, findings })).event,
    ).toBe("COMMENT");
    expect(
      resolveReviewEvent(input({ clean: false, approveMaxSeverity: "low", allReviewersDone: false, findings })).event,
    ).toBe("COMMENT");
    expect(
      resolveReviewEvent(input({ clean: false, approveMaxSeverity: "low", aggregatorFallback: true, findings })).event,
    ).toBe("COMMENT");
  });

  it("approves an empty publishable set when the aggregator was not clean", () => {
    // A profile's minPublishableSeverity can filter every finding out, leaving
    // verdict "comment" but nothing to publish — the ceiling treats that as
    // approvable noise, not a clean review.
    const result = resolveReviewEvent(input({ clean: false, approveMaxSeverity: "low", findings: [] }));
    expect(result.event).toBe("APPROVE");
    expect(result.reason).toContain("no findings above low");
  });

  it("never approves a stale job even when findings sit under the ceiling", () => {
    const result = resolveReviewEvent(
      input({ clean: false, approveMaxSeverity: "low", stale: true, findings: [{ severity: "low" }] }),
    );
    expect(result.event).toBe("COMMENT");
  });

  it("keeps request-changes precedence over the approve ceiling", () => {
    const result = resolveReviewEvent(
      input({
        clean: false,
        approveMaxSeverity: "high",
        minSeverity: "blocker",
        findings: [{ severity: "blocker" }, { severity: "low" }],
      }),
    );
    expect(result.event).toBe("REQUEST_CHANGES");
  });
});
