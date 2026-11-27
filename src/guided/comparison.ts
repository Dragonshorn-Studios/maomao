import { fingerprintFinding, normalizeMeaning, normalizePath } from "../findings/identity.js";
import { LIVE_JOB_STATES } from "../config.js";
import type { JobRow, ReviewerRunRow } from "../jobs/store.js";
import { aggregatorResultSchema, reviewerResultSchema, type AggregatorFinding, type AggregatorResult } from "../schema.js";
import type { FindingStatus } from "../findings/types.js";
import type { GuidedCommentView, GuidedReviewSessionRow } from "./store.js";

export type GuidedComparisonState = "missing" | "pending" | "failed" | "stale" | "ready";
export type GuidedPairDecision = "confirm" | "reject";

export interface GuidedComparisonSide {
  key: string;
  fingerprint: string;
  source: "human" | "maomao";
  summary: string;
  body?: string;
  path?: string;
  line?: number;
  severity?: string;
  category?: string;
  status?: FindingStatus;
  rationale?: string;
}

export interface GuidedComparisonPair {
  human: GuidedComparisonSide;
  maomao: GuidedComparisonSide;
  match: "agreement" | "uncertain";
  confidence: number;
  signals: string[];
  severityDifference?: string;
  confirmed: boolean;
}

export interface GuidedComparisonView {
  state: GuidedComparisonState;
  headSha: string;
  jobId?: number;
  jobState?: string;
  message: string;
  verdictDifference?: string;
  summary: { agreement: number; humanOnly: number; maomaoOnly: number; uncertain: number; verdictDifference: number; inactive: number };
  agreements: GuidedComparisonPair[];
  uncertain: GuidedComparisonPair[];
  humanOnly: GuidedComparisonSide[];
  maomaoOnly: GuidedComparisonSide[];
  inactiveMaomao: GuidedComparisonSide[];
  overrides: Record<string, { fingerprint: string; decision: GuidedPairDecision }>;
}

interface OverrideState { pairs?: Record<string, { fingerprint?: string | null; decision?: string }> }

function tokenSet(text: string): Set<string> {
  return new Set(normalizeMeaning(text).split(" ").filter((part) => part.length > 2));
}

function similarity(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / Math.max(left.size, right.size);
}

function humanSide(comment: GuidedCommentView): GuidedComparisonSide {
  return {
    key: comment.clientId,
    fingerprint: fingerprintFinding({ file: comment.path ?? undefined, category: comment.category ?? undefined, summary: comment.body }),
    source: "human",
    summary: comment.body,
    path: comment.path ?? undefined,
    line: comment.line ?? undefined,
    severity: comment.severity ?? undefined,
    category: comment.category ?? undefined,
    rationale: comment.anchorStatus === "unplaced" ? "Human note is unplaced; location evidence is unavailable." : "Human draft note",
  };
}

function aggregatorFingerprint(finding: AggregatorFinding): string {
  return fingerprintFinding({ file: finding.file, category: finding.category, summary: finding.summary, body: finding.body });
}

interface SpecialistEvidenceEntry {
  fingerprint: string;
  path?: string;
  category?: string;
  summary: string;
  text: string;
}

function specialistEvidence(reviewerRuns: ReviewerRunRow[] | undefined): SpecialistEvidenceEntry[] {
  const evidence: SpecialistEvidenceEntry[] = [];
  for (const run of reviewerRuns ?? []) {
    if (!run.normalized_json) continue;
    try {
      const parsed = reviewerResultSchema.parse(JSON.parse(run.normalized_json));
      for (const finding of parsed.findings) {
        evidence.push({
          fingerprint: fingerprintFinding({ file: finding.file, category: finding.category, summary: finding.summary, reason: finding.reason }),
          path: finding.file,
          category: finding.category,
          summary: finding.summary,
          text: `${run.role}: ${finding.reason.slice(0, 300)}`,
        });
      }
    } catch {
      // A malformed specialist artifact must not hide the authoritative normalized aggregation.
    }
  }
  return evidence;
}

