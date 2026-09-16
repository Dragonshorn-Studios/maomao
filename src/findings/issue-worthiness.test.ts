import { describe, expect, it, vi } from "vitest";
import type { AggregatorFinding } from "../schema.js";
import type { FindingRow } from "./types.js";
import { ISSUE_MIN_AGREEMENT, ISSUE_MIN_CONFIDENCE, issueWorthiness, parseAggregatedFindings } from "./issue-worthiness.js";
import { fingerprintFinding } from "./identity.js";

function findingRow(overrides: Partial<FindingRow> = {}): FindingRow {
  return {
    id: 1,
    repo_full_name: "acme/widgets",
    pr_number: 0,
    fingerprint: "fp0000000000000001",
    status: "open",
    reviewed_sha: "head",
    current_sha: "head",
    github_thread_id: null,
    github_comment_id: null,
    original_path: "a.ts",
    original_line: 2,
    current_path: "a.ts",
    current_line: 2,
    category: "correctness",
    summary: "secret logged",
    body: "evidence",
    severity: "high",
    confidence: 0.9,
    dismissed_by: null,
    dismissed_at: null,
    dismiss_command: null,
    reopened_by: null,
    reopened_at: null,
    reopen_command: null,
    reconciliation_confidence: null,
    reconciliation_reason: null,
    diff_hunk: null,
    diff_note: null,
    last_job_id: 1,
    created_at: "now",
    updated_at: "now",
    ...overrides,
  };
}

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
    const worth = issueWorthiness(findingRow(), aggregated({ confidence: 0.7, reviewers_agreed: ["a", "b"] }));
    expect(worth).toEqual({ worthy: true });
  });

  it("rejects low confidence with the confidence reason", () => {
    const worth = issueWorthiness(findingRow(), aggregated({ confidence: 0.69, reviewers_agreed: ["a", "b"] }));
    expect(worth).toEqual({ worthy: false, reason: expect.stringContaining("below the 70% publication bar") });
  });

  it("rejects a single specialist with the consensus reason", () => {
    const worth = issueWorthiness(findingRow(), aggregated({ confidence: 0.95, reviewers_agreed: ["a"] }));
    expect(worth).toEqual({ worthy: false, reason: expect.stringContaining("only 1 specialist(s) agreed") });
  });

  it("deduplicates agreeing specialists before counting", () => {
    const worth = issueWorthiness(findingRow(), aggregated({ reviewers_agreed: ["a", "a"] }));
    expect(worth).toEqual({ worthy: false, reason: expect.stringContaining("only 1 specialist(s) agreed") });
  });

  it("fails closed when confidence or agreement are missing", () => {
    expect(issueWorthiness(findingRow(), aggregated({ confidence: undefined }))).toEqual({
      worthy: false,
      reason: expect.stringContaining("below the 70% publication bar"),
    });
    expect(issueWorthiness(findingRow(), aggregated({ reviewers_agreed: undefined }))).toEqual({
      worthy: false,
      reason: expect.stringContaining("only 0 specialist(s) agreed"),
    });
  });

  it("fails closed when the finding is absent from the snapshot", () => {
    expect(issueWorthiness(findingRow(), undefined)).toEqual({
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
});
