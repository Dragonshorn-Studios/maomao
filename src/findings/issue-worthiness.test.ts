import { describe, expect, it, vi } from "vitest";
import type { AggregatorFinding } from "../schema.js";
import { ISSUE_MIN_AGREEMENT, ISSUE_MIN_CONFIDENCE, issueWorthiness, parseAggregatedFindings } from "./issue-worthiness.js";
import { fingerprintFinding } from "./identity.js";

function aggregated(overrides: Partial<AggregatorFinding> = {}): AggregatorFinding {
  return {
    severity: "high",
    confidence: 0.9,
    category: "correctness",
    file: "a.ts",
    line: 2,
    summary: "secret logged",
    body: "evidence",
    reviewers_agreed: ["correctness", "security"],
    ...overrides,
  };
}

describe("issueWorthiness", () => {
  it("treats the bar as inclusive: exactly the thresholds pass", () => {
    expect(ISSUE_MIN_CONFIDENCE).toBe(0.7);
    expect(ISSUE_MIN_AGREEMENT).toBe(2);
    expect(issueWorthiness(aggregated({ confidence: 0.7, reviewers_agreed: ["a", "b"] }))).toEqual({ worthy: true });
  });

  it("rejects low confidence with the confidence reason", () => {
    expect(issueWorthiness(aggregated({ confidence: 0.69, reviewers_agreed: ["a", "b"] }))).toEqual({
      worthy: false,
      reason: expect.stringContaining("below the 70% publication bar"),
    });
  });

  it("rejects a single specialist with the consensus reason", () => {
    expect(issueWorthiness(aggregated({ confidence: 0.95, reviewers_agreed: ["a"] }))).toEqual({
      worthy: false,
      reason: expect.stringContaining("only 1 specialist(s) agreed"),
    });
  });

  it("deduplicates agreeing specialists before counting", () => {
    expect(issueWorthiness(aggregated({ reviewers_agreed: ["a", "a"] }))).toEqual({
      worthy: false,
      reason: expect.stringContaining("only 1 specialist(s) agreed"),
    });
  });

  it("fails closed when confidence or agreement are missing", () => {
    expect(issueWorthiness(aggregated({ confidence: undefined }))).toEqual({
      worthy: false,
      reason: expect.stringContaining("below the 70% publication bar"),
    });
    expect(issueWorthiness(aggregated({ reviewers_agreed: undefined }))).toEqual({
      worthy: false,
      reason: expect.stringContaining("only 0 specialist(s) agreed"),
    });
  });

  it("fails closed when the finding is absent from the snapshot", () => {
    expect(issueWorthiness(undefined)).toEqual({
      worthy: false,
      reason: expect.stringContaining("missing from the aggregator snapshot"),
    });
  });
});

describe("parseAggregatedFindings", () => {
  it("maps snapshot findings by recomputed fingerprint", () => {
    const snapshot = { findings: [aggregated()] };
    const map = parseAggregatedFindings(JSON.stringify(snapshot));
    expect(map.get(fingerprintFinding(aggregated()))).toBeDefined();
  });

  it("returns an empty map for null or empty snapshots", () => {
    expect(parseAggregatedFindings(null).size).toBe(0);
    expect(parseAggregatedFindings(undefined).size).toBe(0);
    expect(parseAggregatedFindings("").size).toBe(0);
  });

  it("returns an empty map — not an exception — for malformed snapshots", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseAggregatedFindings("{not json", "job 9").size).toBe(0);
    expect(parseAggregatedFindings('{"findings": "oops"}', "job 9").size).toBe(0);
    expect(parseAggregatedFindings('{"summary": "no findings key"}', "job 9").size).toBe(0);
    expect(parseAggregatedFindings('["a", "b"]', "job 9").size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  it("skips elements that fail the aggregator schema instead of crashing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // `{}` has no summary: fingerprinting it would throw a TypeError.
    const snapshot = { findings: [{}, aggregated()] };
    const map = parseAggregatedFindings(JSON.stringify(snapshot), "job 9");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(map.size).toBe(1);
    expect(map.get(fingerprintFinding(aggregated()))).toBeDefined();
    warn.mockRestore();
  });
});
