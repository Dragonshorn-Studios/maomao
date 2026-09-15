import type { Config } from "../config.js";
import type { ClassifiedFinding } from "../findings/types.js";
import { currentFindingsForRisk } from "../findings/types.js";

export type ReviewProfile = "observation" | "diagnosis" | "poison-alert";

export interface RiskRouteInput {
  diff: string;
  headSha: string;
  currentFindings: ClassifiedFinding[];
}

export interface RiskRouteResult {
  profile: ReviewProfile;
  reviewers: string[];
  reason: string;
  findingFingerprints: string[];
}

/**
 * Insertion point for the later poison-alert specialist router.
 * Reconciliation must call this only after classifying prior findings so
 * resolved/dismissed items cannot inflate risk or trigger escalation.
 */
export function routeReviewProfile(config: Config, input: RiskRouteInput): RiskRouteResult {
  const current = currentFindingsForRisk(input.currentFindings);
  return {
    profile: "diagnosis",
    reviewers: config.reviewers.map((role) => role.id),
    reason: "fixed reviewer set; poison-alert router not enabled",
    findingFingerprints: current.map((item) => item.fingerprint),
  };
}
