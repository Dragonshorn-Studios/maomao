import type { AggregatorFinding } from "../schema.js";
import { fingerprintFinding, type FindingIdentity } from "./identity.js";
import type { FindingRow } from "./types.js";

/**
 * Publication bar for turning a scan finding into a GitHub issue: the aggregator
 * must have seen it with high confidence and at least two agreeing specialists.
 * Speculative single-observer notes stay in the UI but are never publishable.
 */
export const ISSUE_MIN_CONFIDENCE = 0.7;
export const ISSUE_MIN_AGREEMENT = 2;

export type IssueWorthiness = { worthy: true } | { worthy: false; reason: string };

/**
 * Maps persisted fingerprints to their aggregator records by re-hashing the
 * snapshot's findings. An unreadable or malformed snapshot yields an empty
 * map, which marks every finding unworthy — fail closed, never publish
 * without provenance.
 */
export function parseAggregatedFindings(
  aggregatorNormalized: string | null | undefined,
  context = "unknown job",
): Map<string, AggregatorFinding> {
  const byFingerprint = new Map<string, AggregatorFinding>();
  if (!aggregatorNormalized) return byFingerprint;
  let parsed: unknown;
  try {
    parsed = JSON.parse(aggregatorNormalized);
  } catch (error) {
    console.warn(
      `issue-worthiness: ${context}: unreadable aggregator snapshot: ${error instanceof Error ? error.message : String(error)}`,
    );
    return byFingerprint;
  }
  const findings = (parsed as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(findings)) {
    console.warn(`issue-worthiness: ${context}: aggregator snapshot has no findings array; treating as empty`);
    return byFingerprint;
  }
  for (const finding of findings as AggregatorFinding[]) {
    byFingerprint.set(fingerprintFinding(finding as FindingIdentity), finding);
  }
  return byFingerprint;
}

export function issueWorthiness(finding: FindingRow, aggregated: AggregatorFinding | undefined): IssueWorthiness {
  if (!aggregated) return { worthy: false, reason: "missing from the aggregator snapshot" };
  const confidence = aggregated.confidence ?? 0;
  const agreed = [...new Set(aggregated.reviewers_agreed ?? [])];
  if (confidence < ISSUE_MIN_CONFIDENCE) {
    return {
      worthy: false,
      reason: `confidence ${Math.round(confidence * 100)}% is below the ${Math.round(ISSUE_MIN_CONFIDENCE * 100)}% publication bar`,
    };
  }
  if (agreed.length < ISSUE_MIN_AGREEMENT) {
    return {
      worthy: false,
      reason: `only ${agreed.length} specialist(s) agreed — ${ISSUE_MIN_AGREEMENT} required for publication`,
    };
  }
  return { worthy: true };
}
