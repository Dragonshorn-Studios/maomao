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

export function parseReviewerResult(raw: string, expectedReviewer?: string): ReviewerResult {
  const parsed = reviewerResultSchema.parse(extractJsonFromText(raw));
  if (expectedReviewer && parsed.reviewer !== expectedReviewer) {
    parsed.reviewer = expectedReviewer;
  }
  if (parsed.findings.length === 0 && parsed.verdict === "findings") {
    return { ...parsed, verdict: "clean" };
  }
  return parsed;
}

export function parseAggregatorResult(raw: string): AggregatorResult {
  return aggregatorResultSchema.parse(extractJsonFromText(raw));
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
  if (findings.length === 0) {
    return {
      schema_version: 1,
      verdict: "clean",
      summary: "Specialist reviewers reported no validated findings for this commit.",
      findings: [],
    };
  }
  const blockers = findings.filter((finding) => finding.severity === "blocker" || finding.severity === "high");
  const summaryLines = [
    "Maomao aggregated specialist reviewer evidence for this exact commit.",
    "",
    blockers.length > 0
      ? `**${blockers.length}** high-severity finding(s) retained after deduplication.`
      : "No blocker/high findings retained; remaining notes are advisory.",
    "",
    ...findings.slice(0, 8).map((finding) => {
      const loc = finding.file ? ` \`${finding.file}${finding.line ? `:${finding.line}` : ""}\`` : "";
      return `- **${finding.severity}**${loc}: ${finding.summary}`;
    }),
  ];
  return {
    schema_version: 1,
    verdict: "comment",
    summary: summaryLines.join("\n"),
    findings,
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
