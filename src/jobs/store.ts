import { randomUUID } from "node:crypto";
import type { SqliteDb } from "../db.js";
import type { CancelReason, JobState, ReviewerState } from "../config.js";
import { JOBS_PAGE_SIZE_DEFAULT, JOBS_PAGE_SIZE_MAX, LIVE_JOB_STATES } from "../config.js";
import type { ForgeScope, WebhookDeliveryContext } from "../forge/types.js";
import { normalizeScope } from "../forge/types.js";
import type { FindingRow, FindingStatus } from "../findings/types.js";
import { nowIso } from "../util.js";
import { publish } from "../events.js";
import { ReviewConfigStore } from "../config-revisions.js";
import { PromptRevisionStore } from "../prompt-revisions.js";

export interface JobRow {
  id: number;
  repo_full_name: string;
  repo_owner: string;
  repo_name: string;
  installation_id: number;
  /** Forge identity of the connection this job belongs to (issue #18). */
  provider: string;
  provider_instance: string;
  /** Connection binding for non-GitHub forges; null for the env-configured GitHub App. */
  forge_connection_id: string | null;
  github_account_id: number | null;
  github_repository_id: number | null;
  pr_number: number;
  pr_title: string;
  pr_body: string;
  pr_html_url: string;
  pr_author: string;
  base_sha: string;
  head_sha: string;
  base_ref: string;
  head_ref: string;
  webhook_delivery_id: string | null;
  webhook_event: string | null;
  state: JobState;
  failure_reason: string | null;
  workspace_path: string | null;
  github_review_id: string | null;
  github_review_url: string | null;
  review_event: string | null;
  review_event_reason: string | null;
  aggregator_fallback: number | null;
  cancelled_reason: CancelReason | null;
  cancelled_by: string | null;
  profile_revision_id: number | null;
  job_type: "pr_review" | "health_scan" | "repo_brief" | "stack_review";
  scan_branch: string | null;
  /** Repo-brief payload (TOC + persisted file fragments), JSON; null for other job types. */
  brief_json: string | null;
  /**
   * Dedup discriminator for the jobs UNIQUE key: '' for PR reviews and scans
   * (one job per repo+PR+SHA), a per-request nonce for repo briefs — every
   * confirmed brief is its own job and repeats hit repo_brief_cache instead.
   */
  dedup_key: string;
  aggregator_raw: string | null;
  aggregator_normalized: string | null;
  aggregator_model: string | null;
  aggregator_provider: string | null;
  aggregator_state: ReviewerState;
  aggregator_started_at: string | null;
  aggregator_finished_at: string | null;
  aggregator_duration_ms: number | null;
  aggregator_prompt_tokens: number | null;
  aggregator_completion_tokens: number | null;
  aggregator_cost: number | null;
  aggregator_reasoning_tokens: number | null;
  aggregator_cache_read_tokens: number | null;
  aggregator_cache_write_tokens: number | null;
  aggregator_total_tokens: number | null;
  aggregator_usage_complete: number | null;
  aggregator_usage_warning: string | null;
  reconciliation_json: string | null;
  risk_profile: string | null;
  risk_reason: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  routing_state: string | null;
  routing_mode: string | null;
  routing_profile: string | null;
  routing_reason: string | null;
  routing_confidence: number | null;
  routing_signals: string | null;
  routing_reviewers: string | null;
  routing_source: string | null;
  routing_model: string | null;
  routing_provider: string | null;
  routing_raw: string | null;
  routing_prompt_tokens: number | null;
  routing_completion_tokens: number | null;
  routing_cost: number | null;
  routing_total_tokens: number | null;
  routing_usage_complete: number | null;
  routing_usage_warning: string | null;
  routing_duration_ms: number | null;
  internal_escalation_state: string | null;
  internal_escalation_reason: string | null;
  internal_escalation_model: string | null;
  internal_escalation_provider: string | null;
  internal_escalation_raw: string | null;
  internal_escalation_normalized: string | null;
  internal_escalation_prompt_tokens: number | null;
  internal_escalation_completion_tokens: number | null;
  internal_escalation_cost: number | null;
  internal_escalation_total_tokens: number | null;
  internal_escalation_usage_complete: number | null;
  internal_escalation_usage_warning: string | null;
  internal_escalation_duration_ms: number | null;
  internal_escalation_alert_cleared: number | null;
  external_dispatch_status: string | null;
  external_dispatch_reason: string | null;
  external_dispatch_targets: string | null;
  external_dispatch_error: string | null;
  budget_exceeded_warning: string | null;
  escalation_id: string | null;
  poison_alert_policy: string | null;
  manual_escalate_requested: number | null;
}

export interface ReviewerRunRow {
  id: number;
  job_id: number;
  role: string;
  title: string;
  model: string | null;
  provider: string | null;
  state: ReviewerState;
  attempt: number;
  raw_output: string | null;
  normalized_json: string | null;
  validation_error: string | null;
  stdout: string | null;
  stderr: string | null;
  exit_code: number | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost: number | null;
  reasoning_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number | null;
  usage_complete: number | null;
  prompt_revision_id: number | null;
  usage_warning: string | null;
}

export interface JobLogRow {
  id: number;
  job_id: number;
  reviewer_run_id: number | null;
  level: string;
  message: string;
  created_at: string;
}

export interface RepoPauseRow {
  id: number;
  provider: string;
  provider_instance: string;
  repo_full_name: string;
  actor: string;
  created_at: string;
  expires_at: string;
  ended_at: string | null;
  ended_by: string | null;
}

export interface GlobalPauseRow {
  id: number;
  actor: string;
  created_at: string;
  ended_at: string | null;
  ended_by: string | null;
}

export interface StackDeclarationRow {
  id: number;
  provider: string;
  provider_instance: string;
  repo_full_name: string;
  stack_id: string;
  pr_number: number;
  position: number;
  expected_count: number;
  actor: string;
  comment_id: string | null;
  created_at: string;
}

export interface StackMemberRow {
  id: number;
  job_id: number;
  position: number;
  pr_number: number;
  base_ref: string;
  head_ref: string;
  base_sha: string;
  head_sha: string;
  member_job_id: number | null;
  state: string;
}

export interface NewJobInput {
  repoFullName: string;
  repoOwner: string;
  repoName: string;
  installationId: number;
  /** Forge identity; defaults to the env-configured GitHub connection. */
  provider?: string;
  providerInstance?: string;
  forgeConnectionId?: string | null;
  githubAccountId?: number;
  githubRepositoryId?: number;
  prNumber: number;
  prTitle: string;
  prBody: string;
  prHtmlUrl: string;
  prAuthor: string;
  baseSha: string;
  headSha: string;
  baseRef: string;
  headRef: string;
  webhookDeliveryId?: string;
  webhookEvent?: string;
  reviewers: { role: string; title: string; model?: string }[];
  jobType?: "pr_review" | "health_scan" | "repo_brief" | "stack_review";
  scanBranch?: string | null;
  /** Dedup discriminator inside the jobs UNIQUE; repo_brief overrides this with a nonce. */
  dedupKey?: string;
}

export interface EnqueueResult {
  job: JobRow;
  created: boolean;
  skippedReason?: string;
  staleJobIds: number[];
}

export interface WebhookDeliveryRow {
  rowid: number;
  provider: string;
  provider_instance: string;
  delivery_id: string;
  event: string;
  action: string | null;
  repo_full_name: string | null;
  actor: string | null;
  result: string;
  created_at: string;
}