function evidenceFor(finding: AggregatorFinding, fingerprint: string, specialists: SpecialistEvidenceEntry[]): string[] {
  const exact = specialists.filter((entry) => entry.fingerprint === fingerprint).map((entry) => entry.text);
  if (exact.length) return exact.slice(0, 3);
  return specialists
    .filter((entry) => entry.path && finding.file && normalizePath(entry.path) === normalizePath(finding.file) && entry.category === finding.category && similarity(entry.summary, finding.summary) >= 0.6)
    .map((entry) => entry.text)
    .slice(0, 3);
}

function maomaoFindings(job: JobRow, reviewerRuns?: ReviewerRunRow[]): { findings: GuidedComparisonSide[]; malformedAggregation: boolean; malformedReconciliation: boolean } {
  const byFingerprint = new Map<string, GuidedComparisonSide>();
  const specialists = specialistEvidence(reviewerRuns);
  let malformedReconciliation = false;
  const reconciliation = (() => {
    if (!job.reconciliation_json) return {};
    try {
      const parsed = JSON.parse(job.reconciliation_json) as { items?: Array<Record<string, unknown>> };
      if (!Array.isArray(parsed.items)) malformedReconciliation = true;
      return parsed;
    } catch {
      malformedReconciliation = true;
      return {};
    }
  })();
  for (const item of Array.isArray(reconciliation.items) ? reconciliation.items : []) {
    if (typeof item.fingerprint !== "string" || typeof item.summary !== "string") continue;
    const status = typeof item.status === "string" ? item.status as FindingStatus : "open";
    byFingerprint.set(item.fingerprint, {
      key: `maomao-${item.fingerprint}`,
      fingerprint: item.fingerprint,
      source: "maomao",
      summary: item.summary,
      body: typeof item.body === "string" ? item.body : undefined,
      path: typeof item.currentPath === "string" ? item.currentPath : typeof item.originalPath === "string" ? item.originalPath : undefined,
      line: typeof item.currentLine === "number" ? item.currentLine : typeof item.originalLine === "number" ? item.originalLine : undefined,
      severity: typeof item.severity === "string" ? item.severity : undefined,
      category: typeof item.category === "string" ? item.category : undefined,
      status,
      rationale: typeof item.reason === "string" ? item.reason : undefined,
    });
  }
  let aggregated: AggregatorResult;
  try {
    aggregated = aggregatorResultSchema.parse(JSON.parse(job.aggregator_normalized ?? "{}"));
  } catch {
    return { findings: [], malformedAggregation: true, malformedReconciliation };
  }
  for (const finding of aggregated.findings) {
    const fingerprint = aggregatorFingerprint(finding);
    const prior = byFingerprint.get(fingerprint);
    const evidence = evidenceFor(finding, fingerprint, specialists);
    const rationale = [
      prior?.rationale,
      `Aggregator verdict ${aggregated.verdict}; reviewers: ${finding.reviewers_agreed.join(", ") || "not listed"}`,
      evidence.length ? `Specialist evidence: ${evidence.join(" | ")}` : undefined,
    ].filter(Boolean).join(" · ");
    byFingerprint.set(fingerprint, {
      key: `maomao-${fingerprint}`,
      fingerprint,
      source: "maomao",
      summary: finding.summary,
      body: finding.body,
      path: finding.file,
      line: finding.line,
      severity: finding.severity,
      category: finding.category,
      status: prior?.status ?? "open",
      rationale,
    });
  }
  return { findings: [...byFingerprint.values()], malformedAggregation: false, malformedReconciliation };
}

