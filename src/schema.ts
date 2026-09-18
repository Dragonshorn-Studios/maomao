import { z } from "zod";

export const severitySchema = z.enum(["blocker", "high", "medium", "low", "info"]);
export type Severity = z.infer<typeof severitySchema>;

export const reviewerFindingSchema = z.object({
  severity: severitySchema,
  confidence: z.number().min(0).max(1),
  category: z.string().min(1),
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
  summary: z.string().min(1),
  reason: z.string().min(1),
  suggested_check: z.string().optional(),
});
export type ReviewerFinding = z.infer<typeof reviewerFindingSchema>;

export const reviewerResultSchema = z.object({
  schema_version: z.number().int().optional().default(1),
  reviewer: z.string().min(1),
  verdict: z.enum(["findings", "clean", "inconclusive"]),
  summary: z.string().optional().default(""),
  findings: z.array(reviewerFindingSchema).default([]),
});
export type ReviewerResult = z.infer<typeof reviewerResultSchema>;

export const aggregatorFindingSchema = z.object({
  id: z.string().min(1).optional(),
  severity: severitySchema,
  confidence: z.number().min(0).max(1).optional().default(0.5),
  category: z.string().min(1).optional().default("general"),
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  summary: z.string().min(1),
  body: z.string().min(1).optional(),
  reviewers_agreed: z.array(z.string()).optional().default([]),
});
export type AggregatorFinding = z.infer<typeof aggregatorFindingSchema>;

export const aggregatorResultSchema = z.object({
  schema_version: z.number().int().optional().default(1),
  verdict: z.enum(["comment", "clean"]),
  summary: z.string().min(1),
  findings: z.array(aggregatorFindingSchema).default([]),
});
export type AggregatorResult = z.infer<typeof aggregatorResultSchema>;

export const verifierClassificationSchema = z.object({
  fingerprint: z.string().min(1),
  status: z.enum(["resolved", "still_valid", "moved", "uncertain"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
});
export type VerifierClassification = z.infer<typeof verifierClassificationSchema>;

export const verifierResultSchema = z.object({
  schema_version: z.number().int().optional().default(1),
  classifications: z.array(verifierClassificationSchema).default([]),
});
export type VerifierResult = z.infer<typeof verifierResultSchema>;

export function parseVerifierResult(raw: string): VerifierResult {
  // Sentinel stripping only: classifications are never dropped as placeholders.
  return verifierResultSchema.parse(
    normalizeLocationSentinels(extractJsonFromText(raw), "classifications"),
  );
}

/**
 * Normalization boundary between JSON extraction and strict validation.
 * Models serialize "no location" as sentinel values (`file: ""`, `line: 0`,
 * `null`, whitespace) instead of omitting the keys; that representation must
 * not fail an otherwise valid result. Empty optional prose (`suggested_check`)
 * is stripped the same way. Only the unambiguous "absent" sentinels are
 * removed — negative, non-integer, or wrongly-typed values are left for
 * strict validation to reject. A finding that carries no informational
 * content at all (no location on any key, no summary/reason/body prose) is a
 * placeholder and is dropped rather than rendered; the drop is reported
 * through `onDrop` so callers can leave an audit trace. Verifier
 * classifications are never dropped — a fingerprint/status decision is
 * substance even without prose, and losing one silently would mislabel a
 * prior as unclassified. Returns a cloned value; the input is not mutated.
 */
export function normalizeLocationSentinels(
  raw: unknown,
  itemsKey: "findings" | "classifications" = "findings",
  onDrop?: (droppedPlaceholders: number) => void,
): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const items = (raw as Record<string, unknown>)[itemsKey];
  if (!Array.isArray(items)) return raw;

  const stripString = (item: Record<string, unknown>, key: string) => {
    const value = item[key];
    if (value === null || (typeof value === "string" && value.trim() === "")) delete item[key];
  };
  const stripLine = (item: Record<string, unknown>, key: string) => {
    const value = item[key];
    if (value === null || value === 0) delete item[key];
  };

  let dropped = 0;
  const normalizedItems = items.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [item];
    const clone = { ...(item as Record<string, unknown>) };
    stripString(clone, "file");
    stripLine(clone, "line");
    stripLine(clone, "end_line");
    stripString(clone, "suggested_check");
    if (itemsKey === "classifications") return [clone];
    // Placeholder: no location on any key and no prose content — nothing to
    // show or post. Any surviving location value routes to strict validation.
    const hasProse = ["summary", "reason", "body"].some(
      (key) => typeof clone[key] === "string" && (clone[key] as string).trim() !== "",
    );
    if (
      !hasProse &&
      clone.file === undefined &&
      clone.line === undefined &&
      clone.end_line === undefined
    ) {
      dropped += 1;
      return [];
    }
    return [clone];
  });
  if (dropped > 0) onDrop?.(dropped);

  return { ...(raw as Record<string, unknown>), [itemsKey]: normalizedItems };
}