export interface EscalationDispatchRow {
  id: number;
  escalation_id: string;
  job_id: number;
  provider: string;
  instance: string;
  repo_full_name: string;
  pr_number: number;
  head_sha: string;
  policy: string;
  target_key: string;
  target_type: string;
  status: string;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

// Non-terminal = claimed-to-be-running states plus queued. Derived, never
// hand-copied: crash recovery, reset, retry guards, and cancellation all scope
// to exactly these states via ACTIVE_STATES_SQL.
const ACTIVE_JOB_STATES: readonly JobState[] = ["queued", ...LIVE_JOB_STATES];

// Single source of truth for "non-terminal": crash recovery, reset, retry guards,
// and cancellation all scope to exactly these states.
const ACTIVE_STATES_SQL = ACTIVE_JOB_STATES.map((state) => `'${state}'`).join(", ");

const TERMINAL_SKIP_REQUEUE: JobState[] = [
  "completed",
  "publishing",
  "queued",
  "preparing",
  "reconciling",
  "routing",
  "reviewing",
  "aggregating",
  "sniffing",
];

const JOB_PATCH_KEYS = new Set<string>([
  "failure_reason",
  "review_event",
  "review_event_reason",
  "aggregator_fallback",
  "workspace_path",
  "github_review_id",
  "github_review_url",
  "aggregator_raw",
  "aggregator_normalized",
  "aggregator_model",
  "aggregator_provider",
  "aggregator_state",
  "aggregator_started_at",
  "aggregator_finished_at",
  "aggregator_duration_ms",
  "aggregator_prompt_tokens",
  "aggregator_completion_tokens",
  "aggregator_cost",
  "aggregator_reasoning_tokens",
  "aggregator_cache_read_tokens",
  "aggregator_cache_write_tokens",
  "aggregator_total_tokens",
  "aggregator_usage_complete",
  "aggregator_usage_warning",
  "routing_state",
  "routing_mode",
  "routing_profile",
  "routing_reason",
  "routing_confidence",
  "routing_signals",
  "routing_reviewers",
  "routing_source",
  "routing_model",
  "routing_provider",
  "routing_raw",
  "routing_prompt_tokens",
  "routing_completion_tokens",
  "routing_cost",
  "routing_total_tokens",
  "routing_usage_complete",
  "routing_usage_warning",
  "routing_duration_ms",
  "internal_escalation_state",
  "internal_escalation_reason",
  "internal_escalation_model",
  "internal_escalation_provider",
  "internal_escalation_raw",
  "internal_escalation_normalized",
  "internal_escalation_prompt_tokens",
  "internal_escalation_completion_tokens",
  "internal_escalation_cost",
  "internal_escalation_total_tokens",
  "internal_escalation_usage_complete",
  "internal_escalation_usage_warning",
  "internal_escalation_duration_ms",
  "internal_escalation_alert_cleared",
  "external_dispatch_status",
  "external_dispatch_reason",
  "external_dispatch_targets",
  "external_dispatch_error",
  "budget_exceeded_warning",
  "escalation_id",
  "poison_alert_policy",
  "manual_escalate_requested",
  "reconciliation_json",
  "risk_profile",
  "risk_reason",
  "brief_json",
]);

export class JobStore {
  /** Versioned review-profile configuration over the same database. */
  readonly configs: ReviewConfigStore;
  /** Versioned specialist prompts, fixtures, and evaluations over the same database. */
  readonly prompts: PromptRevisionStore;

  constructor(
    private readonly db: SqliteDb,
    modelCatalog: string[] = [],
  ) {
    this.configs = new ReviewConfigStore(db, modelCatalog);
    this.prompts = new PromptRevisionStore(db);
  }

