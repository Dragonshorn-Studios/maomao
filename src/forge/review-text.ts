/**
 * Forge-neutral publication helpers: review-body construction, inline-comment
 * selection against the diff, and the degrade-to-summary publish fallback.
 * Pure functions over neutral types — no provider API shapes.
 */
import { diffCommentAnchor } from "../findings/context.js";
import { findingMarker, fingerprintFinding, parseFindingMarker } from "../findings/identity.js";
import { reviewMarker } from "../prompts.js";
import type { ForgeInlineComment, ForgePublishResult, ForgeSummary } from "./types.js";

/**
 * Post a review with inline comments, degrading instead of dying: if the forge
 * rejects the batch, retry once as a body-only review; if that retry also
 * fails, surface the original error (it explains why we degraded).
 */
export async function createReviewWithFallback(input: {
  comments: ForgeInlineComment[];
  body: string;
  post: (comments: ForgeInlineComment[], body: string) => Promise<{ id: number | string; url?: string }>;
}): Promise<ForgePublishResult> {
  try {
    const review = await input.post(input.comments, input.body);
    return { id: String(review.id), url: review.url ?? "", postedComments: input.comments };
  } catch (error) {
    if (input.comments.length === 0) throw error;
    // Inline comments must land on diff lines; fall back to a body-only review.
    try {
      const review = await input.post(
        [],
        `${input.body}\n\n_Inline comments were omitted because the forge rejected one or more diff locations._`,
      );
      return { id: String(review.id), url: review.url ?? "", postedComments: [] };
    } catch {
      throw error;
    }
  }
}

export function findExistingReview(
  summaries: ForgeSummary[],
  headSha: string,
): ForgePublishResult | undefined {
  const marker = reviewMarker(headSha);
  const match = summaries.find((summary) => summary.body.includes(marker));
  if (!match) return undefined;
  return { id: match.id, url: match.htmlUrl ?? "" };
}

export interface InlineCommentFinding {
  file?: string;
  line?: number;
  summary: string;
  body?: string;
  severity: string;
  category?: string;
  fingerprint?: string;
}

/** A finding whose reported location cannot anchor in the diff, demoted to the review body. */
export interface DemotedFinding {
  finding: InlineCommentFinding;
  reason: string;
}

const DEMOTED_BODY_LIMIT = 10;

export function buildReviewBody(input: {
  headSha: string;
  summary: string;
  findingsCount: number;
  reviewerCount: number;
  demoted?: DemotedFinding[];
}): string {
  const marker = reviewMarker(input.headSha);
  const header = [
    marker,
    `Maomao reviewed commit \`${input.headSha}\` with ${input.reviewerCount} specialist run(s).`,
    "",
  ].join("\n");
  let body = `${header}${input.summary.trim()}\n`;
  const demoted = input.demoted ?? [];
  if (demoted.length > 0) {
    const shown = demoted.slice(0, DEMOTED_BODY_LIMIT);
    const lines = shown.map(
      (entry) =>
        `- **${entry.finding.severity}**: ${entry.finding.summary} — \`${entry.finding.file}:${entry.finding.line}\``,
    );
    if (demoted.length > shown.length) lines.push(`- … and ${demoted.length - shown.length} more`);
    body += `\n#### Findings not shown inline\n\nThese locations are not part of the diff hunks, so they are listed here instead:\n\n${lines.join("\n")}\n`;
  }
  return body;
}

function inlineComment(
  finding: InlineCommentFinding,
  headSha: string,
  side: "LEFT" | "RIGHT",
): ForgeInlineComment {
  const fingerprint = finding.fingerprint ?? fingerprintFinding(finding);
  return {
    path: finding.file ?? "",
    line: finding.line ?? 1,
    side,
    body: `${findingMarker(fingerprint, headSha)}\n**${finding.severity}**: ${finding.summary}${finding.body ? `\n\n${finding.body}` : ""}`,
  };
}

/**
 * Split publishable findings into inline comments the forge will accept and findings whose
 * reported location is not in the diff (demoted to the review body by the caller). Without
 * a diff to validate against, every located finding passes through as before.
 */
export function selectInlineComments(
  findings: InlineCommentFinding[],
  opts: { limit: number; headSha: string; diff?: string },
): { comments: ForgeInlineComment[]; demoted: DemotedFinding[] } {
  const comments: ForgeInlineComment[] = [];
  const demoted: DemotedFinding[] = [];
  for (const finding of findings) {
    if (!finding.file || !finding.line) continue;
    const anchor = opts.diff
      ? diffCommentAnchor(opts.diff, finding.file, finding.line)
      : ({ ok: true, side: "RIGHT" } as const);
    if (!anchor.ok) {
      demoted.push({ finding, reason: anchor.reason });
      continue;
    }
    // Cap only the inline set: findings beyond it stay unlisted (summary only),
    // exactly as before, while unanchorable ones always reach the body.
    if (comments.length >= opts.limit) continue;
    comments.push(inlineComment(finding, opts.headSha, anchor.side));
  }
  return { comments, demoted };
}

export function toInlineComments(
  findings: InlineCommentFinding[],
  limit: number,
  headSha: string,
): ForgeInlineComment[] {
  return selectInlineComments(findings, { limit, headSha }).comments;
}

export function inlineCommentFingerprints(comments: ForgeInlineComment[]): string[] {
  const ids: string[] = [];
  for (const comment of comments) {
    const marker = parseFindingMarker(comment.body);
    if (marker?.id) ids.push(marker.id);
  }
  return ids;
}
