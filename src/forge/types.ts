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

/**
 * Storage identity for rows written before per-connection scoping existed and
 * for call sites that are GitHub-only by construction (the GitHub webhook
 * handler). Defaults must be greppable call sites, never invisible fallbacks.
 */
export const DEFAULT_FORGE_SCOPE: ForgeScope = { provider: GITHUB_PROVIDER, instance: GITHUB_INSTANCE };

/**
 * Missing or blank fields on both axes fall back to the default GitHub scope,
 * so legacy rows resolve to the env-configured connection. A half-specified
 * scope is a caller bug and throws — half a connection identity is never a
 * valid storage partition.
 */
export function normalizeScope(scope?: Partial<ForgeScope>): ForgeScope {
  const provider = scope?.provider?.trim().toLowerCase();
  const instance = scope?.instance?.trim().toLowerCase();
  if ((provider == null || provider === "") && (instance == null || instance === "")) {
    return { ...DEFAULT_FORGE_SCOPE };
  }
  if (!provider || !instance) {
    throw new Error(
      `incomplete forge scope (provider=${scope?.provider ?? ""}, instance=${scope?.instance ?? ""}): both provider and instance are required`,
    );
  }
  return { provider, instance };
}

/** Structural read of a row's persisted scope; both columns are NOT NULL. */
export function scopeOf(row: { provider: string; provider_instance: string }): ForgeScope {
  return { provider: row.provider, instance: row.provider_instance };
}

/** Storage-scoped target for a job row (or any row carrying the same six columns). */
export function forgeTargetOf(row: {
  provider: string;
  provider_instance: string;
  repo_owner: string;
  repo_name: string;
  repo_full_name: string;
  pr_number: number;
  installation_id?: number;
}): ForgeRepoTarget {
  return {
    provider: row.provider,
    instance: row.provider_instance,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    repoFullName: row.repo_full_name,
    changeNumber: row.pr_number,
    ...(row.installation_id != null ? { nativeProjectId: row.installation_id } : {}),
  };
}

/** A repository plus the change request under review on one forge instance. */
export interface ForgeRepoTarget extends ForgeScope {
  repoOwner: string;
  repoName: string;
  repoFullName: string;
  /** Pull number (GitHub) or merge-request iid (GitLab) — project-local. */
  changeNumber: number;
  /**
   * The provider's native numeric project/repository id where one exists
   * (GitLab project id; GitHub carries it in repositoryId instead). Optional
   * because not every caller needs API addressing.
   */
  nativeProjectId?: number;
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

/** One conversation/inline comment as surfaced to the human-override scanner. */
export interface ForgeConversationComment {
  id: string;
  source: "conversation" | "inline";
  body: string;
  login?: string;
  userType?: string;
  authorAssociation?: string;
  path?: string;
  line?: number;
  inReplyToId?: string;
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
  /** `git -c …` arguments carrying authentication; also listed in `secrets` so subprocess output is redacted. */
  gitAuthArgs: string[];
  /**
   * The provider's native head ref (e.g. refs/pull/7/head). Checkout pins it
   * to the local refs/maomao/pr itself, so the local-ref convention lives in
   * exactly one place.
   */
  remoteRef: string;
  /** Secret material (tokens, basic-auth strings) that must be redacted from subprocess output. */
  secrets: string[];
}
