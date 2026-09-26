// Deterministic stack commands posted as PR comments (issue #99). Grammar is
// regex-only — no model ever decides what runs — and the whole comment body
// (after stripping app mentions) must be exactly one command, so prose that
// happens to contain the words never fires a review.
//
//   @<app> issue 2 of 3 in stack octo-release        → declare a member
//   @<app> top of stack octo-release: #41, #42, #43   → trigger a stack review
//   @<app> top of stack: #41, #42, #43                → same, id inferred from
//                                                       the PR's declaration
//   @<app> start of stack octo-release                → mark the bottom PR
//   @<app> end of stack octo-release                  → resolve the stack by
//                                                       walking the base/head
//                                                       branch chain and review
//
// Declarations never touch the review pause; only the top/end trigger
// enqueues work. Every command is scoped to the repository the comment is on.

import type { ResolvedPull } from "../github/client.js";
import type { StackDeclarationRow } from "../jobs/store.js";

export type StackCommand =
  | { kind: "declare"; stackId: string; position: number; expectedCount: number }
  | { kind: "top"; stackId?: string; prNumbers: number[] }
  | { kind: "start"; stackId?: string }
  | { kind: "end"; stackId?: string };

const STACK_ID_RE = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
const DECLARE_RE = new RegExp(`^issue\\s+(\\d+)\\s+of\\s+(\\d+)\\s+in\\s+stack\\s+(${STACK_ID_RE})$`, "i");
// The stack id and the colon are both optional: "top of stack: #1, #2" defers
// the id to the webhook handler, which infers it from the PR's declarations.
const TOP_RE = new RegExp(`^top\\s+of\\s+stack(?:\\s+(${STACK_ID_RE}))?\\s*:?\\s*(.+)$`, "is");
// A bare "start of stack" generates an id so authors never need one.
const START_RE = new RegExp(`^start\\s+of\\s+stack(?:\\s+(${STACK_ID_RE}))?$`, "i");
// A bare "end of stack" takes the id from the start marker at the chain's base.
const END_RE = new RegExp(`^end\\s+of\\s+stack(?:\\s+(${STACK_ID_RE}))?$`, "i");

// A comment that clearly intends a stack command but fails the grammar still
// deserves an answer — the webhook replies with usage instead of ignoring it.
const STACK_INTENT_RE = /^(?:issue\s+\d+\s+of\s+\d+|(?:top|start|end)\s+of\s+stack)\b/i;

export function looksLikeStackCommand(body: string): boolean {
  return STACK_INTENT_RE.test(stripMentions(body).replace(/\s+/g, " ").trim());
}

// Stack markers may also live in the PR body, where a body is prose rather
// than a single command — so the grammar is matched per whole line, allowing
// an HTML-comment wrapper ("<!-- start of stack x -->") and a leading
// @mention. Any marker suppresses automatic per-PR review until "end of
// stack" resolves the chain; "part of stack <id>" is the suppression-only
// marker for middle members that carry no command of their own.
const PART_RE = new RegExp(`^part\\s+of\\s+stack(?:\\s+(${STACK_ID_RE}))?$`, "i");

export type StackBodyMarker =
  | { kind: "start"; stackId?: string }
  | { kind: "end"; stackId?: string }
  | { kind: "part"; stackId?: string }
  | { kind: "declare"; stackId: string; position: number; expectedCount: number }
  | { kind: "invalid" };

export function extractStackBodyMarker(body: string): StackBodyMarker | null {
  for (const rawLine of body.split("\n")) {
    let line = rawLine.trim();
    if (!line) continue;
    const htmlComment = /^<!--(.*)-->$/.exec(line);
    if (htmlComment) line = htmlComment[1]!.trim();
    line = line.replace(/^@[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?\s+/, "").trim();
    const declare = DECLARE_RE.exec(line);
    if (declare) {
      const position = Number(declare[1]);
      const expectedCount = Number(declare[2]);
      if (position < 1 || expectedCount < 1 || position > expectedCount || expectedCount > 100) {
        return { kind: "invalid" };
      }
      return { kind: "declare", stackId: declare[3]!, position, expectedCount };
    }
    const start = START_RE.exec(line);
    if (start) return { kind: "start", stackId: start[1] };
    const end = END_RE.exec(line);
    if (end) return { kind: "end", stackId: end[1] };
    const part = PART_RE.exec(line);
    if (part) return { kind: "part", stackId: part[1] };
    if (STACK_INTENT_RE.test(line)) return { kind: "invalid" };
  }
  return null;
}

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
    // PR lists accept commas, whitespace, "and", and "&" as separators.
    for (const part of top[2]!.replace(/\band\b|&/gi, " ").split(/[\s,]+/).filter(Boolean)) {
      const match = /^#?(\d+)$/.exec(part);
      if (!match) return null;
      const n = Number(match[1]);
      if (n < 1 || prNumbers.includes(n)) return null;
      prNumbers.push(n);
    }
    if (prNumbers.length < 2 || prNumbers.length > 100) return null;
    return { kind: "top", stackId: top[1], prNumbers };
  }
  const start = START_RE.exec(text);
  if (start) {
    return { kind: "start", stackId: start[1] };
  }
  const end = END_RE.exec(text);
  if (end) {
    return { kind: "end", stackId: end[1] };
  }
  return null;
}

