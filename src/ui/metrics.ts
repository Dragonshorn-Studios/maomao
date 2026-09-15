import type { JobRow, JobStore, ReviewerRunRow } from "../jobs/store.js";
import { tokenTotalFromRow } from "../opencode/parse.js";
import type { AggregatorFinding, AggregatorResult, ReviewerFinding, ReviewerResult } from "../schema.js";
import { safeJsonParse } from "../util.js";

export interface SeverityCounts {
  blocker: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  total: number;
}

export interface JobMetrics {
  reviewersDone: number;
  reviewersTotal: number;
  reviewersFailed: number;
  reviewerStates: string[];
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  tokens: number;
  cost: number | null;
  usageComplete: boolean;
  usageWarning: string | null;
  model: string | null;
  provider: string | null;
  findings: SeverityCounts;
  specialistFindings: Array<ReviewerFinding & { role: string }>;
  aggregator: AggregatorResult | null;
  findingsConfirmed: boolean;
}

const EMPTY_COUNTS = (): SeverityCounts => ({
  blocker: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
  total: 0,
});

export function countSeverities(items: { severity: string }[]): SeverityCounts {
  const counts = EMPTY_COUNTS();
  for (const item of items) {
    if (item.severity in counts && item.severity !== "total") {
      counts[item.severity as keyof Omit<SeverityCounts, "total">] += 1;
      counts.total += 1;
    } else {
      counts.total += 1;
    }
  }
  return counts;
}

export function parseReviewerResult(raw: string | null): ReviewerResult | null {
  if (!raw) return null;
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const result = parsed as Partial<ReviewerResult>;
  if (!Array.isArray(result.findings)) return null;
  return result as ReviewerResult;
}

export function parseAggregatorResult(raw: string | null): AggregatorResult | null {
  if (!raw) return null;
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const result = parsed as Partial<AggregatorResult>;
  if (typeof result.verdict !== "string") return null;
  return {
    schema_version: result.schema_version ?? 1,
    verdict: result.verdict as AggregatorResult["verdict"],
    summary: result.summary ?? "",
    findings: Array.isArray(result.findings) ? (result.findings as AggregatorFinding[]) : [],
  };
}

export function jobMetrics(job: JobRow, store: JobStore): JobMetrics {
  return jobMetricsFromRuns(job, store.listReviewerRuns(job.id));
}