function score(human: GuidedComparisonSide, maomao: GuidedComparisonSide): { score: number; signals: string[] } {
  const signals: string[] = [];
  let score = 0;
  const meaning = similarity(`${human.summary} ${human.body ?? ""}`, `${maomao.summary} ${maomao.body ?? ""}`);
  if (human.fingerprint === maomao.fingerprint) {
    score += 0.48;
    signals.push("finding fingerprint");
  }
  if (meaning >= 0.82) {
    score += 0.34;
    signals.push("same normalized meaning");
  } else if (meaning >= 0.52) {
    score += 0.2;
    signals.push("similar rationale");
  } else {
    score += meaning * 0.16;
  }
  if (human.path && maomao.path && normalizePath(human.path) === normalizePath(maomao.path)) {
    score += 0.18;
    signals.push("same path");
    if (human.line && maomao.line) {
      const distance = Math.abs(human.line - maomao.line);
      if (distance <= 40) {
        score += distance === 0 ? 0.14 : distance <= 8 ? 0.1 : 0.06;
        signals.push(distance === 0 ? "same line" : "nearby shifted line");
      }
    }
  } else if (!human.path || !maomao.path) {
    score -= 0.08;
    signals.push("missing location");
  }
  if (human.category && maomao.category && human.category === maomao.category) {
    score += 0.06;
    signals.push("same category");
  }
  return { score, signals };
}

function pair(human: GuidedComparisonSide, maomao: GuidedComparisonSide, confidence: number, signals: string[], match: "agreement" | "uncertain", confirmed: boolean): GuidedComparisonPair {
  return {
    human,
    maomao,
    match,
    confidence: Math.max(0, Math.min(1, confidence)),
    signals,
    severityDifference: human.severity && maomao.severity && human.severity !== maomao.severity ? `human ${human.severity} vs Maomao ${maomao.severity}` : undefined,
    confirmed,
  };
}

export function comparisonOverrides(value: unknown): Record<string, { fingerprint: string; decision: GuidedPairDecision }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const pairs = (value as OverrideState).pairs;
  if (!pairs || typeof pairs !== "object") return {};
  const out: Record<string, { fingerprint: string; decision: GuidedPairDecision }> = {};
  for (const [key, entry] of Object.entries(pairs)) {
    if ((entry.decision === "confirm" || entry.decision === "reject") && typeof entry.fingerprint === "string" && entry.fingerprint.length > 0) {
      out[key] = { fingerprint: entry.fingerprint, decision: entry.decision };
    }
  }
  return out;
}

