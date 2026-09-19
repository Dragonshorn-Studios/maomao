import { severityRank, type AggregatorFinding, type AggregatorResult, type Severity } from "../schema.js";
import type { InternalEscalationResult } from "./schema.js";
import { POLICIES_WITH_INTERNAL, type PoisonAlertPolicy } from "./types.js";

export function assignFindingIds(findings: AggregatorFinding[]): Array<AggregatorFinding & { id: string }> {
  return findings.map((finding, index) => ({
    ...finding,
    id: (finding as AggregatorFinding & { id?: string }).id || `F${index + 1}`,
  }));
}

export function findingsMeetThreshold(
  findings: Array<{ severity: string }>,
  minSeverity: Severity,
): boolean {
  const threshold = severityRank(minSeverity);
  return findings.some((finding) => severityRank(finding.severity as Severity) <= threshold);
}

export function mergeInternalEscalation(
  firstPass: AggregatorResult,
  lab: InternalEscalationResult,
): AggregatorResult {
  const first = assignFindingIds(firstPass.findings);
  const rejected = new Set(lab.rejected_finding_ids ?? []);
  if (lab.findings.length > 0) {
    const merged = assignFindingIds(
      lab.findings.map((finding) => ({
        severity: finding.severity,
        confidence: finding.confidence,
        category: finding.category,
        file: finding.file,
        line: finding.line,
        summary: finding.summary,
        body: finding.body,
        reviewers_agreed: finding.reviewers_agreed,
      })),
    );
    return {
      schema_version: 1,
      verdict: merged.length > 0 ? "comment" : "clean",
      summary: lab.summary,
      findings: merged,
    };
  }
  const kept = first.filter((finding) => !rejected.has(finding.id));
  return {
    schema_version: 1,
    verdict: kept.length > 0 ? "comment" : "clean",
    summary: lab.summary || firstPass.summary,
    findings: kept,
  };
}

export function shouldRunInternal(policy: PoisonAlertPolicy, enabled: boolean, profile: string): boolean {
  if (!enabled || profile !== "poison-alert") return false;
  return (POLICIES_WITH_INTERNAL as readonly string[]).includes(policy);
}

export function shouldRunExternal(input: {
  policy: PoisonAlertPolicy;
  enabled: boolean;
  profile: string;
  manualRequested: boolean;
  internalRan: boolean;
  internalFailed: boolean;
  alertCleared: boolean;
}): boolean {
  if (!input.enabled || input.profile !== "poison-alert") return false;
  if (input.policy === "manual") return input.manualRequested;
  if (input.policy === "internal_only") return false;
  if (input.policy === "external_only" || input.policy === "internal_and_external") return true;
  if (input.policy === "internal_then_external") {
    if (input.alertCleared) return false;
    if (input.internalFailed) return true;
    if (!input.internalRan) return true;
    return true;
  }
  return false;
}

export function usageOverBudget(input: {
  cost?: number | null;
  tokens?: number | null;
  maxCostUsd: number;
  maxTokens: number;
}): string | undefined {
  if (input.maxCostUsd > 0 && input.cost != null && input.cost > input.maxCostUsd) {
    return `internal escalation cost ${input.cost} exceeded cap ${input.maxCostUsd}`;
  }
  if (input.maxTokens > 0 && input.tokens != null && input.tokens > input.maxTokens) {
    return `internal escalation tokens ${input.tokens} exceeded cap ${input.maxTokens}`;
  }
  return undefined;
}

/**
 * Profile job-wide ceiling check: compares accumulated usage against the
 * profile's optional cost/token ceilings. Missing usage (null) never counts
 * as over budget. A ceiling of 0/undefined disables that check.
 */
export function profileBudgetExceeded(input: {
  cost?: number | null;
  tokens?: number | null;
  maxCostUsd?: number;
  maxTokens?: number;
}): string | undefined {
  if (input.maxCostUsd != null && input.maxCostUsd > 0 && input.cost != null && input.cost > input.maxCostUsd) {
    return `profile total cost ${input.cost} exceeded cap ${input.maxCostUsd}`;
  }
  if (input.maxTokens != null && input.maxTokens > 0 && input.tokens != null && input.tokens > input.maxTokens) {
    return `profile total tokens ${input.tokens} exceeded cap ${input.maxTokens}`;
  }
  return undefined;
}
