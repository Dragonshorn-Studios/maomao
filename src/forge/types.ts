/**
 * Forge-neutral domain types shared by every provider adapter.
 *
 * The orchestration pipeline, findings lifecycle, and persistence speak only
 * these types; provider-specific shapes (GitHub App installations, GitLab
 * positions, GraphQL node ids) are mapped inside each adapter. Field names
 * stay close to the historical GitHub vocabulary where the concept is the
 * same (`changeNumber` is a GitHub pull number and a GitLab merge-request
 * iid — the project-local number, never a global object id).
 */

/** Storage identity of a forge. Persisted on jobs/findings/deliveries rows. */
export interface ForgeScope {
  provider: string;
  /** Instance hostname (e.g. "github.com", "gitlab.com", "gitlab.corp.internal"). */
  instance: string;
}

/** The GitHub connection implicitly configured through environment variables. */
export const GITHUB_PROVIDER = "github";
export const GITHUB_INSTANCE = "github.com";

/** Default storage scope for rows written before per-connection scoping existed. */
export const DEFAULT_FORGE_SCOPE: ForgeScope = { provider: GITHUB_PROVIDER, instance: GITHUB_INSTANCE };

export function normalizeScope(scope?: Partial<ForgeScope>): ForgeScope {
  return {
    provider: scope?.provider?.trim() || GITHUB_PROVIDER,
    instance: scope?.instance?.trim() || GITHUB_INSTANCE,
  };
}

/** A repository plus the change request under review on one forge instance. */
export interface ForgeRepoTarget extends ForgeScope {
  repoOwner: string;
  repoName: string;
  repoFullName: string;
  /** Pull number (GitHub) or merge-request iid (GitLab) — project-local. */
  changeNumber: number;
}

/**
 * Verdict vocabulary persisted in jobs.review_event. Providers map it onto
 * their forge's API; a forge that cannot express a verdict degrades to
 * "COMMENT" while the stored value keeps Maomao's internal decision.
 */
export type ForgeVerdict = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface ForgeChange {
  repoOwner: string;
  repoName: string;
  repoFullName: string;
  changeNumber: number;
  title: string;
  body: string;
  htmlUrl: string;
  author: string;
  baseSha: string;
  headSha: string;
  baseRef: string;
  headRef: string;
  draft: boolean;
  /** GitHub-only numeric identifiers; undefined on other forges. */
  repositoryId?: number;
  accountId?: number;
}

export interface ForgeDiscussionComment {
  /** Provider-native comment id as a string (GraphQL node id, note id, …). */
  id: string;
  /** Numeric id where the provider has one; used for thread membership checks. */
  databaseId?: number;
  body: string;
  path?: string;
  line?: number | null;
  authorLogin?: string;
}

export interface ForgeDiscussion {
  id: string;
  isResolved: boolean;
  path?: string;
  line?: number | null;
  comments: ForgeDiscussionComment[];
}

export type ForgePermission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

export interface ForgeInlineComment {
  path: string;
  body: string;
  line: number;
  side?: "LEFT" | "RIGHT";
}

export interface ForgePublishResult {
  id: string;
  url: string;
  /** Inline comments the forge actually accepted; empty when the publish degraded to summary-only. */
  postedComments?: ForgeInlineComment[];
}

export interface ForgeSummary {
  id: string;
  body: string;
  commitId?: string;
  htmlUrl?: string;
  userLogin?: string;
}

export interface ForgePublishInput {
  target: ForgeRepoTarget;
  /** Exact head commit the review is anchored to. */
  commitId: string;
  body: string;
  comments: ForgeInlineComment[];
  verdict: ForgeVerdict;
}

/** Everything a checkout needs to fetch the change head, provider-supplied. */
export interface ForgeCloneSpec {
  cloneUrl: string;
  /** `git -c …` arguments carrying authentication; never logged. */
  gitAuthArgs: string[];
  /** Fetch refspec pinning the change head to a local ref (e.g. +refs/pull/N/head:refs/maomao/pr). */
  headRefspec: string;
  /** Secret material (tokens, basic-auth strings) that must be redacted from subprocess output. */
  secrets: string[];
}
