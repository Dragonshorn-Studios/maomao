// Stack-position comments (issue #99): after a declaration lands or a
// top-of-stack trigger validates, maomao keeps exactly one marker comment per
// member PR up to date — "issue X of Y" with the ordered member list —
// instead of posting a new comment on every stack event. The HTML marker
// identifies the comment so later updates edit it in place.

import type { GithubPort } from "../github/client.js";

export interface StackCommentMember {
  position: number;
  prNumber: number;
  headSha?: string;
}

export function stackCommentMarker(stackId: string): string {
  return `<!-- maomao-stack:${stackId} -->`;
}

export function renderStackComment(input: {
  stackId: string;
  selfPrNumber: number;
  expectedCount: number;
  members: StackCommentMember[];
  /** True while only the stack's base is known — no member list to render. */
  pending?: boolean;
}): string {
  const { stackId, selfPrNumber, expectedCount, members } = input;
  const self = members.find((m) => m.prNumber === selfPrNumber);
  const lines = input.pending
    ? [
        stackCommentMarker(stackId),
        `🥞 This pull request is the base of review stack \`${stackId}\` — awaiting \`end of stack\` on the top pull request.`,
      ]
    : [
        stackCommentMarker(stackId),
        `🥞 This pull request is part of review stack \`${stackId}\` — issue ${self?.position ?? "?"} of ${expectedCount}.`,
      ];
  if (members.length && !input.pending) {
    const rows = [...members].sort((a, b) => a.position - b.position).map((m) => {
      const isSelf = m.prNumber === selfPrNumber;
      const sha = m.headSha ? ` @ \`${m.headSha.slice(0, 8)}\`` : "";
      const label = isSelf ? `**#${m.prNumber}** 🍃` : `#${m.prNumber}`;
      const edge = m.position === 1 ? " — base of the stack" : m.position === expectedCount ? " — top of the stack" : "";
      return `${m.position}. ${label}${sha}${edge}`;
    });
    lines.push("", ...rows);
  }
  lines.push("", "_Maomao edits this comment as the stack changes._");
  return lines.join("\n");
}

type StackCommentGithub = Pick<GithubPort, "listIssueComments" | "createIssueComment" | "updateIssueComment">;

/**
 * Writes the single stack comment on one member PR: finds the existing marker
 * comment and edits it, or creates it when absent. Never posts a second
 * marker comment — when the port can list but not edit, a pre-existing marker
 * comment is left as-is rather than duplicated.
 */
export async function upsertStackComment(input: {
  github: StackCommentGithub;
  installationId: number;
  repoOwner: string;
  repoName: string;
  selfPrNumber: number;
  stackId: string;
  expectedCount: number;
  members: StackCommentMember[];
  pending?: boolean;
}): Promise<void> {
  const body = renderStackComment(input);
  const marker = stackCommentMarker(input.stackId);
  const comments = (await input.github.listIssueComments?.(
    input.installationId,
    input.repoOwner,
    input.repoName,
    input.selfPrNumber,
  )) ?? [];
  const existing = comments.find((comment) => comment.body.includes(marker));
  if (existing) {
    if (existing.body === body || !input.github.updateIssueComment) return;
    await input.github.updateIssueComment({
      installationId: input.installationId,
      owner: input.repoOwner,
      repo: input.repoName,
      commentId: existing.id,
      body,
    });
    return;
  }
  await input.github.createIssueComment?.({
    installationId: input.installationId,
    owner: input.repoOwner,
    repo: input.repoName,
    pullNumber: input.selfPrNumber,
    body,
  });
}
