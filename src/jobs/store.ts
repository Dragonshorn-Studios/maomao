import type { SqliteDb } from "../db.js";
import type { JobState, ReviewerState } from "../config.js";
import { nowIso } from "../util.js";
import { publish } from "../events.js";

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
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
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

const TERMINAL_SKIP_REQUEUE: JobState[] = ["completed", "publishing", "queued", "preparing", "reviewing", "aggregating"];

export class JobStore {
  constructor(private readonly db: SqliteDb) {}

  enqueue(input: NewJobInput): EnqueueResult {
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
            webhook_delivery_id, webhook_event, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
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
    return this.db
      .prepare(
        `SELECT * FROM jobs WHERE state IN ('queued', 'preparing', 'reviewing', 'aggregating', 'publishing')`,
      )
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
    this.db
      .prepare(
        `UPDATE jobs SET
          state = ?,
          failure_reason = COALESCE(?, failure_reason),
          workspace_path = COALESCE(?, workspace_path),
          github_review_id = COALESCE(?, github_review_id),
          github_review_url = COALESCE(?, github_review_url),
          aggregator_raw = COALESCE(?, aggregator_raw),
          aggregator_normalized = COALESCE(?, aggregator_normalized),
          aggregator_model = COALESCE(?, aggregator_model),
          aggregator_provider = COALESCE(?, aggregator_provider),
          aggregator_state = COALESCE(?, aggregator_state),
          aggregator_started_at = COALESCE(?, aggregator_started_at),
          aggregator_finished_at = COALESCE(?, aggregator_finished_at),
          aggregator_duration_ms = COALESCE(?, aggregator_duration_ms),
          aggregator_prompt_tokens = COALESCE(?, aggregator_prompt_tokens),
          aggregator_completion_tokens = COALESCE(?, aggregator_completion_tokens),
          aggregator_cost = COALESCE(?, aggregator_cost),
          started_at = ?,
          finished_at = ?,
          updated_at = ?
         WHERE id = ?`,
      )
      .run(
        state,
        extra.failure_reason ?? null,
        extra.workspace_path ?? null,
        extra.github_review_id ?? null,
        extra.github_review_url ?? null,
        extra.aggregator_raw ?? null,
        extra.aggregator_normalized ?? null,
        extra.aggregator_model ?? null,
        extra.aggregator_provider ?? null,
        extra.aggregator_state ?? null,
        extra.aggregator_started_at ?? null,
        extra.aggregator_finished_at ?? null,
        extra.aggregator_duration_ms ?? null,
        extra.aggregator_prompt_tokens ?? null,
        extra.aggregator_completion_tokens ?? null,
        extra.aggregator_cost ?? null,
        startedAt,
        finishedAt,
        updatedAt,
        id,
      );
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
    this.db
      .prepare(
        `UPDATE jobs SET state = 'queued', failure_reason = NULL, started_at = NULL, finished_at = NULL,
         aggregator_state = 'queued', aggregator_started_at = NULL, aggregator_finished_at = NULL, updated_at = ?
         WHERE id = ? AND state IN ('preparing', 'reviewing', 'aggregating', 'publishing', 'queued')`,
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
    if (["queued", "preparing", "reviewing", "aggregating", "publishing"].includes(job.state)) {
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
           prompt_tokens = NULL, completion_tokens = NULL, cost = NULL
         WHERE id = ?`,
      );
      for (const run of targets) reset.run(run.id);
      this.db
        .prepare(
          `UPDATE jobs SET
             state = 'queued', failure_reason = NULL, started_at = NULL, finished_at = NULL,
             aggregator_state = 'queued', aggregator_started_at = NULL, aggregator_finished_at = NULL,
             aggregator_raw = NULL, aggregator_normalized = NULL, aggregator_duration_ms = NULL,
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
