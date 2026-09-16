import type { SqliteDb } from "../db.js";
import type { JobState, ReviewerState } from "../config.js";
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
  profile_revision_id: number | null;
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

export interface NewJobInput {
  repoFullName: string;
  repoOwner: string;
  repoName: string;
  installationId: number;
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
}

export interface EnqueueResult {
  job: JobRow;
  created: boolean;
  skippedReason?: string;
  staleJobIds: number[];
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

const ACTIVE_JOB_STATES: JobState[] = [
  "queued",
  "preparing",
  "reconciling",
  "routing",
  "reviewing",
  "aggregating",
  "sniffing",
  "publishing",
];

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
  "escalation_id",
  "poison_alert_policy",
  "manual_escalate_requested",
  "reconciliation_json",
  "risk_profile",
  "risk_reason",
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

    const result = this.db.transaction(() => {
      const stale = this.db
        .prepare(
          `UPDATE jobs
           SET state = 'stale', updated_at = ?, finished_at = COALESCE(finished_at, ?)
           WHERE repo_full_name = ? AND pr_number = ? AND head_sha != ?
             AND state NOT IN ('stale', 'cancelled')
           RETURNING id`,
        )
        .all(createdAt, createdAt, input.repoFullName, input.prNumber, input.headSha) as { id: number }[];
      staleJobIds.push(...stale.map((row) => row.id));

      const existing = this.db
        .prepare(`SELECT * FROM jobs WHERE repo_full_name = ? AND pr_number = ? AND head_sha = ?`)
        .get(input.repoFullName, input.prNumber, input.headSha) as JobRow | undefined;

      if (existing) {
        const skippedReason = skipReason(existing);
        return { job: existing, created: false, skippedReason, staleJobIds };
      }

      const insert = this.db
        .prepare(
          `INSERT INTO jobs (
            repo_full_name, repo_owner, repo_name, installation_id, github_account_id, github_repository_id, pr_number,
            pr_title, pr_body, pr_html_url, pr_author, base_sha, head_sha, base_ref, head_ref,
            webhook_delivery_id, webhook_event, profile_revision_id, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          input.repoFullName,
          input.repoOwner,
          input.repoName,
          input.installationId,
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
          input.profileRevisionId ?? this.configs.getActiveRevision("default")?.id ?? null,
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

  getJob(id: number): JobRow | undefined {
    return this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
  }

  listJobs(limit = 50): JobRow[] {
    return this.db.prepare(`SELECT * FROM jobs ORDER BY id DESC LIMIT ?`).all(limit) as JobRow[];
  }

  listInterruptedJobs(): JobRow[] {
    // Derive the IN-list from ACTIVE_JOB_STATES so a new job state cannot drift out of crash recovery.
    const states = ACTIVE_JOB_STATES.map((state) => `'${state}'`).join(", ");
    return this.db
      .prepare(`SELECT * FROM jobs WHERE state IN (${states})`)
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
    if (job.state === "stale" && state !== "stale") return;
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

  resetInterrupted(id: number): void {
    const updatedAt = nowIso();
    const states = [...ACTIVE_JOB_STATES.map((state) => `'${state}'`)].join(", ");
    this.db
      .prepare(
        `UPDATE jobs SET state = 'queued', failure_reason = NULL, started_at = NULL, finished_at = NULL,
         aggregator_state = 'queued', aggregator_started_at = NULL, aggregator_finished_at = NULL, updated_at = ?
         WHERE id = ? AND state IN (${states})`,
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

  findLatestJobForPull(repoFullName: string, prNumber: number, headSha?: string): JobRow | undefined {
    if (headSha) {
      return this.db
        .prepare(`SELECT * FROM jobs WHERE repo_full_name = ? AND pr_number = ? AND head_sha = ?`)
        .get(repoFullName, prNumber, headSha) as JobRow | undefined;
    }
    return this.db
      .prepare(`SELECT * FROM jobs WHERE repo_full_name = ? AND pr_number = ? ORDER BY id DESC LIMIT 1`)
      .get(repoFullName, prNumber) as JobRow | undefined;
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

  listFindings(repoFullName: string, prNumber: number): FindingRow[] {
    return this.db
      .prepare(`SELECT * FROM findings WHERE repo_full_name = ? AND pr_number = ? ORDER BY id ASC`)
      .all(repoFullName, prNumber) as FindingRow[];
  }

  getFinding(repoFullName: string, prNumber: number, fingerprint: string): FindingRow | undefined {
    return this.db
      .prepare(`SELECT * FROM findings WHERE repo_full_name = ? AND pr_number = ? AND fingerprint = ?`)
      .get(repoFullName, prNumber, fingerprint) as FindingRow | undefined;
  }

  getFindingByThreadId(threadId: string): FindingRow | undefined {
    return this.db.prepare(`SELECT * FROM findings WHERE github_thread_id = ?`).get(threadId) as FindingRow | undefined;
  }

  getFindingByCommentId(commentId: string): FindingRow | undefined {
    return this.db.prepare(`SELECT * FROM findings WHERE github_comment_id = ?`).get(commentId) as
      | FindingRow
      | undefined;
  }

  upsertFinding(input: {
    repoFullName: string;
    prNumber: number;
    fingerprint: string;
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
    const existing = this.getFinding(input.repoFullName, input.prNumber, input.fingerprint);
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
          repo_full_name, pr_number, fingerprint, status, reviewed_sha, current_sha,
          github_thread_id, github_comment_id, original_path, original_line, current_path, current_line,
          category, summary, body, severity, confidence,
          dismissed_by, dismissed_at, dismiss_command, reopened_by, reopened_at, reopen_command,
          reconciliation_confidence, reconciliation_reason, diff_hunk, diff_note, last_job_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo_full_name, pr_number, fingerprint) DO UPDATE SET
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
    const row = this.getFinding(input.repoFullName, input.prNumber, input.fingerprint);
    if (!row) throw new Error("failed to upsert finding");
    return row;
  }

  dismissFinding(input: {
    repoFullName: string;
    prNumber: number;
    fingerprint: string;
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
    const existing = this.getFinding(input.repoFullName, input.prNumber, input.fingerprint);
    if (existing?.status === "dismissed") {
      return { finding: existing, changed: false };
    }
    const finding = this.upsertFinding({
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
      fingerprint: input.fingerprint,
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
    actor: string;
    command: string;
    reviewedSha: string;
    githubThreadId?: string | null;
    githubCommentId?: string | null;
    summary: string;
  }): { finding: FindingRow; changed: boolean } {
    const existing = this.getFinding(input.repoFullName, input.prNumber, input.fingerprint);
    if (existing && existing.status !== "dismissed") {
      return { finding: existing, changed: false };
    }
    const finding = this.upsertFinding({
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
      fingerprint: input.fingerprint,
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

  claimWebhookDelivery(deliveryId: string, event: string, result: string): boolean {
    if (!deliveryId) return true;
    const insert = this.db
      .prepare(`INSERT OR IGNORE INTO webhook_deliveries (delivery_id, event, result, created_at) VALUES (?, ?, ?, ?)`)
      .run(deliveryId, event, result, nowIso());
    return insert.changes > 0;
  }

  hasWebhookDelivery(deliveryId: string): boolean {
    if (!deliveryId) return false;
    const row = this.db.prepare(`SELECT delivery_id FROM webhook_deliveries WHERE delivery_id = ?`).get(deliveryId) as
      | { delivery_id: string }
      | undefined;
    return Boolean(row);
  }

  claimReviewCommand(commentId: string, deliveryId: string, command: string, result: string): boolean {
    const insert = this.db
      .prepare(
        `INSERT OR IGNORE INTO processed_review_commands (comment_id, delivery_id, command, result, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(commentId, deliveryId, command, result, nowIso());
    return insert.changes > 0;
  }

  hasReviewCommand(commentId: string): boolean {
    const row = this.db
      .prepare(`SELECT comment_id FROM processed_review_commands WHERE comment_id = ?`)
      .get(commentId) as { comment_id: string } | undefined;
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
