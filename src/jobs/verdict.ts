import type { Severity } from "../schema.js";
import { severityRank } from "../schema.js";
import type { ForgeVerdict } from "../forge/types.js";

/** Historical name for the persisted verdict vocabulary; forge-neutral since #18. */
export type ReviewEvent = ForgeVerdict;

export interface ReviewEventInput {
  allowApprove: boolean;
  allowRequestChanges: boolean;
  minSeverity: Severity;
  /**
   * Highest severity that still permits APPROVE (e.g. "low" approves reviews whose
   * worst findings are low/info). Undefined keeps the strict rule: APPROVE only
   * when the review is clean.
   */
  approveMaxSeverity?: Severity | null;
  /** True when the aggregated review produced no publishable findings and verdict "clean". */
  clean: boolean;
  findings: Array<{ severity?: string | null }>;
  allReviewersDone: boolean;
  aggregatorFallback: boolean;
  stale: boolean;
}

export interface ReviewEventDecision {
  event: ReviewEvent;
  reason: string;
}

/**
 * The only place a GitHub review event is chosen. Specialists and the aggregator never
 * select the event; verdicts degrade to COMMENT unless every safety gate passes.
 */
export function resolveReviewEvent(input: ReviewEventInput): ReviewEventDecision {
  if (input.stale) {
    return { event: "COMMENT", reason: "job is stale; comment-only" };
  }
  if (!input.allReviewersDone) {
    return { event: "COMMENT", reason: "one or more reviewers did not finish cleanly; comment-only" };
  }
  if (input.aggregatorFallback) {
    return { event: "COMMENT", reason: "aggregator used the deterministic fallback; comment-only" };
  }
  // severityRank is inverted: blocker=0 is the most severe, so "at or above the
  // threshold" means rank <= threshold rank (same convention as findingsMeetThreshold).
  const threshold = severityRank(input.minSeverity);
  const blockerCount = input.findings.filter(
    (finding) => severityRank((finding.severity ?? "info") as Severity) <= threshold,
  ).length;
  if (blockerCount > 0) {
    if (input.allowRequestChanges) {
      return {
        event: "REQUEST_CHANGES",
        reason: `${blockerCount} finding(s) at or above ${input.minSeverity} severity`,
      };
    }
    return { event: "COMMENT", reason: `request-changes disabled; ${blockerCount} finding(s) at or above ${input.minSeverity}` };
  }
  // "At or below" the approve ceiling means rank >= its rank (rank is inverted).
  const belowApproveCeiling =
    input.approveMaxSeverity != null &&
    input.findings.every(
      (finding) =>
        severityRank((finding.severity ?? "info") as Severity) >= severityRank(input.approveMaxSeverity as Severity),
    );
  if (input.clean || belowApproveCeiling) {
    if (input.allowApprove) {
      return {
        event: "APPROVE",
        reason: input.clean
          ? "clean review, all reviewers finished"
          : `no findings above ${input.approveMaxSeverity} severity`,
      };
    }
    return { event: "COMMENT", reason: "approve disabled; comment-only" };
  }
  return { event: "COMMENT", reason: "findings below the request-changes threshold" };
}