  enqueue(input: NewJobInput & { profileRevisionId?: number }): EnqueueResult {
    const createdAt = nowIso();
    const staleJobIds: number[] = [];
    const scope = normalizeScope({ provider: input.provider, instance: input.providerInstance });

    const jobType = input.jobType ?? "pr_review";
    // Repo briefs are per-request jobs: a fresh nonce keeps every confirmed
    // brief distinct, and identical repeats are served by repo_brief_cache.
    // Stack reviews key dedup on `stack:<id>` so a retrigger after heads moved
    // supersedes the earlier run while identical triggers dedup onto it.
    const dedupKey = jobType === "repo_brief" ? randomUUID() : (input.dedupKey ?? "");

    const result = this.db.transaction(() => {
      // Briefs are pinned to an immutable SHA, so a newer SHA can never stale
      // one — and marking an in-flight brief stale would abort it mid-run.
      // dedup_key joins the stale scope so two stacks sharing a top PR never
      // abort each other ('' preserves the pr_review/scan behavior).
      if (jobType !== "repo_brief") {
        const stale = this.db
          .prepare(
            `UPDATE jobs
             SET state = 'stale', updated_at = ?, finished_at = COALESCE(finished_at, ?)
             WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND pr_number = ? AND head_sha != ?
               AND job_type = ? AND dedup_key = ? AND state NOT IN ('stale', 'cancelled')
             RETURNING id`,
          )
          .all(createdAt, createdAt, scope.provider, scope.instance, input.repoFullName, input.prNumber, input.headSha, jobType, dedupKey) as { id: number }[];
        staleJobIds.push(...stale.map((row) => row.id));
      }

      const existing = this.db
        .prepare(
          `SELECT * FROM jobs WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND pr_number = ? AND head_sha = ? AND job_type = ? AND dedup_key = ?`,
        )
        .get(scope.provider, scope.instance, input.repoFullName, input.prNumber, input.headSha, jobType, dedupKey) as JobRow | undefined;

      if (existing) {
        const skippedReason = skipReason(existing);
        return { job: existing, created: false, skippedReason, staleJobIds };
      }

      const insert = this.db
        .prepare(
          `INSERT INTO jobs (
            repo_full_name, repo_owner, repo_name, installation_id, provider, provider_instance, forge_connection_id,
            github_account_id, github_repository_id, pr_number,
            pr_title, pr_body, pr_html_url, pr_author, base_sha, head_sha, base_ref, head_ref,
            webhook_delivery_id, webhook_event, profile_revision_id, job_type, scan_branch, dedup_key, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          input.repoFullName,
          input.repoOwner,
          input.repoName,
          input.installationId,
          scope.provider,
          scope.instance,
          input.forgeConnectionId ?? null,
          input.githubAccountId ?? null,
          input.githubRepositoryId ?? null,
          input.prNumber,
          input.prTitle,
          input.prBody,
          input.prHtmlUrl,
          input.prAuthor,
          input.baseSha,
          input.headSha,
          input.baseRef,
          input.headRef,
          input.webhookDeliveryId ?? null,
          input.webhookEvent ?? null,
          input.profileRevisionId ?? this.configs.resolveProfileForRepo(input.repoFullName)?.id ?? null,
          jobType,
          input.scanBranch ?? null,
          dedupKey,
          createdAt,
          createdAt,
        );

      const jobId = Number(insert.lastInsertRowid);
      const reviewerInsert = this.db.prepare(
        `INSERT INTO reviewer_runs (job_id, role, title, model, state) VALUES (?, ?, ?, ?, 'queued')`,
      );
      for (const reviewer of input.reviewers) {
        reviewerInsert.run(jobId, reviewer.role, reviewer.title, reviewer.model ?? null);
      }

      const job = this.getJob(jobId);
      if (!job) throw new Error("failed to load inserted job");
      return { job, created: true, staleJobIds };
    })();

    publish({ type: "jobs" });
    for (const id of staleJobIds) publish({ type: "job", jobId: id });
    if (result.job) publish({ type: "job", jobId: result.job.id });
    return result;
  }

  /**
   * Repo-brief cache (issue #89): the persisted brief payload (TOC + file
   * fragments) for one forge/repo pinned at one exact SHA. A new SHA is a
   * different key, so moved tips miss by construction; there is no cross-repo
   * or cross-forge bleed because the key carries all three identifiers.
   */
  getRepoBriefCache(
    provider: string,
    providerInstance: string,
    repoFullName: string,
    sha: string,
  ): { payload: string; created_at: string } | undefined {
    const scope = normalizeScope({ provider, instance: providerInstance });
    return this.db
      .prepare(`SELECT payload, created_at FROM repo_brief_cache WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND sha = ?`)
      .get(scope.provider, scope.instance, repoFullName, sha) as { payload: string; created_at: string } | undefined;
  }

  putRepoBriefCache(provider: string, providerInstance: string, repoFullName: string, sha: string, payload: string): void {
    const scope = normalizeScope({ provider, instance: providerInstance });
    this.db
      .prepare(
        `INSERT OR REPLACE INTO repo_brief_cache (provider, provider_instance, repo_full_name, sha, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(scope.provider, scope.instance, repoFullName, sha, payload, nowIso());
  }

  /**
   * Timed automatic-review pause (issue #99). Durable and expiring: one
   * pause per repo at a time — creating a new one supersedes an active row
   * (operator "extend"), and expiry is checked on read so lapsed pauses
   * silently stop gating future webhooks.
   */
  createPause(input: {
    repoFullName: string;
    actor: string;
    durationMs: number;
    provider?: string;
    providerInstance?: string;
  }): RepoPauseRow {
    const scope = normalizeScope({ provider: input.provider, instance: input.providerInstance });
    const now = nowIso();
    const expiresAt = new Date(Date.now() + input.durationMs).toISOString();
    this.db
      .prepare(
        `UPDATE repo_pauses SET ended_at = ?, ended_by = ?
         WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND ended_at IS NULL`,
      )
      .run(now, `${input.actor} (superseded)`, scope.provider, scope.instance, input.repoFullName);
    const insert = this.db
      .prepare(
        `INSERT INTO repo_pauses (provider, provider_instance, repo_full_name, actor, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(scope.provider, scope.instance, input.repoFullName, input.actor, now, expiresAt);
    return this.db.prepare(`SELECT * FROM repo_pauses WHERE id = ?`).get(insert.lastInsertRowid) as RepoPauseRow;
  }

  getActivePause(repoFullName: string, provider?: string, providerInstance?: string): RepoPauseRow | undefined {
    const scope = normalizeScope({ provider, instance: providerInstance });
    return this.db
      .prepare(
        `SELECT * FROM repo_pauses
         WHERE provider = ? AND provider_instance = ? AND repo_full_name = ?
           AND ended_at IS NULL AND expires_at > ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(scope.provider, scope.instance, repoFullName, nowIso()) as RepoPauseRow | undefined;
  }

  listActivePauses(): RepoPauseRow[] {
    return this.db
      .prepare(
        `SELECT * FROM repo_pauses WHERE ended_at IS NULL AND expires_at > ? ORDER BY repo_full_name`,
      )
      .all(nowIso()) as RepoPauseRow[];
  }

  endPause(id: number, actor: string): boolean {
    const updated = this.db
      .prepare(`UPDATE repo_pauses SET ended_at = ?, ended_by = ? WHERE id = ? AND ended_at IS NULL`)
      .run(nowIso(), actor, id);
    return updated.changes > 0;
  }

  /**
   * Instance-wide review pause (operator "Pause reviews" switch). Durable and
   * indefinite: unlike repo_pauses there is no expiry — reviews resume only
   * when an operator ends it. One active row at a time; pausing while paused
   * supersedes the previous row so the audit trail records both actors.
   */
  setGlobalPause(actor: string): GlobalPauseRow {
    const now = nowIso();
    this.db
      .prepare(`UPDATE global_pauses SET ended_at = ?, ended_by = ? WHERE ended_at IS NULL`)
      .run(now, `${actor} (superseded)`);
    const insert = this.db
      .prepare(`INSERT INTO global_pauses (actor, created_at) VALUES (?, ?)`)
      .run(actor, now);
    return this.db.prepare(`SELECT * FROM global_pauses WHERE id = ?`).get(insert.lastInsertRowid) as GlobalPauseRow;
  }

  getGlobalPause(): GlobalPauseRow | undefined {
    return this.db
      .prepare(`SELECT * FROM global_pauses WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1`)
      .get() as GlobalPauseRow | undefined;
  }

  endGlobalPause(actor: string): boolean {
    const updated = this.db
      .prepare(`UPDATE global_pauses SET ended_at = ?, ended_by = ? WHERE ended_at IS NULL`)
      .run(nowIso(), actor);
    return updated.changes > 0;
  }

  /**
   * Records one stack member declaration (issue #99). Idempotent on an
   * identical repeat; fails closed on conflicting declarations so an
   * ambiguous stack is rejected before any model work.
   */
  upsertStackDeclaration(input: {
    repoFullName: string;
    stackId: string;
    prNumber: number;
    position: number;
    expectedCount: number;
    actor: string;
    commentId?: string;
    provider?: string;
    providerInstance?: string;
  }): { ok: true; created: boolean } | { ok: false; error: string } {
    const scope = normalizeScope({ provider: input.provider, instance: input.providerInstance });
    const existing = this.db
      .prepare(
        `SELECT * FROM stack_declarations
         WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND stack_id = ? AND pr_number = ?`,
      )
      .get(scope.provider, scope.instance, input.repoFullName, input.stackId, input.prNumber) as StackDeclarationRow | undefined;
    if (existing) {
      if (existing.position === input.position && existing.expected_count === input.expectedCount) {
        return { ok: true, created: false };
      }
      return {
        ok: false,
        error: `PR #${input.prNumber} is already declared as issue ${existing.position} of ${existing.expected_count} in stack "${input.stackId}"`,
      };
    }
    const occupant = this.db
      .prepare(
        `SELECT pr_number FROM stack_declarations
         WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND stack_id = ? AND position = ?`,
      )
      .get(scope.provider, scope.instance, input.repoFullName, input.stackId, input.position) as { pr_number: number } | undefined;
    if (occupant && occupant.pr_number !== input.prNumber) {
      return {
        ok: false,
        error: `position ${input.position} in stack "${input.stackId}" is already declared by PR #${occupant.pr_number}`,
      };
    }
    this.db
      .prepare(
        `INSERT INTO stack_declarations (provider, provider_instance, repo_full_name, stack_id, pr_number, position, expected_count, actor, comment_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scope.provider,
        scope.instance,
        input.repoFullName,
        input.stackId,
        input.prNumber,
        input.position,
        input.expectedCount,
        input.actor,
        input.commentId ?? null,
        nowIso(),
      );
    return { ok: true, created: true };
  }

  listStackDeclarations(repoFullName: string, stackId: string, provider?: string, providerInstance?: string): StackDeclarationRow[] {
    const scope = normalizeScope({ provider, instance: providerInstance });
    return this.db
      .prepare(
        `SELECT * FROM stack_declarations
         WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND stack_id = ?
         ORDER BY position`,
      )
      .all(scope.provider, scope.instance, repoFullName, stackId) as StackDeclarationRow[];
  }

  /** Ordered SHA vector snapshot for a stack_review job (issue #99). */
  insertStackMembers(
    jobId: number,
    members: { position: number; prNumber: number; baseRef: string; headRef: string; baseSha: string; headSha: string }[],
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO stack_run_members (job_id, position, pr_number, base_ref, head_ref, base_sha, head_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const member of members) {
      insert.run(jobId, member.position, member.prNumber, member.baseRef, member.headRef, member.baseSha, member.headSha);
    }
  }

  listStackMembers(jobId: number): StackMemberRow[] {
    return this.db
      .prepare(`SELECT * FROM stack_run_members WHERE job_id = ? ORDER BY position`)
      .all(jobId) as StackMemberRow[];
  }

  patchStackMember(id: number, patch: { baseSha?: string; headSha?: string; memberJobId?: number; state?: string }): void {
    if (patch.baseSha === undefined && patch.headSha === undefined && patch.memberJobId === undefined && patch.state === undefined) return;
    this.db
      .prepare(
        `UPDATE stack_run_members
         SET base_sha = COALESCE(?, base_sha), head_sha = COALESCE(?, head_sha), member_job_id = COALESCE(?, member_job_id), state = COALESCE(?, state)
         WHERE id = ?`,
      )
      .run(patch.baseSha ?? null, patch.headSha ?? null, patch.memberJobId ?? null, patch.state ?? null, id);
  }

  getJob(id: number): JobRow | undefined {
    return this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
  }

  listJobs(limit = 50): JobRow[] {
    return this.db.prepare(`SELECT * FROM jobs ORDER BY id DESC LIMIT ?`).all(limit) as JobRow[];
  }

  /**
   * Pancake easter egg: derived, not stored — every completed job is one
   * pancake, counting straight off the jobs table so restarts and retries
   * never double-count. `latestId` is the newest completed job id (0 if none);
   * the UI compares it against a localStorage high-water mark to decide when
   * to play the animation.
   */
  pancakeStats(): { count: number; latestId: number } {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count, MAX(id) AS latest FROM jobs WHERE state = 'completed'`)
      .get() as { count: number; latest: number | null };
    return { count: row.count, latestId: row.latest ?? 0 };
  }

  /**
   * Keyset pagination over the job list, newest first. Cursors are exclusive
   * job ids: `before` pages older than that id, `after` pages newer. A +1
   * probe row (plus an existence check for the opposite edge) derives
   * hasOlder/hasNewer without offsets, so newly queued jobs never reshuffle
   * an open cursor window. Limit is clamped into [1, JOBS_PAGE_SIZE_MAX]; no
   * cursor validation happens here — callers own it (the home route drops
   * malformed values and re-renders the first page when a cursor yields
   * nothing).
   */
  listJobsPage(input: { before?: number; after?: number; limit?: number; forge?: { provider: string; instance: string } }): {
    jobs: JobRow[];
    hasOlder: boolean;
    hasNewer: boolean;
  } {
    const requested = input.limit ?? JOBS_PAGE_SIZE_DEFAULT;
    const limit = Math.min(Number.isFinite(requested) ? Math.max(1, requested) : JOBS_PAGE_SIZE_DEFAULT, JOBS_PAGE_SIZE_MAX);
    const whereParts: string[] = [];
    const whereParams: unknown[] = [];
    if (input.forge) {
      whereParts.push("provider = ?", "provider_instance = ?");
      whereParams.push(input.forge.provider, input.forge.instance);
    }
    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
    // Cursor filters must ride the same WHERE as the page itself.
    const withId = (comparator: string) =>
      whereSql ? `${whereSql} AND id ${comparator} ?` : `WHERE id ${comparator} ?`;
    if (input.after != null) {
      const probed = this.db
        .prepare(`SELECT * FROM jobs ${withId(">")} ORDER BY id ASC LIMIT ?`)
        .all(...whereParams, input.after, limit + 1) as JobRow[];
      // Rows arrive oldest→newest; reverse into the page's newest-first order.
      const jobs = probed.slice(0, limit).reverse();
      const hasNewer = probed.length > limit;
      const oldestOnPage = jobs[jobs.length - 1]?.id ?? input.after;
      const hasOlder = Boolean(
        this.db.prepare(`SELECT id FROM jobs ${withId("<")} LIMIT 1`).get(...whereParams, oldestOnPage),
      );
      return { jobs, hasOlder, hasNewer };
    }
    if (input.before != null) {
      const probed = this.db
        .prepare(`SELECT * FROM jobs ${withId("<")} ORDER BY id DESC LIMIT ?`)
        .all(...whereParams, input.before, limit + 1) as JobRow[];
      const jobs = probed.slice(0, limit);
      const hasOlder = probed.length > limit;
      const newestOnPage = jobs[0]?.id ?? input.before;
      const hasNewer = Boolean(
        this.db.prepare(`SELECT id FROM jobs ${withId(">")} LIMIT 1`).get(...whereParams, newestOnPage),
      );
      return { jobs, hasOlder, hasNewer };
    }
    const probed = this.db
      .prepare(`SELECT * FROM jobs ${whereSql} ORDER BY id DESC LIMIT ?`)
      .all(...whereParams, limit + 1) as JobRow[];
    const jobs = probed.slice(0, limit);
    return { jobs, hasOlder: probed.length > limit, hasNewer: false };
  }

  /** Distinct forge scopes present in the jobs table, for dashboard filters. */
  listForgeScopes(): Array<{ provider: string; instance: string }> {
    return this.db
      .prepare(`SELECT DISTINCT provider, provider_instance AS instance FROM jobs ORDER BY provider, provider_instance`)
      .all() as Array<{ provider: string; instance: string }>;
  }

  listInterruptedJobs(): JobRow[] {
    // Derive the IN-list from ACTIVE_JOB_STATES so a new job state cannot drift out of crash recovery.
    return this.db
      .prepare(`SELECT * FROM jobs WHERE state IN (${ACTIVE_STATES_SQL})`)
      .all() as JobRow[];
  }

  listReviewerRuns(jobId: number): ReviewerRunRow[] {
    return this.db
      .prepare(`SELECT * FROM reviewer_runs WHERE job_id = ? ORDER BY id ASC`)
      .all(jobId) as ReviewerRunRow[];
  }

  getReviewerRun(id: number): ReviewerRunRow | undefined {
    return this.db.prepare(`SELECT * FROM reviewer_runs WHERE id = ?`).get(id) as ReviewerRunRow | undefined;
  }

  listLogs(jobId: number, limit = 300): JobLogRow[] {
    return this.db
      .prepare(`SELECT * FROM job_logs WHERE job_id = ? ORDER BY id DESC LIMIT ?`)
      .all(jobId, limit)
      .reverse() as JobLogRow[];
  }

  setJobState(id: number, state: JobState, extra: Partial<JobRow> = {}): void {
    const job = this.getJob(id);
    if (!job) return;
    // `stale` and `cancelled` are one-way terminal states: a late pipeline
    // failure (or a racing transition) must not resurrect or relabel them.
    // Same-state patches still apply — patchJob relies on this.
    if ((job.state === "stale" || job.state === "cancelled") && state !== job.state) {
      // This runs inside error-handling paths; its own failure must not escape.
      try {
        this.log(id, `Ignored state transition ${job.state} -> ${state} on terminal job`, "warn");
      } catch (error) {
        console.error(`store: could not log refused transition for job ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    const updatedAt = nowIso();
    const startedAt = extra.started_at ?? job.started_at ?? (state !== "queued" ? updatedAt : null);
    const finishedAt =
      extra.finished_at ??
      (["completed", "failed", "stale", "cancelled"].includes(state) ? (job.finished_at ?? updatedAt) : job.finished_at);
    const fields: Record<string, unknown> = {
      state,
      started_at: startedAt,
      finished_at: finishedAt,
      updated_at: updatedAt,
    };
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) continue;
      if (key === "started_at" || key === "finished_at" || key === "state") continue;
      if (JOB_PATCH_KEYS.has(key)) fields[key] = value;
    }
    const assignments = Object.keys(fields).map((column) => `${column} = ?`);
    const values = Object.keys(fields).map((column) => fields[column]);
    this.db.prepare(`UPDATE jobs SET ${assignments.join(", ")} WHERE id = ?`).run(...values, id);
    publish({ type: "job", jobId: id });
    publish({ type: "jobs" });
  }

  patchJob(id: number, extra: Partial<JobRow>): void {
    const job = this.getJob(id);
    if (!job) return;
    this.setJobState(id, job.state, extra);
  }

  isStale(id: number): boolean {
    const job = this.getJob(id);
    return !job || job.state === "stale" || job.state === "cancelled";
  }

  /**
   * Atomically moves every matching non-terminal job to `cancelled` in a
   * single UPDATE (implicit transaction) and returns the ids that actually
   * transitioned. Idempotent by construction: terminal jobs (completed,
   * failed, stale, already cancelled) never match, so a duplicate merge
   * webhook is a no-op. The where-union makes an unfiltered database-wide
   * cancellation unrepresentable.
   */
  cancelJobs(
    where:
      | { jobId: number }
      | { repoFullName: string; prNumber: number; scope?: Partial<ForgeScope> }
      | { repoFullName?: string; jobType: string; scope?: Partial<ForgeScope> },
    reason: CancelReason,
    actor: string | null,
  ): number[] {
    const now = nowIso();
    const scope = normalizeScope("scope" in where ? where.scope : undefined);
    const clauses = [`state IN (${ACTIVE_STATES_SQL})`];
    const values: unknown[] = [reason, actor, now, now];
    // A type-wide (global) cancel targets every forge scope; all other
    // variants stay inside the normalized scope like before.
    const spansScopes = "jobType" in where && where.repoFullName == null;
    if (!spansScopes) {
      clauses.push("provider = ?", "provider_instance = ?");
      values.push(scope.provider, scope.instance);
    }
    if ("jobId" in where) {
      clauses.push("id = ?");
      values.push(where.jobId);
    } else if ("jobType" in where) {
      clauses.push("job_type = ?");
      values.push(where.jobType);
      if (where.repoFullName != null) {
        clauses.push("repo_full_name = ?");
        values.push(where.repoFullName);
      }
    } else {
      clauses.push("repo_full_name = ?", "pr_number = ?");
      values.push(where.repoFullName, where.prNumber);
    }
    const rows = this.db
      .prepare(
        `UPDATE jobs
         SET state = 'cancelled', cancelled_reason = ?, cancelled_by = ?,
             finished_at = COALESCE(finished_at, ?), updated_at = ?
         WHERE ${clauses.join(" AND ")}
         RETURNING id`,
      )
      .all(...values) as { id: number }[];
    return rows.map((row) => row.id);
  }

  /**
   * Records that a pull request merged, keyed by repo + PR number. Written on
   * every verified merged close delivery — independent of whether any job was
   * cancelled — so the enqueue gate holds even when nothing was running.
   * Merged pulls cannot be reopened, so the record is permanent.
   */
  markPullMerged(
    repoFullName: string,
    prNumber: number,
    deliveryId: string | null,
    scope?: Partial<ForgeScope>,
  ): void {
    const resolved = normalizeScope(scope);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO merged_pulls (repo_full_name, pr_number, provider, provider_instance, merged_at, delivery_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(repoFullName, prNumber, resolved.provider, resolved.instance, nowIso(), deliveryId);
  }

  /** True once a verified webhook recorded this pull as merged. */
  hasMergedPull(repoFullName: string, prNumber: number, scope?: Partial<ForgeScope>): boolean {
    const resolved = normalizeScope(scope);
    return Boolean(
      this.db
        .prepare(
          `SELECT repo_full_name FROM merged_pulls WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND pr_number = ?`,
        )
        .get(resolved.provider, resolved.instance, repoFullName, prNumber),
    );
  }

  resetInterrupted(id: number): void {
    const updatedAt = nowIso();
    this.db
      .prepare(
        `UPDATE jobs SET state = 'queued', failure_reason = NULL, started_at = NULL, finished_at = NULL,
         aggregator_state = 'queued', aggregator_started_at = NULL, aggregator_finished_at = NULL, updated_at = ?
         WHERE id = ? AND state IN (${ACTIVE_STATES_SQL})`,
      )
      .run(updatedAt, id);
    this.db
      .prepare(
        `UPDATE reviewer_runs SET state = 'queued', started_at = NULL, finished_at = NULL, attempt = 0
         WHERE job_id = ? AND state IN ('queued', 'running')`,
      )
      .run(id);
    publish({ type: "job", jobId: id });
  }

  retryFailedReviewers(jobId: number, runId?: number): { ok: true; reset: number } | { ok: false; error: string } {
    const job = this.getJob(jobId);
    if (!job) return { ok: false, error: "job not found" };
    if (job.state === "stale" || job.state === "cancelled") {
      return { ok: false, error: `cannot retry a ${job.state} job` };
    }
    if (ACTIVE_JOB_STATES.includes(job.state)) {
      return { ok: false, error: "job is still running" };
    }

    const runs = this.listReviewerRuns(jobId);
    if (runId != null) {
      const run = runs.find((row) => row.id === runId);
      if (!run) return { ok: false, error: "reviewer run not found" };
      if (run.state !== "failed") return { ok: false, error: "only failed reviewers can be retried" };
    }
    const targets = runs.filter((run) => run.state === "failed" && (runId == null || run.id === runId));
    if (targets.length === 0) return { ok: false, error: "no failed reviewers to retry" };

    const updatedAt = nowIso();
    this.db.transaction(() => {
      const reset = this.db.prepare(
        `UPDATE reviewer_runs SET
           state = 'queued', attempt = 0, validation_error = NULL, raw_output = NULL,
           normalized_json = NULL, stdout = NULL, stderr = NULL, exit_code = NULL,
           started_at = NULL, finished_at = NULL, duration_ms = NULL,
           prompt_tokens = NULL, completion_tokens = NULL, cost = NULL,
           reasoning_tokens = NULL, cache_read_tokens = NULL, cache_write_tokens = NULL,
           total_tokens = NULL, usage_complete = NULL, usage_warning = NULL
         WHERE id = ?`,
      );
      for (const run of targets) reset.run(run.id);
      this.db
        .prepare(
          `UPDATE jobs SET
             state = 'queued', failure_reason = NULL, started_at = NULL, finished_at = NULL,
             aggregator_state = 'queued', aggregator_started_at = NULL, aggregator_finished_at = NULL,
             aggregator_raw = NULL, aggregator_normalized = NULL, aggregator_duration_ms = NULL,
             aggregator_prompt_tokens = NULL, aggregator_completion_tokens = NULL, aggregator_cost = NULL,
             aggregator_reasoning_tokens = NULL, aggregator_cache_read_tokens = NULL,
             aggregator_cache_write_tokens = NULL, aggregator_total_tokens = NULL,
             aggregator_usage_complete = NULL, aggregator_usage_warning = NULL,
             updated_at = ?
           WHERE id = ?`,
        )
        .run(updatedAt, jobId);
    })();

    this.log(
      jobId,
      runId == null
        ? `Retrying ${targets.length} failed reviewer(s)`
        : `Retrying failed reviewer ${targets[0]?.role}`,
    );
    publish({ type: "job", jobId });
    publish({ type: "jobs" });
    return { ok: true, reset: targets.length };
  }

  patchReviewer(id: number, extra: Partial<ReviewerRunRow>): void {
    const current = this.getReviewerRun(id);
    if (!current) return;
    const columns: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) continue;
      columns.push(`${key} = ?`);
      values.push(value);
    }
    if (columns.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE reviewer_runs SET ${columns.join(", ")} WHERE id = ?`).run(...values);
    publish({ type: "job", jobId: current.job_id });
  }

  log(jobId: number, message: string, level = "info", reviewerRunId?: number): void {
    this.db
      .prepare(
        `INSERT INTO job_logs (job_id, reviewer_run_id, level, message, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(jobId, reviewerRunId ?? null, level, message, nowIso());
    publish({ type: "log", jobId });
  }

  jobSummary(job: JobRow): {
    reviewersDone: number;
    reviewersTotal: number;
    reviewersFailed: number;
  } {
    const runs = this.listReviewerRuns(job.id);
    return {
      reviewersTotal: runs.length,
      reviewersDone: runs.filter((run) => run.state === "done").length,
      reviewersFailed: runs.filter((run) => run.state === "failed").length,
    };
  }

  ensureReviewerRuns(jobId: number, reviewers: { role: string; title: string; model?: string }[]): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO reviewer_runs (job_id, role, title, model, state) VALUES (?, ?, ?, ?, 'queued')`,
    );
    for (const reviewer of reviewers) {
      insert.run(jobId, reviewer.role, reviewer.title, reviewer.model ?? null);
    }
    publish({ type: "job", jobId });
  }

  // ---- Health-scan issue creation ----

  /**
   * Claims a fingerprint before issue creation (issue_number 0 = pending).
   * Returns true only when this call won the claim: concurrent submits lose the race,
   * and a pending row left by a crashed run is retried by clearing it on failure.
   */
  claimScanIssue(input: {
    jobId: number;
    repoFullName: string;
    fingerprint: string;
    title: string;
    scope?: Partial<ForgeScope>;
  }): boolean {
    const scope = normalizeScope(input.scope);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO scan_issues (job_id, repo_full_name, provider, provider_instance, fingerprint, issue_number, issue_url, title, created_at)
         VALUES (?, ?, ?, ?, ?, 0, '', ?, ?)`,
      )
      .run(input.jobId, input.repoFullName, scope.provider, scope.instance, input.fingerprint, input.title, nowIso());
    return ((result as { changes?: number }).changes ?? 0) === 1;
  }

  /** Records/updates the resulting issue for a claimed fingerprint. */
  recordScanIssue(input: {
    jobId: number;
    repoFullName: string;
    fingerprint: string;
    issueNumber: number;
    issueUrl: string;
    title: string;
    scope?: Partial<ForgeScope>;
  }): void {
    const scope = normalizeScope(input.scope);
    this.db
      .prepare(
        `INSERT INTO scan_issues (job_id, repo_full_name, provider, provider_instance, fingerprint, issue_number, issue_url, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, provider_instance, repo_full_name, fingerprint) DO UPDATE SET
           issue_number = excluded.issue_number,
           issue_url = excluded.issue_url,
           title = excluded.title,
           job_id = excluded.job_id`,
      )
      .run(input.jobId, input.repoFullName, scope.provider, scope.instance, input.fingerprint, input.issueNumber, input.issueUrl, input.title, nowIso());
  }

  listScanIssues(jobId: number): Array<{ id: number; job_id: number; repo_full_name: string; fingerprint: string; issue_number: number; issue_url: string; title: string; created_at: string }> {
    return this.db
      .prepare(`SELECT * FROM scan_issues WHERE job_id = ? ORDER BY id ASC`)
      .all(jobId) as Array<{ id: number; job_id: number; repo_full_name: string; fingerprint: string; issue_number: number; issue_url: string; title: string; created_at: string }>;
  }

  getScanIssue(repoFullName: string, fingerprint: string, scope?: Partial<ForgeScope>): { issue_number: number; issue_url: string; title: string } | undefined {
    const resolved = normalizeScope(scope);
    return this.db
      .prepare(
        `SELECT issue_number, issue_url, title FROM scan_issues WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND fingerprint = ?`,
      )
      .get(resolved.provider, resolved.instance, repoFullName, fingerprint) as { issue_number: number; issue_url: string; title: string } | undefined;
  }

  clearScanIssue(repoFullName: string, fingerprint: string, scope?: Partial<ForgeScope>): void {
    const resolved = normalizeScope(scope);
    this.db
      .prepare(
        `DELETE FROM scan_issues WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND fingerprint = ? AND issue_number = 0`,
      )
      .run(resolved.provider, resolved.instance, repoFullName, fingerprint);
  }

  hasScanIssue(repoFullName: string, fingerprint: string, scope?: Partial<ForgeScope>): boolean {
    const resolved = normalizeScope(scope);
    return Boolean(
      this.db
        .prepare(
          `SELECT id FROM scan_issues WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND fingerprint = ?`,
        )
        .get(resolved.provider, resolved.instance, repoFullName, fingerprint),
    );
  }

  /**
   * Targeted status rewrite for one finding row (e.g. downgrading a "resolved"
   * whose GitHub thread resolve failed, so the next run retries it).
   */
  setFindingStatus(
    repoFullName: string,
    prNumber: number,
    fingerprint: string,
    status: FindingStatus,
    reconciliationReason: string,
    scope?: Partial<ForgeScope>,
  ): void {
    const resolved = normalizeScope(scope);
    this.db
      .prepare(
        `UPDATE findings SET status = ?, reconciliation_reason = ?, updated_at = ?
         WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND pr_number = ? AND fingerprint = ?`,
      )
      .run(status, reconciliationReason, nowIso(), resolved.provider, resolved.instance, repoFullName, prNumber, fingerprint);
  }

  /**
   * Deletes pending claims (issue_number 0) left behind by a crashed creation
   * loop. Only safe at boot — while the process runs, an in-flight loop may own
   * such a row. Returns the number of claims removed.
   */
  clearOrphanedScanIssueClaims(): number {
    const result = this.db.prepare(`DELETE FROM scan_issues WHERE issue_number = 0`).run();
    return (result as { changes?: number }).changes ?? 0;
  }

  findLatestJobForPull(repoFullName: string, prNumber: number, headSha?: string, scope?: Partial<ForgeScope>): JobRow | undefined {
    const resolved = normalizeScope(scope);
    if (headSha) {
      return this.db
        .prepare(
          `SELECT * FROM jobs WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND pr_number = ? AND head_sha = ?`,
        )
        .get(resolved.provider, resolved.instance, repoFullName, prNumber, headSha) as JobRow | undefined;
    }
    return this.db
      .prepare(
        `SELECT * FROM jobs WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND pr_number = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(resolved.provider, resolved.instance, repoFullName, prNumber) as JobRow | undefined;
  }

  listDispatches(jobId: number): EscalationDispatchRow[] {
    return this.db
      .prepare(`SELECT * FROM escalation_dispatches WHERE job_id = ? ORDER BY id ASC`)
      .all(jobId) as EscalationDispatchRow[];
  }

  claimDispatch(input: {
    escalationId: string;
    jobId: number;
    provider: string;
    instance: string;
    repoFullName: string;
    prNumber: number;
    headSha: string;
    policy: string;
    targetKey: string;
    targetType: string;
  }): { created: boolean; row: EscalationDispatchRow } {
    const now = nowIso();
    const existing = this.db
      .prepare(
        `SELECT * FROM escalation_dispatches
         WHERE provider = ? AND instance = ? AND repo_full_name = ? AND pr_number = ? AND head_sha = ? AND policy = ? AND target_key = ?`,
      )
      .get(
        input.provider,
        input.instance,
        input.repoFullName,
        input.prNumber,
        input.headSha,
        input.policy,
        input.targetKey,
      ) as EscalationDispatchRow | undefined;
    if (existing) {
      if (existing.status === "dispatched" || existing.status === "dispatching") {
        return { created: false, row: existing };
      }
      this.updateDispatch(existing.id, "dispatching");
      return { created: true, row: { ...existing, status: "dispatching" } };
    }
    const insert = this.db
      .prepare(
        `INSERT INTO escalation_dispatches (
          escalation_id, job_id, provider, instance, repo_full_name, pr_number, head_sha, policy,
          target_key, target_type, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?)`,
      )
      .run(
        input.escalationId,
        input.jobId,
        input.provider,
        input.instance,
        input.repoFullName,
        input.prNumber,
        input.headSha,
        input.policy,
        input.targetKey,
        input.targetType,
        now,
        now,
      );
    const row = this.db
      .prepare(`SELECT * FROM escalation_dispatches WHERE id = ?`)
      .get(Number(insert.lastInsertRowid)) as EscalationDispatchRow;
    return { created: true, row };
  }

  updateDispatch(id: number, status: string, detail?: string): void {
    this.db
      .prepare(`UPDATE escalation_dispatches SET status = ?, detail = COALESCE(?, detail), updated_at = ? WHERE id = ?`)
      .run(status, detail ?? null, nowIso(), id);
  }

  listFindings(repoFullName: string, prNumber: number, scope?: Partial<ForgeScope>): FindingRow[] {
    const resolved = normalizeScope(scope);
    return this.db
      .prepare(
        `SELECT * FROM findings WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND pr_number = ? ORDER BY id ASC`,
      )
      .all(resolved.provider, resolved.instance, repoFullName, prNumber) as FindingRow[];
  }

  getFinding(repoFullName: string, prNumber: number, fingerprint: string, scope?: Partial<ForgeScope>): FindingRow | undefined {
    const resolved = normalizeScope(scope);
    return this.db
      .prepare(
        `SELECT * FROM findings WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND pr_number = ? AND fingerprint = ?`,
      )
      .get(resolved.provider, resolved.instance, repoFullName, prNumber, fingerprint) as FindingRow | undefined;
  }

  upsertFinding(input: {
    repoFullName: string;
    prNumber: number;
    fingerprint: string;
    scope?: Partial<ForgeScope>;
    status: FindingStatus;
    reviewedSha: string;
    currentSha?: string | null;
    githubThreadId?: string | null;
    githubCommentId?: string | null;
    originalPath?: string | null;
    originalLine?: number | null;
    currentPath?: string | null;
    currentLine?: number | null;
    category?: string | null;
    summary: string;
    body?: string | null;
    severity?: string | null;
    confidence?: number | null;
    dismissedBy?: string | null;
    dismissedAt?: string | null;
    dismissCommand?: string | null;
    reopenedBy?: string | null;
    reopenedAt?: string | null;
    reopenCommand?: string | null;
    reconciliationConfidence?: number | null;
    reconciliationReason?: string | null;
    diffHunk?: string | null;
    diffNote?: string | null;
    lastJobId?: number | null;
  }): FindingRow {
    const scope = normalizeScope(input.scope);
    const existing = this.getFinding(input.repoFullName, input.prNumber, input.fingerprint, scope);
    if (
      existing?.status === "dismissed" &&
      input.status !== "dismissed" &&
      !(input.status === "open" && input.reopenedBy)
    ) {
      return existing;
    }
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO findings (
          repo_full_name, pr_number, provider, provider_instance, fingerprint, status, reviewed_sha, current_sha,
          github_thread_id, github_comment_id, original_path, original_line, current_path, current_line,
          category, summary, body, severity, confidence,
          dismissed_by, dismissed_at, dismiss_command, reopened_by, reopened_at, reopen_command,
          reconciliation_confidence, reconciliation_reason, diff_hunk, diff_note, last_job_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, provider_instance, repo_full_name, pr_number, fingerprint) DO UPDATE SET
          status = excluded.status,
          reviewed_sha = excluded.reviewed_sha,
          current_sha = COALESCE(excluded.current_sha, findings.current_sha),
          github_thread_id = COALESCE(excluded.github_thread_id, findings.github_thread_id),
          github_comment_id = COALESCE(excluded.github_comment_id, findings.github_comment_id),
          original_path = COALESCE(excluded.original_path, findings.original_path),
          original_line = COALESCE(excluded.original_line, findings.original_line),
          current_path = COALESCE(excluded.current_path, findings.current_path),
          current_line = COALESCE(excluded.current_line, findings.current_line),
          category = COALESCE(excluded.category, findings.category),
          summary = excluded.summary,
          body = COALESCE(excluded.body, findings.body),
          severity = COALESCE(excluded.severity, findings.severity),
          confidence = COALESCE(excluded.confidence, findings.confidence),
          dismissed_by = excluded.dismissed_by,
          dismissed_at = excluded.dismissed_at,
          dismiss_command = excluded.dismiss_command,
          reopened_by = excluded.reopened_by,
          reopened_at = excluded.reopened_at,
          reopen_command = excluded.reopen_command,
          reconciliation_confidence = COALESCE(excluded.reconciliation_confidence, findings.reconciliation_confidence),
          reconciliation_reason = COALESCE(excluded.reconciliation_reason, findings.reconciliation_reason),
          diff_hunk = CASE
            WHEN excluded.diff_hunk IS NULL AND excluded.diff_note IS NULL THEN findings.diff_hunk
            ELSE excluded.diff_hunk
          END,
          diff_note = CASE
            WHEN excluded.diff_hunk IS NULL AND excluded.diff_note IS NULL THEN findings.diff_note
            ELSE excluded.diff_note
          END,
          last_job_id = COALESCE(excluded.last_job_id, findings.last_job_id),
          updated_at = excluded.updated_at`,
      )
      .run(
        input.repoFullName,
        input.prNumber,
        scope.provider,
        scope.instance,
        input.fingerprint,
        input.status,
        input.reviewedSha,
        input.currentSha ?? null,
        input.githubThreadId ?? null,
        input.githubCommentId ?? null,
        input.originalPath ?? null,
        input.originalLine ?? null,
        input.currentPath ?? null,
        input.currentLine ?? null,
        input.category ?? null,
        input.summary,
        input.body ?? null,
        input.severity ?? null,
        input.confidence ?? null,
        input.dismissedBy ?? null,
        input.dismissedAt ?? null,
        input.dismissCommand ?? null,
        input.reopenedBy ?? null,
        input.reopenedAt ?? null,
        input.reopenCommand ?? null,
        input.reconciliationConfidence ?? null,
        input.reconciliationReason ?? null,
        input.diffHunk ?? null,
        input.diffNote ?? null,
        input.lastJobId ?? null,
        now,
        now,
      );
    const row = this.getFinding(input.repoFullName, input.prNumber, input.fingerprint, scope);
    if (!row) throw new Error("failed to upsert finding");
    return row;
  }

  dismissFinding(input: {
    repoFullName: string;
    prNumber: number;
    fingerprint: string;
    scope?: Partial<ForgeScope>;
    actor: string;
    command: string;
    reviewedSha: string;
    githubThreadId?: string | null;
    githubCommentId?: string | null;
    summary: string;
    path?: string | null;
    line?: number | null;
    category?: string | null;
    severity?: string | null;
    body?: string | null;
  }): { finding: FindingRow; changed: boolean } {
    const scope = normalizeScope(input.scope);
    const existing = this.getFinding(input.repoFullName, input.prNumber, input.fingerprint, scope);
    if (existing?.status === "dismissed") {
      return { finding: existing, changed: false };
    }
    const finding = this.upsertFinding({
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
      fingerprint: input.fingerprint,
      scope,
      status: "dismissed",
      reviewedSha: existing?.reviewed_sha ?? input.reviewedSha,
      currentSha: input.reviewedSha,
      githubThreadId: input.githubThreadId ?? existing?.github_thread_id,
      githubCommentId: input.githubCommentId ?? existing?.github_comment_id,
      originalPath: existing?.original_path ?? input.path,
      originalLine: existing?.original_line ?? input.line,
      currentPath: input.path ?? existing?.current_path,
      currentLine: input.line ?? existing?.current_line,
      category: input.category ?? existing?.category,
      summary: existing?.summary || input.summary,
      body: input.body ?? existing?.body,
      severity: input.severity ?? existing?.severity,
      dismissedBy: input.actor,
      dismissedAt: nowIso(),
      dismissCommand: input.command,
    });
    return { finding, changed: true };
  }

  reopenFinding(input: {
    repoFullName: string;
    prNumber: number;
    fingerprint: string;
    scope?: Partial<ForgeScope>;
    actor: string;
    command: string;
    reviewedSha: string;
    githubThreadId?: string | null;
    githubCommentId?: string | null;
    summary: string;
  }): { finding: FindingRow; changed: boolean } {
    const scope = normalizeScope(input.scope);
    const existing = this.getFinding(input.repoFullName, input.prNumber, input.fingerprint, scope);
    if (existing && existing.status !== "dismissed") {
      return { finding: existing, changed: false };
    }
    const finding = this.upsertFinding({
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
      fingerprint: input.fingerprint,
      scope,
      status: "open",
      reviewedSha: existing?.reviewed_sha ?? input.reviewedSha,
      currentSha: input.reviewedSha,
      githubThreadId: input.githubThreadId ?? existing?.github_thread_id,
      githubCommentId: input.githubCommentId ?? existing?.github_comment_id,
      originalPath: existing?.original_path,
      originalLine: existing?.original_line,
      currentPath: existing?.current_path,
      currentLine: existing?.current_line,
      category: existing?.category,
      summary: existing?.summary || input.summary,
      body: existing?.body,
      severity: existing?.severity,
      dismissedBy: null,
      dismissedAt: null,
      dismissCommand: null,
      reopenedBy: input.actor,
      reopenedAt: nowIso(),
      reopenCommand: input.command,
    });
    return { finding, changed: true };
  }

  claimWebhookDelivery(
    deliveryId: string,
    event: string,
    result: string,
    scope?: Partial<ForgeScope>,
    context?: WebhookDeliveryContext,
  ): boolean {
    if (!deliveryId) return true;
    const resolved = normalizeScope(scope);
    const insert = this.db
      .prepare(
        `INSERT OR IGNORE INTO webhook_deliveries (delivery_id, event, result, created_at, provider, provider_instance, repo_full_name, action, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        deliveryId,
        event,
        result,
        nowIso(),
        resolved.provider,
        resolved.instance,
        context?.repoFullName ?? null,
        context?.action ?? null,
        context?.actor ?? null,
      );
    if (insert.changes === 0) {
      // The row exists: a previously ignored delivery that a redelivery now
      // handled (rate-limit window passed, job landed, …) takes the real
      // outcome; a redelivery still ignored keeps the first reason. Context
      // columns only backfill — never overwrite a claim's own result or
      // context.
      this.db
        .prepare(
          `UPDATE webhook_deliveries SET
            result = CASE WHEN result LIKE 'ignored:%' AND ? NOT LIKE 'ignored:%' THEN ? ELSE result END,
            repo_full_name = COALESCE(repo_full_name, ?),
            action = COALESCE(action, ?),
            actor = COALESCE(actor, ?)
          WHERE provider = ? AND provider_instance = ? AND delivery_id = ?`,
        )
        .run(
          result,
          result,
          context?.repoFullName ?? null,
          context?.action ?? null,
          context?.actor ?? null,
          resolved.provider,
          resolved.instance,
          deliveryId,
        );
    }
    return insert.changes > 0;
  }

  /** Newest-first delivery log for the /config/deliveries page. `before` is a
   * keyset cursor on rowid (insertion order == chronological order). */
  listWebhookDeliveries(options: { limit?: number; before?: number } = {}): WebhookDeliveryRow[] {
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 100), 500));
    if (options.before != null) {
      return this.db
        .prepare(
          `SELECT rowid, provider, provider_instance, delivery_id, event, action, repo_full_name, actor, result, created_at
           FROM webhook_deliveries WHERE rowid < ? ORDER BY rowid DESC LIMIT ?`,
        )
        .all(options.before, limit) as WebhookDeliveryRow[];
    }
    return this.db
      .prepare(
        `SELECT rowid, provider, provider_instance, delivery_id, event, action, repo_full_name, actor, result, created_at
         FROM webhook_deliveries ORDER BY rowid DESC LIMIT ?`,
      )
      .all(limit) as WebhookDeliveryRow[];
  }

  /** Delivery dedup gate. `ignored:` rows are observational only — they do
   * NOT dedup, so a redelivery of a transiently ignored event (rate limited,
   * escalated before any job existed) still reprocesses, restoring the
   * pre-logging retry behavior. Handled results (enqueued, commands, …) gate
   * redeliveries to `duplicate` as before. */
  hasWebhookDelivery(deliveryId: string, scope?: Partial<ForgeScope>): boolean {
    if (!deliveryId) return false;
    const resolved = normalizeScope(scope);
    const row = this.db
      .prepare(
        `SELECT delivery_id FROM webhook_deliveries WHERE provider = ? AND provider_instance = ? AND delivery_id = ? AND result NOT LIKE 'ignored:%'`,
      )
      .get(resolved.provider, resolved.instance, deliveryId) as { delivery_id: string } | undefined;
    return Boolean(row);
  }

  claimReviewCommand(
    commentId: string,
    deliveryId: string,
    command: string,
    result: string,
    scope?: Partial<ForgeScope>,
  ): boolean {
    const resolved = normalizeScope(scope);
    const insert = this.db
      .prepare(
        `INSERT OR IGNORE INTO processed_review_commands (comment_id, delivery_id, command, result, created_at, provider, provider_instance)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(commentId, deliveryId, command, result, nowIso(), resolved.provider, resolved.instance);
    return insert.changes > 0;
  }

  hasReviewCommand(commentId: string, scope?: Partial<ForgeScope>): boolean {
    const resolved = normalizeScope(scope);
    const row = this.db
      .prepare(
        `SELECT comment_id FROM processed_review_commands WHERE provider = ? AND provider_instance = ? AND comment_id = ?`,
      )
      .get(resolved.provider, resolved.instance, commentId) as { comment_id: string } | undefined;
    return Boolean(row);
  }
}

function skipReason(existing: JobRow): string | undefined {
  if (existing.github_review_id) return "already published for this SHA";
  if (TERMINAL_SKIP_REQUEUE.includes(existing.state) && existing.state !== "failed") {
    return `job already ${existing.state} for this SHA`;
  }
  if (existing.state === "failed") return "failed job exists for this SHA; not auto-retried";
  if (existing.state === "stale") return "job already marked stale";
  if (existing.state === "cancelled") return "job cancelled";
  return "duplicate";
}
