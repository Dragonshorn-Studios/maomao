import type { GuidedCommentView, GuidedSessionView } from "./store.js";

export interface GuidedPublishPreview {
  target: {
    provider: string;
    instance: string;
    repoFullName: string;
    prNumber: number;
    baseSha: string;
    headSha: string;
  };
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  body: string;
  comments: Array<{ path: string; side: "LEFT" | "RIGHT"; line: number; body: string }>;
  omittedInlineCount: number;
  unresolvedThreadWarning: boolean;
}

function commentBlock(comment: GuidedCommentView): string {
  const label = comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ""}` : "general note";
  return `### ${label}\n\n${comment.body}`;
}

/** Exact payload shape the later deliberate publication step must reuse. */
export function buildGuidedPublishPreview(session: GuidedSessionView, comments: GuidedCommentView[]): GuidedPublishPreview {
  const event = session.draftVerdict ?? "COMMENT";
  const active = comments.filter((comment) => !comment.deletedAt);
  const publishable = active.filter((comment) => comment.publishable && comment.anchorStatus === "anchored");
  const general = publishable.filter((comment) => comment.kind === "general");
  const inline = publishable.filter(
    (comment): comment is GuidedCommentView & { path: string; side: "LEFT" | "RIGHT"; line: number } =>
      comment.kind === "inline" && Boolean(comment.path && comment.side && comment.line),
  );
  const summaryParts = [session.draftSummary.trim(), ...general.map(commentBlock)].filter(Boolean);
  // Approval ergonomics: inline feedback folds into the summary so publishing
  // cannot silently create unresolved threads that native merge gates block on.
  const includeInline = event !== "APPROVE";
  const bodyParts = [...summaryParts];
  if (!includeInline && inline.length > 0) {
    bodyParts.push(inline.map(commentBlock).join("\n\n"));
  }
  return {
    target: {
      provider: session.provider,
      instance: session.instance,
      repoFullName: session.repoFullName,
      prNumber: session.prNumber,
      baseSha: session.baseSha,
      headSha: session.headSha,
    },
    event,
    body: bodyParts.join("\n\n").trim(),
    comments: includeInline ? inline.map((comment) => ({ path: comment.path, side: comment.side, line: comment.line, body: comment.body })) : [],
    omittedInlineCount: includeInline ? 0 : inline.length,
    unresolvedThreadWarning: includeInline && inline.length > 0,
  };
}
