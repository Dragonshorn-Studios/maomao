/**
 * The forge-neutral port every provider adapter implements. The pipeline,
 * reconciliation, and publication layers depend on this interface only —
 * provider API shapes never leak past the adapters.
 *
 * Lifecycle ports are bound to one connection: a GitHub binding carries its
 * App installation id, a GitLab binding (slice: connections) carries its
 * forge connection. Methods therefore take only the repository target.
 */
import type {
  ForgeChange,
  ForgeCloneSpec,
  ForgeConversationComment,
  ForgeDiscussion,
  ForgeInlineComment,
  ForgePermission,
  ForgePublishInput,
  ForgePublishResult,
  ForgeRepoTarget,
  ForgeSummary,
} from "./types.js";

export interface ForgePort {
  readonly provider: string;
  readonly instance: string;

  /** Current change-request metadata; anchors the job to the live head SHA. */
  getChange(target: ForgeRepoTarget): Promise<ForgeChange>;
  /** Unified diff of the change, bounded by `maxBytes` when > 0. */
  getChangeDiff(target: ForgeRepoTarget, maxBytes?: number): Promise<string>;
  /** Diff of one commit on the default branch (health scans). Optional: providers without it cannot run health scans. */
  getCommitDiff?(target: Omit<ForgeRepoTarget, "changeNumber">, sha: string): Promise<string>;

  /** Existing review summaries on the change; marker-scanned for idempotent publish. */
  listSummaries(target: ForgeRepoTarget): Promise<ForgeSummary[]>;
  /** Publish a summary with optional inline comments; degrade instead of dying when inlines are rejected. */
  publishReview(input: ForgePublishInput): Promise<ForgePublishResult>;

  /** Every discussion thread on the change (Maomao-owned and not). */
  listDiscussions(target: ForgeRepoTarget): Promise<ForgeDiscussion[]>;
  resolveDiscussion(target: ForgeRepoTarget, discussionId: string): Promise<void>;
  unresolveDiscussion(target: ForgeRepoTarget, discussionId: string): Promise<void>;

  /** Effective permission of an actor on the repository, in the neutral vocabulary. */
  getActorPermission(target: ForgeRepoTarget, username: string): Promise<ForgePermission>;
  /** Conversation comments (change-level and inline) for human-override scanning. */
  listConversationComments?(target: ForgeRepoTarget): Promise<ForgeConversationComment[]>;

  /**
   * Authenticated clone material for the change head; secrets never enter logs
   * or model context. `anonymous: true` is the unauthenticated public-scan
   * path — providers must refuse it for anything but public read-only access.
   */
  cloneSpec(target: ForgeRepoTarget, opts?: { anonymous?: boolean }): Promise<ForgeCloneSpec>;

  /** True when the login belongs to this connection's bot identity (review-loop guard). */
  isBotLogin(login: string | undefined): boolean;
}
