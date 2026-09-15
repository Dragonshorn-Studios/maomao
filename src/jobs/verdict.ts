import type { Severity } from "../schema.js";
import { severityRank } from "../schema.js";
import type { ReviewEvent } from "../github/client.js";

export interface ReviewEventInput {
  allowApprove: boolean;
  allowRequestChanges: boolean;
  minSeverity: Severity;
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
  if (input.clean) {
    if (input.allowApprove) {
      return { event: "APPROVE", reason: "clean review, all reviewers finished" };
    }
    return { event: "COMMENT", reason: "approve disabled; comment-only" };
  }
  return { event: "COMMENT", reason: "findings below the request-changes threshold" };
}
