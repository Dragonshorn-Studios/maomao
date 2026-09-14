import type { JobRow, JobStore, ReviewerRunRow } from "../jobs/store.js";
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
  tokens: number;
  cost: number | null;
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
  let cost = job.aggregator_cost;
  let model = job.aggregator_model;
  let provider = job.aggregator_provider;

  for (const run of runs) {
    promptTokens += run.prompt_tokens ?? 0;
    completionTokens += run.completion_tokens ?? 0;
    if (run.cost != null) cost = (cost ?? 0) + run.cost;
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
    tokens: promptTokens + completionTokens,
    cost,
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

export function findingLocation(finding: { file?: string; line?: number }): string {
  if (!finding.file) return "";
  return finding.line ? `${finding.file}:${finding.line}` : finding.file;
}
