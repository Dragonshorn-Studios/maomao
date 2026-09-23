// Deterministic stack commands posted as PR comments (issue #99). Grammar is
// regex-only — no model ever decides what runs — and the whole comment body
// (after stripping app mentions) must be exactly one command, so prose that
// happens to contain the words never fires a review.
//
//   @<app> issue 2 of 3 in stack octo-release      → declare a member
//   @<app> top of stack octo-release: #41, #42, #43 → trigger a stack review
//
// Declarations never touch the review pause; only the top-of-stack trigger
// enqueues work. Every command is scoped to the repository the comment is on.

import type { ResolvedPull } from "../github/client.js";
import type { StackDeclarationRow } from "../jobs/store.js";

export type StackCommand =
  | { kind: "declare"; stackId: string; position: number; expectedCount: number }
  | { kind: "top"; stackId: string; prNumbers: number[] };

const STACK_ID_RE = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
const DECLARE_RE = new RegExp(`^issue\\s+(\\d+)\\s+of\\s+(\\d+)\\s+in\\s+stack\\s+(${STACK_ID_RE})$`, "i");
const TOP_RE = new RegExp(`^top\\s+of\\s+stack\\s+(${STACK_ID_RE})\\s*:\\s*(.+)$`, "is");

/** Strip "@name" mention tokens (same charset GitHub allows in logins plus [bot]). */
function stripMentions(body: string): string {
  return body.replace(/@[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?/g, " ").trim();
}

export function parseStackCommand(body: string): StackCommand | null {
  const text = stripMentions(body).replace(/\s+/g, " ").trim();
  const declare = DECLARE_RE.exec(text);
  if (declare) {
    const position = Number(declare[1]);
    const expectedCount = Number(declare[2]);
    if (position < 1 || expectedCount < 1 || position > expectedCount || expectedCount > 100) {
      return null;
    }
    return { kind: "declare", stackId: declare[3]!, position, expectedCount };
  }
  const top = TOP_RE.exec(text);
  if (top) {
    const prNumbers: number[] = [];
    for (const part of top[2]!.split(",")) {
      const match = /^#?(\d+)$/.exec(part.trim());
      if (!match) return null;
      const n = Number(match[1]);
      if (n < 1 || prNumbers.includes(n)) return null;
      prNumbers.push(n);
    }
    if (prNumbers.length < 2 || prNumbers.length > 100) return null;
    return { kind: "top", stackId: top[1]!, prNumbers };
  }
  return null;
}

export interface StackMemberSpec {
  position: number;
  prNumber: number;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  prTitle: string;
}

/**
 * Every check for the top-of-stack trigger, fail-closed: all listed PRs must
 * resolve in the same repository, each must be declared for this stack at its
 * listed position with a matching expected count, the bases must chain
 * (member i's base ref is member i-1's head ref), and the comment must sit on
 * the stack's top PR. Returns the ordered, SHA-pinned member list on success.
 */
export function validateStackMembers(input: {
  stackId: string;
  prNumbers: number[];
  pulls: ResolvedPull[];
  declarations: StackDeclarationRow[];
  repoFullName: string;
  /** PR number the trigger comment was posted on — must be the top (last). */
  commentPrNumber: number;
}): { ok: true; members: StackMemberSpec[] } | { ok: false; error: string } {
  const { stackId, prNumbers, pulls, declarations, repoFullName, commentPrNumber } = input;
  if (prNumbers[prNumbers.length - 1] !== commentPrNumber) {
    return {
      ok: false,
      error: `the "top of stack" trigger must be posted on the stack's top PR (#${prNumbers[prNumbers.length - 1]}), not #${commentPrNumber}`,
    };
  }
  const declared = new Map(declarations.map((d) => [d.pr_number, d]));
  const members: StackMemberSpec[] = [];
  for (let i = 0; i < prNumbers.length; i += 1) {
    const prNumber = prNumbers[i]!;
    const position = i + 1;
    const pull = pulls[i];
    if (!pull || pull.prNumber !== prNumber) {
      return { ok: false, error: `could not resolve PR #${prNumber} in ${repoFullName}` };
    }
    if (pull.repoFullName.toLowerCase() !== repoFullName.toLowerCase()) {
      return { ok: false, error: `PR #${prNumber} does not belong to ${repoFullName}` };
    }
    const decl = declared.get(prNumber);
    if (!decl) {
      return {
        ok: false,
        error: `PR #${prNumber} was never declared as a member of stack "${stackId}" — post "issue ${position} of ${prNumbers.length} in stack ${stackId}" on it first`,
      };
    }
    if (decl.position !== position) {
      return {
        ok: false,
        error: `PR #${prNumber} is declared as issue ${decl.position} of stack "${stackId}", but the trigger lists it at position ${position}`,
      };
    }
    if (decl.expected_count !== prNumbers.length) {
      return {
        ok: false,
        error: `PR #${prNumber} was declared as issue ${position} of ${decl.expected_count}, but the trigger lists ${prNumbers.length} members — declare a consistent count`,
      };
    }
    if (i > 0) {
      const previous = members[i - 1]!;
      if (pull.baseRef !== previous.headRef) {
        return {
          ok: false,
          error: `dependency order broken: PR #${prNumber} targets "${pull.baseRef}", but PR #${previous.prNumber}'s head is "${previous.headRef}"`,
        };
      }
    }
    members.push({
      position,
      prNumber,
      baseRef: pull.baseRef,
      headRef: pull.headRef,
      baseSha: pull.baseSha,
      headSha: pull.headSha,
      prTitle: pull.prTitle,
    });
  }
  return { ok: true, members };
}