/**
 * Resolves a start/end stack by walking the repository's open pull requests:
 * starting from the PR the `end` comment was posted on, each step follows the
 * current PR's base branch to the open PR whose head it is, until the
 * declared start PR is reached — or, with no start given, until the chain
 * bottoms out on a branch no open PR is based on. Fail-closed on every
 * ambiguity: a missing link, a fork in the chain (two open PRs sharing a head
 * branch), a cycle, or a walk that never reaches the start PR all produce an
 * actionable error.
 */
export function resolveStackChain(input: {
  pulls: ResolvedPull[];
  /** Declared start PR; omit to walk down to the chain's natural base. */
  startPrNumber?: number;
  endPrNumber: number;
}): { ok: true; pulls: ResolvedPull[] } | { ok: false; error: string } {
  const { pulls, startPrNumber, endPrNumber } = input;
  const end = pulls.find((p) => p.prNumber === endPrNumber);
  if (!end) {
    return { ok: false, error: `the PR this comment is on (#${endPrNumber}) is not open` };
  }
  const start = startPrNumber != null ? pulls.find((p) => p.prNumber === startPrNumber) : undefined;
  if (startPrNumber != null && !start) {
    return { ok: false, error: `declared start PR #${startPrNumber} is not an open pull request` };
  }
  if (startPrNumber === endPrNumber) {
    return { ok: false, error: "the start and end of a stack cannot be the same pull request" };
  }
  // Boundaries are validated before walking: the trigger PR must be the top
  // (no other open PR bases on its head) and a declared start must be the
  // bottom (no other open PR's head is its base). Both would otherwise
  // silently review a truncated slice of the real stack.
  const above = pulls.filter((p) => p.prNumber !== end.prNumber && p.baseRef === end.headRef);
  if (above.length > 0) {
    return {
      ok: false,
      error: `#${end.prNumber} is not the top of its stack — ${above.map((p) => `#${p.prNumber}`).join(", ")} ${above.length > 1 ? "are" : "is"} based on its head branch "${end.headRef}"`,
    };
  }
  if (start) {
    const below = pulls.filter((p) => p.prNumber !== start.prNumber && p.headRef === start.baseRef);
    if (below.length > 0) {
      return {
        ok: false,
        error: `declared start #${start.prNumber} is not the bottom of its stack — its base branch "${start.baseRef}" is the head of ${below.map((p) => `#${p.prNumber}`).join(", ")}`,
      };
    }
  }
  const byHead = new Map<string, ResolvedPull[]>();
  for (const pull of pulls) {
    const list = byHead.get(pull.headRef) ?? [];
    list.push(pull);
    byHead.set(pull.headRef, list);
  }
  const chain: ResolvedPull[] = [end];
  const seen = new Set<number>([end.prNumber]);
  while (!start || chain[0]!.prNumber !== start.prNumber) {
    const baseRef = chain[0]!.baseRef;
    const predecessors = byHead.get(baseRef) ?? [];
    if (predecessors.length === 0) {
      if (!start) break;
      return {
        ok: false,
        error: `no open pull request has head branch "${baseRef}" — the chain below #${chain[0]!.prNumber} is broken before reaching the declared start #${start.prNumber}`,
      };
    }
    if (predecessors.length > 1) {
      return {
        ok: false,
        error: `branch "${baseRef}" is the head of ${predecessors.length} open pull requests (${predecessors.map((p) => `#${p.prNumber}`).join(", ")}) — the stack is ambiguous`,
      };
    }
    const predecessor = predecessors[0]!;
    if (seen.has(predecessor.prNumber)) {
      return {
        ok: false,
        error: start
          ? `branch chain loops back to #${predecessor.prNumber} before reaching #${start.prNumber}`
          : `branch chain loops back to #${predecessor.prNumber}`,
      };
    }
    if (chain.length > 100) {
      return { ok: false, error: "the chain exceeds 100 pull requests" };
    }
    seen.add(predecessor.prNumber);
    chain.unshift(predecessor);
  }
  if (chain.length < 2) {
    return { ok: false, error: "the stack resolves to a single pull request — nothing to chain" };
  }
  return { ok: true, pulls: chain };
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