export function jobMetricsFromRuns(job: JobRow, runs: ReviewerRunRow[]): JobMetrics {
  const specialistFindings: Array<ReviewerFinding & { role: string }> = [];
  let promptTokens = job.aggregator_prompt_tokens ?? 0;
  let completionTokens = job.aggregator_completion_tokens ?? 0;
  let reasoningTokens = job.aggregator_reasoning_tokens ?? 0;
  let cacheReadTokens = job.aggregator_cache_read_tokens ?? 0;
  let cacheWriteTokens = job.aggregator_cache_write_tokens ?? 0;
  let tokens = tokenTotalFromRow({
    total_tokens: job.aggregator_total_tokens,
    prompt_tokens: job.aggregator_prompt_tokens,
    completion_tokens: job.aggregator_completion_tokens,
    reasoning_tokens: job.aggregator_reasoning_tokens,
    cache_read_tokens: job.aggregator_cache_read_tokens,
    cache_write_tokens: job.aggregator_cache_write_tokens,
  });
  let cost = job.aggregator_cost;
  let model = job.aggregator_model;
  let provider = job.aggregator_provider;
  const completeness: Array<number | null> = [job.aggregator_usage_complete];
  const warnings: string[] = [];
  if (job.aggregator_usage_warning) warnings.push(job.aggregator_usage_warning);

  tokens += tokenTotalFromRow({
    total_tokens: job.routing_total_tokens,
    prompt_tokens: job.routing_prompt_tokens,
    completion_tokens: job.routing_completion_tokens,
  });
  promptTokens += job.routing_prompt_tokens ?? 0;
  completionTokens += job.routing_completion_tokens ?? 0;
  if (job.routing_cost != null) cost = (cost ?? 0) + job.routing_cost;
  completeness.push(job.routing_usage_complete);
  if (job.routing_usage_warning) warnings.push(job.routing_usage_warning);

  tokens += tokenTotalFromRow({
    total_tokens: job.internal_escalation_total_tokens,
    prompt_tokens: job.internal_escalation_prompt_tokens,
    completion_tokens: job.internal_escalation_completion_tokens,
  });
  promptTokens += job.internal_escalation_prompt_tokens ?? 0;
  completionTokens += job.internal_escalation_completion_tokens ?? 0;
  if (job.internal_escalation_cost != null) cost = (cost ?? 0) + job.internal_escalation_cost;
  completeness.push(job.internal_escalation_usage_complete);
  if (job.internal_escalation_usage_warning) warnings.push(job.internal_escalation_usage_warning);

  for (const run of runs) {
    promptTokens += run.prompt_tokens ?? 0;
    completionTokens += run.completion_tokens ?? 0;
    reasoningTokens += run.reasoning_tokens ?? 0;
    cacheReadTokens += run.cache_read_tokens ?? 0;
    cacheWriteTokens += run.cache_write_tokens ?? 0;
    tokens += tokenTotalFromRow(run);
    if (run.cost != null) cost = (cost ?? 0) + run.cost;
    completeness.push(run.usage_complete);
    if (run.usage_warning) warnings.push(`${run.role}: ${run.usage_warning}`);
    if (!model && run.model) model = run.model;
    if (!provider && run.provider) provider = run.provider;
    const parsed = parseReviewerResult(run.normalized_json);
    if (parsed) {
      for (const finding of parsed.findings) {
        specialistFindings.push({ ...finding, role: run.role });
      }
    }
  }

  const aggregator = parseAggregatorResult(job.aggregator_normalized);
  const findingsConfirmed = job.aggregator_state === "done" && aggregator != null;
  const findings = countSeverities(
    findingsConfirmed ? (aggregator?.findings ?? []) : specialistFindings,
  );

  return {
    reviewersDone: runs.filter((run) => run.state === "done").length,
    reviewersTotal: runs.length,
    reviewersFailed: runs.filter((run) => run.state === "failed").length,
    reviewerStates: runs.map((run) => run.state),
    promptTokens,
    completionTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    tokens,
    cost,
    usageComplete: completeness.every((value) => value == null || value === 1),
    usageWarning: warnings[0] ?? null,
    model,
    provider,
    findings,
    specialistFindings,
    aggregator,
    findingsConfirmed,
  };
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(2).replace(/0$/, "")}k`;
  return String(Math.round(n));
}

export function formatCost(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatUsageBreakdown(parts: {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): string | undefined {
  const bits: string[] = [];
  if (parts.promptTokens) bits.push(`in ${formatTokens(parts.promptTokens)}`);
  if (parts.completionTokens) bits.push(`out ${formatTokens(parts.completionTokens)}`);
  if (parts.reasoningTokens) bits.push(`reasoning ${formatTokens(parts.reasoningTokens)}`);
  if (parts.cacheReadTokens || parts.cacheWriteTokens) {
    bits.push(`cache r ${formatTokens(parts.cacheReadTokens ?? 0)} / w ${formatTokens(parts.cacheWriteTokens ?? 0)}`);
  }
  return bits.length > 2 || parts.reasoningTokens || parts.cacheReadTokens || parts.cacheWriteTokens
    ? bits.join(" · ")
    : undefined;
}

export function findingLocation(finding: { file?: string; line?: number }): string {
  if (!finding.file) return "";
  return finding.line ? `${finding.file}:${finding.line}` : finding.file;
}

/** Permalink to the exact reviewed revision on GitHub; null for non-GitHub or unknown paths. */
export function githubFileLink(
  prHtmlUrl: string | null | undefined,
  sha: string | null | undefined,
  path: string,
  line?: number | null,
): string | null {
  if (!prHtmlUrl || !sha || !prHtmlUrl.startsWith("https://github.com/")) return null;
  const match = prHtmlUrl.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\//);
  if (!match?.[1]) return null;
  const clean = path.replace(/[^A-Za-z0-9._\-/]/g, "");
  if (!clean || clean.includes("..")) return null;
  return `${match[1]}/blob/${sha}/${clean}${line ? `#L${line}` : ""}`;
}
