/**
 * Maomao-thread detection over forge-neutral discussions. Ownership is proven
 * purely by the hidden finding marker in a comment body — no GitHub thread
 * objects, GraphQL ids, or reactions are involved.
 */
import { parseFindingMarker } from "../findings/identity.js";
import type { ForgeDiscussion, ForgeDiscussionComment } from "./types.js";

export function discussionRoot(discussion: ForgeDiscussion): ForgeDiscussionComment | undefined {
  return discussion.comments[0];
}

/** The comment that carries the Maomao finding marker, even if it is not comments[0]. */
export function findingComment(discussion: ForgeDiscussion): ForgeDiscussionComment | undefined {
  return discussion.comments.find((comment) => Boolean(parseFindingMarker(comment.body))) ?? discussion.comments[0];
}

export function parseDiscussionFindingMarker(
  discussion: ForgeDiscussion,
): { id: string; sha: string } | undefined {
  for (const comment of discussion.comments) {
    const marker = parseFindingMarker(comment.body);
    if (marker) return marker;
  }
  return undefined;
}

export function isMaomaoDiscussion(discussion: ForgeDiscussion): boolean {
  return discussion.comments.some((comment) => Boolean(parseFindingMarker(comment.body)));
}

export function discussionContainsComment(
  discussion: ForgeDiscussion,
  commentId: number | undefined,
): boolean {
  if (commentId == null) return false;
  return discussion.comments.some((comment) => comment.databaseId === commentId);
}