export function buildGuidedComparison(input: {
  session: GuidedReviewSessionRow;
  comments: GuidedCommentView[];
  job?: JobRow;
  comparisonState?: unknown;
  reviewerRuns?: ReviewerRunRow[];
}): GuidedComparisonView {
  const visibleComments = input.comments.filter((comment) => !comment.deletedAt);
  const empty = (state: GuidedComparisonState, message: string, job?: JobRow): GuidedComparisonView => ({
    state,
    headSha: input.session.head_sha,
    jobId: job?.id,
    jobState: job?.state,
    message,
    summary: { agreement: 0, humanOnly: visibleComments.length, maomaoOnly: 0, uncertain: 0, verdictDifference: 0, inactive: 0 },
    agreements: [],
    uncertain: [],
    humanOnly: visibleComments.map(humanSide),
    maomaoOnly: [],
    inactiveMaomao: [],
    overrides: comparisonOverrides(input.comparisonState),
  });
  const job = input.job;
  if (!job) return empty("missing", "No Maomao review job exists for this exact head SHA. You can deliberately enqueue the pull through the normal manual review action; it will not be started invisibly, and the comparison will still only use this pinned head.");
  if (job.state === "queued" || LIVE_JOB_STATES.includes(job.state)) return empty("pending", `Maomao review is ${job.state}; human review can continue and this comparison can refresh when aggregation finishes.`, job);
  if (job.state === "failed" || job.state === "cancelled") return empty("failed", `Maomao review ${job.state}; comparison evidence is unavailable.`, job);
  const staleJob = job.state === "stale";
  if (!job.aggregator_normalized) return empty(staleJob ? "stale" : "failed", staleJob ? "Maomao's exact-SHA review is stale and has no normalized aggregator findings to reconstruct." : "Maomao completed without normalized aggregator findings, so comparison cannot be reconstructed.", job);

  const humans = visibleComments.map(humanSide);
  const maomaoResult = maomaoFindings(job, input.reviewerRuns);
  if (maomaoResult.malformedAggregation) return empty("failed", "Maomao's normalized aggregator artifact is malformed, so comparison cannot be reconstructed safely.", job);
  if (maomaoResult.malformedReconciliation) return empty("failed", "Maomao's reconciliation artifact is malformed, so resolved or suppressed statuses cannot be trusted.", job);
  const maomao = maomaoResult.findings;
  const inactiveMaomao = maomao.filter((item) => item.status === "resolved" || item.status === "dismissed");
  const activeMaomao = maomao.filter((item) => item.status !== "resolved" && item.status !== "dismissed");
  const verdictDifference = input.session.draft_verdict && job.review_event && input.session.draft_verdict !== job.review_event ? `human ${input.session.draft_verdict} vs Maomao ${job.review_event}` : undefined;
  const overrides = comparisonOverrides(input.comparisonState);
  const candidates: Array<{ human: GuidedComparisonSide; maomao: GuidedComparisonSide; score: number; signals: string[]; confirmed: boolean }> = [];
  for (const human of humans) {
    for (const item of activeMaomao) {
      const override = overrides[human.key];
      if (override?.decision === "reject" && override.fingerprint === item.fingerprint) continue;
      const scored = score(human, item);
      const meaning = similarity(`${human.summary} ${human.body ?? ""}`, `${item.summary} ${item.body ?? ""}`);
      const confirmed = override?.decision === "confirm" && override.fingerprint === item.fingerprint;
      const semanticEvidence = human.fingerprint === item.fingerprint || meaning >= 0.2;
      if (confirmed || (semanticEvidence && scored.score >= 0.36)) candidates.push({ human, maomao: item, score: confirmed ? 1 : scored.score, signals: scored.signals, confirmed });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const usedHuman = new Set<string>();
  const usedMaomao = new Set<string>();
  const agreements: GuidedComparisonPair[] = [];
  const uncertain: GuidedComparisonPair[] = [];
  for (const candidate of candidates) {
    if (usedHuman.has(candidate.human.key) || usedMaomao.has(candidate.maomao.key)) continue;
    usedHuman.add(candidate.human.key);
    usedMaomao.add(candidate.maomao.key);
    const agreement = candidate.confirmed || candidate.score >= 0.72;
    const signals = candidate.confirmed && !candidate.signals.length ? ["human-confirmed pairing"] : candidate.signals;
    (agreement ? agreements : uncertain).push(pair(candidate.human, candidate.maomao, candidate.score, signals, agreement ? "agreement" : "uncertain", candidate.confirmed));
  }
  const humanOnly = humans.filter((item) => !usedHuman.has(item.key));
  const maomaoOnly = activeMaomao.filter((item) => !usedMaomao.has(item.key));
  const pairs = [...agreements, ...uncertain];
  return {
    state: staleJob ? "stale" : "ready",
    headSha: input.session.head_sha,
    jobId: job.id,
    jobState: job.state,
    verdictDifference,
    message: staleJob ? "Maomao's exact-SHA review is stale because the pull moved; these pinned artifacts are still shown separately and never mixed with newer results." : "Comparison is pinned to this exact head SHA and never mutates Maomao findings or the human draft.",
    summary: {
      agreement: agreements.length,
      humanOnly: humanOnly.length,
      maomaoOnly: maomaoOnly.length,
      uncertain: uncertain.length,
      verdictDifference: pairs.filter((item) => item.severityDifference).length + (verdictDifference ? 1 : 0),
      inactive: inactiveMaomao.length,
    },
    agreements,
    uncertain,
    humanOnly,
    maomaoOnly,
    inactiveMaomao,
    overrides,
  };
}