/**
 * Bounded, field-pathed issue list ("findings[0].severity: …", first
 * `maxIssues` entries plus a "(+N more)" marker). Use instead of
 * `ZodError.message`, which is an unbounded multi-line JSON dump.
 */
export function formatZodIssues(error: z.ZodError, maxIssues = 5): string {
  const formatPath = (path: PropertyKey[] | undefined): string => {
    let out = "";
    for (const segment of path ?? []) {
      if (typeof segment === "number") out += `[${segment}]`;
      else out += out.length > 0 ? `.${String(segment)}` : String(segment);
    }
    return out.length > 0 ? out : "(root)";
  };
  const issues = (Array.isArray(error.issues) ? error.issues : [])
    .slice(0, maxIssues)
    .map((issue) => `${formatPath(issue.path)}: ${issue.message}`);
  const remaining = error.issues.length - issues.length;
  if (remaining > 0) issues.push(`(+${remaining} more)`);
  return issues.join("; ");
}

/**
 * One formatter for model-output failures everywhere they surface to
 * operators (validation_error, failure_reason, evaluation errors): curated
 * message for extraction failures, bounded field paths for schema failures.
 */
export function formatSchemaError(error: unknown): string {
  if (error instanceof SchemaValidationError) return `${error.message}: ${error.issues}`;
  if (error instanceof z.ZodError) return `schema invalid: ${formatZodIssues(error)}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export class SchemaValidationError extends Error {
  readonly issues: string;

  constructor(message: string, issues: string) {
    super(message);
    this.name = "SchemaValidationError";
    this.issues = issues;
  }
}

function extractJsonCandidate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new SchemaValidationError("Empty reviewer output", "empty");

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);

  return trimmed;
}

export function extractJsonFromText(raw: string): unknown {
  const candidate = extractJsonCandidate(raw);
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new SchemaValidationError(
      "Output was not valid JSON",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function parseReviewerResult(
  raw: string,
  expectedReviewer?: string,
  onDrop?: (droppedPlaceholders: number) => void,
): ReviewerResult {
  const parsed = reviewerResultSchema.parse(
    normalizeLocationSentinels(extractJsonFromText(raw), "findings", onDrop),
  );
  if (expectedReviewer && parsed.reviewer !== expectedReviewer) {
    parsed.reviewer = expectedReviewer;
  }
  if (parsed.findings.length === 0 && parsed.verdict === "findings") {
    return { ...parsed, verdict: "clean" };
  }
  return parsed;
}

const ADVISORY_TEST_COVERAGE_RE =
  /\b(untested|missing tests?|no tests?( coverage)?|test coverage|without (a )?tests?|add (a |an )?tests?|lacks? tests?)\b/i;

/** Low/info missing-coverage notes that must not become a cluster of GitHub inline threads. */
export function isAdvisoryMissingTestFinding(finding: {
  severity: string;
  category?: string;
  summary: string;
  body?: string;
  reviewers_agreed?: string[];
}): boolean {
  if (finding.severity !== "low" && finding.severity !== "info") return false;
  const category = (finding.category ?? "").toLowerCase();
  if (category === "tests" || category.startsWith("test")) return true;
  if ((finding.reviewers_agreed ?? []).includes("tests")) return true;
  return ADVISORY_TEST_COVERAGE_RE.test(`${finding.summary}\n${finding.body ?? ""}`);
}

function advisoryTestLocation(finding: { file?: string; line?: number; summary: string }): string {
  if (finding.file && finding.line) return `${finding.file}:${finding.line} — ${finding.summary}`;
  if (finding.file) return `${finding.file} — ${finding.summary}`;
  return finding.summary;
}

function advisoryTestBody(items: AggregatorFinding[]): string {
  const places = items.map((item) => `- ${advisoryTestLocation(item)}`);
  const details = items.map((item) => item.body?.trim()).filter((text): text is string => Boolean(text));
  return [
    "Low/info missing-test notes combined into one comment. Not posted as inline threads.",
    "",
    "Places:",
    ...places,
    ...(details.length > 0 ? ["", ...details] : []),
  ].join("\n");
}

/**
 * Collapse low/info missing-test notes into a single finding with no file/line
 * so `toInlineComments` skips them. Medium-or-higher test findings are left alone.
 */
export function coalesceAdvisoryTestFindings(findings: AggregatorFinding[]): AggregatorFinding[] {
  const advisory: AggregatorFinding[] = [];
  const rest: AggregatorFinding[] = [];
  for (const finding of findings) {
    if (isAdvisoryMissingTestFinding(finding)) advisory.push(finding);
    else rest.push(finding);
  }
  if (advisory.length === 0) return findings;

  const severity = advisory.some((finding) => finding.severity === "low") ? "low" : "info";
  const confidence = Math.max(...advisory.map((finding) => finding.confidence ?? 0.5));
  const reviewers = [...new Set(advisory.flatMap((finding) => finding.reviewers_agreed ?? []))];
  const combined: AggregatorFinding = {
    severity,
    confidence,
    category: "tests",
    summary:
      advisory.length === 1
        ? advisory[0]!.summary
        : "Missing tests (advisory): see listed locations",
    body: advisoryTestBody(advisory),
    reviewers_agreed: reviewers.length > 0 ? reviewers : ["tests"],
  };
  return [...rest, combined];
}

function withAdvisoryTestCoalesce(parsed: AggregatorResult): AggregatorResult {
  const findings = coalesceAdvisoryTestFindings(parsed.findings);
  const combined = findings.find(
    (finding) =>
      finding.category === "tests" &&
      (finding.severity === "low" || finding.severity === "info") &&
      !finding.file &&
      !finding.line,
  );
  let summary = parsed.summary;
  if (combined?.body && !summary.includes("Places:")) {
    summary = `${summary.trim()}\n\n${combined.body}`;
  }
  return { ...parsed, findings, summary };
}

export function parseAggregatorResult(
  raw: string,
  onDrop?: (droppedPlaceholders: number) => void,
): AggregatorResult {
  const parsed = withAdvisoryTestCoalesce(
    aggregatorResultSchema.parse(normalizeLocationSentinels(extractJsonFromText(raw), "findings", onDrop)),
  );
  // Mirror the reviewer rule: an empty-findings result is clean, so the
  // POST_EMPTY_REVIEW gate applies instead of posting a summary-only review.
  if (parsed.findings.length === 0 && parsed.verdict === "comment") {
    return { ...parsed, verdict: "clean" };
  }
  return parsed;
}

export function fallbackAggregator(reviewers: ReviewerResult[]): AggregatorResult {
  const findings: AggregatorFinding[] = [];
  const seen = new Set<string>();
  for (const reviewer of reviewers) {
    for (const finding of reviewer.findings) {
      const key = `${finding.file ?? ""}:${finding.line ?? ""}:${finding.summary.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        severity: finding.severity,
        confidence: finding.confidence,
        category: finding.category,
        file: finding.file,
        line: finding.line,
        summary: finding.summary,
        body: `${finding.reason}${finding.suggested_check ? `\n\nCheck: ${finding.suggested_check}` : ""}`,
        reviewers_agreed: [reviewer.reviewer],
      });
    }
  }
  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const coalesced = coalesceAdvisoryTestFindings(findings);
  if (coalesced.length === 0) {
    return {
      schema_version: 1,
      verdict: "clean",
      summary: "Specialist reviewers reported no validated findings for this commit.",
      findings: [],
    };
  }
  const blockers = coalesced.filter((finding) => finding.severity === "blocker" || finding.severity === "high");
  const summaryLines = [
    "Maomao aggregated specialist reviewer evidence for this exact commit.",
    "",
    blockers.length > 0
      ? `**${blockers.length}** high-severity finding(s) retained after deduplication.`
      : "No blocker/high findings retained; remaining notes are advisory.",
    "",
    ...coalesced.slice(0, 8).map((finding) => {
      const loc = finding.file ? ` \`${finding.file}${finding.line ? `:${finding.line}` : ""}\`` : "";
      return `- **${finding.severity}**${loc}: ${finding.summary}`;
    }),
  ];
  const combined = coalesced.find(
    (finding) =>
      finding.category === "tests" &&
      (finding.severity === "low" || finding.severity === "info") &&
      finding.body?.includes("Places:"),
  );
  if (combined?.body) {
    summaryLines.push("", combined.body);
  }
  return {
    schema_version: 1,
    verdict: "comment",
    summary: summaryLines.join("\n"),
    findings: coalesced,
  };
}

export function severityRank(severity: Severity): number {
  switch (severity) {
    case "blocker":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    case "info":
      return 4;
    default:
      return 5;
  }
}
