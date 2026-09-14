import type { Config } from "../config.js";
import type { JobStore, JobRow, ReviewerRunRow } from "./store.js";
import type { GithubPort } from "../github/client.js";
import { buildReviewBody, findExistingReview, toInlineComments } from "../github/client.js";
import type { CheckoutPort } from "../checkout.js";
import type { OpenCodePort, OpenCodeRunResult } from "../opencode/parse.js";
import { buildAggregatorPrompt, buildReviewerPrompt } from "../prompts.js";
import {
  fallbackAggregator,
  parseAggregatorResult,
  parseReviewerResult,
  SchemaValidationError,
  type AggregatorResult,
  type ReviewerResult,
} from "../schema.js";
import { mapLimit, nowIso, sleep, truncate } from "../util.js";
import { ZodError } from "zod";

export interface PipelineDeps {
  config: Config;
  store: JobStore;
  github: GithubPort;
  checkout: CheckoutPort;
  opencode: OpenCodePort;
  getInstallationToken?: (installationId: number) => Promise<string>;
}

const aborts = new Map<number, AbortController>();

export function abortJob(jobId: number): void {
  aborts.get(jobId)?.abort();
}

export function createPipeline(deps: PipelineDeps) {
  return {
    abortJob,
    async run(jobId: number): Promise<void> {
      const existing = aborts.get(jobId);
      if (existing) existing.abort();
      const controller = new AbortController();
      aborts.set(jobId, controller);
      try {
        await runJob(deps, jobId, controller.signal);
      } finally {
        if (aborts.get(jobId) === controller) aborts.delete(jobId);
      }
    },
  };
}

async function runJob(deps: PipelineDeps, jobId: number, signal: AbortSignal): Promise<void> {
  const { store, config } = deps;
  const job = store.getJob(jobId);
  if (!job) return;
  if (["completed", "stale", "cancelled"].includes(job.state)) return;

  try {
    store.setJobState(jobId, "preparing", { started_at: nowIso() });
    store.log(jobId, `Preparing isolated workspace for ${job.repo_full_name}#${job.pr_number} @ ${job.head_sha}`);
    throwIfStale(store, jobId, signal);

    const token = deps.getInstallationToken
      ? await deps.getInstallationToken(job.installation_id)
      : await deps.github.getInstallationToken(job.installation_id);
    const workspace = await deps.checkout.prepare({
      jobId,
      installationId: job.installation_id,
      owner: job.repo_owner,
      repo: job.repo_name,
      prNumber: job.pr_number,
      baseSha: job.base_sha,
      headSha: job.head_sha,
      token,
      secrets: token ? [token, ...githubKeySecrets(config)] : githubKeySecrets(config),
      signal,
      fetchDiff: () => deps.github.getPullDiff(job.installation_id, job.repo_owner, job.repo_name, job.pr_number),
      metadata: {
        repo: job.repo_full_name,
        pr: job.pr_number,
        title: job.pr_title,
        baseSha: job.base_sha,
        headSha: job.head_sha,
      },
    });
    store.patchJob(jobId, { workspace_path: workspace.dir });
    store.log(jobId, `Checked out ${job.head_sha} into ${workspace.dir}`);
    throwIfStale(store, jobId, signal);

    store.setJobState(jobId, "reviewing");
    const runs = store.listReviewerRuns(jobId);
    await mapLimit(runs, config.opencode.reviewerConcurrency, async (run) => {
      throwIfStale(store, jobId, signal);
      await runReviewer(deps, job, run, workspace.repoDir, [workspace.diffPath, workspace.metaPath], signal);
    });
    throwIfStale(store, jobId, signal);

    const completedRuns = store.listReviewerRuns(jobId);
    const parsedReviewers: ReviewerResult[] = [];
    for (const run of completedRuns) {
      if (run.state === "done" && run.normalized_json) {
        parsedReviewers.push(JSON.parse(run.normalized_json) as ReviewerResult);
      }
    }
    if (parsedReviewers.length === 0) {
      throw new Error("all specialist reviewers failed or produced invalid JSON");
    }

    store.setJobState(jobId, "aggregating", {
      aggregator_state: "running",
      aggregator_started_at: nowIso(),
      aggregator_model: config.opencode.aggregatorModel || config.opencode.reviewerModel || null,
    });
    store.log(jobId, `Aggregating ${parsedReviewers.length} reviewer result(s)`);
    const aggregated = await runAggregator(deps, job, parsedReviewers, workspace.repoDir, [workspace.diffPath], signal);
    throwIfStale(store, jobId, signal);

    store.setJobState(jobId, "publishing", { aggregator_state: "done" });
    const posted = await publishReview(deps, job, aggregated, parsedReviewers.length);
    store.setJobState(jobId, "completed", {
      github_review_id: posted?.id ?? null,
      github_review_url: posted?.url ?? null,
      finished_at: nowIso(),
    });
    store.log(jobId, posted ? `Published COMMENT review ${posted.id}` : "No GitHub review posted");
  } catch (error) {
    if (store.isStale(jobId) || signal.aborted) {
      store.log(jobId, "Job aborted or marked stale; skipping publish", "warn");
      if (!store.isStale(jobId)) store.setJobState(jobId, "stale", { finished_at: nowIso() });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    for (const run of store.listReviewerRuns(jobId)) {
      if (run.state === "queued" || run.state === "running") {
        store.patchReviewer(run.id, {
          state: "failed",
          validation_error: "job ended before this reviewer finished",
          finished_at: nowIso(),
        });
      }
    }
    store.setJobState(jobId, "failed", {
      failure_reason: message,
      finished_at: nowIso(),
      aggregator_state: store.getJob(jobId)?.aggregator_state === "done" ? "done" : "failed",
    });
    store.log(jobId, `Job failed: ${message}`, "error");
  }
}

function githubKeySecrets(config: Config): string[] {
  return [config.github.privateKey, config.github.webhookSecret].filter((value) => value.length > 4);
}

function throwIfStale(store: JobStore, jobId: number, signal: AbortSignal): void {
  if (signal.aborted || store.isStale(jobId)) {
    throw new Error("stale");
  }
}

async function runReviewer(
  deps: PipelineDeps,
  job: JobRow,
  run: ReviewerRunRow,
  cwd: string,
  files: string[],
  signal: AbortSignal,
): Promise<void> {
  const role = deps.config.reviewers.find((item) => item.id === run.role);
  const model = role?.model || deps.config.opencode.reviewerModel;
  const retries = Math.max(0, deps.config.opencode.maxRetries);
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    throwIfStale(deps.store, job.id, signal);
    const started = Date.now();
    deps.store.patchReviewer(run.id, {
      state: "running",
      attempt,
      model: model || null,
      provider: model.includes("/") ? model.split("/")[0] : null,
      started_at: nowIso(),
    });
    deps.store.log(job.id, `Reviewer ${run.role} attempt ${attempt}/${retries + 1} model=${model || "(default)"}`, "info", run.id);

    let result: OpenCodeRunResult | undefined;
    try {
      const prompt = buildReviewerPrompt({
        role: role ?? { id: run.role, title: run.title, prompt: `Review as ${run.role}` },
        repoFullName: job.repo_full_name,
        prNumber: job.pr_number,
        prTitle: job.pr_title,
        prBody: job.pr_body,
        baseSha: job.base_sha,
        headSha: job.head_sha,
        author: job.pr_author,
      });
      result = await deps.opencode.run({
        cwd,
        model,
        prompt,
        files,
        timeoutMs: deps.config.opencode.timeoutMs,
        extraArgs: deps.config.opencode.extraArgs,
        bin: deps.config.opencode.bin,
        title: `maomao-${run.role}-${job.id}`,
        signal,
        onStdout: (chunk) => {
          if (chunk.includes("error")) deps.store.log(job.id, chunk.slice(0, 500), "debug", run.id);
        },
      });
      const parsed = parseReviewerResult(result.text || result.stdout, run.role);
      deps.store.patchReviewer(run.id, {
        state: "done",
        raw_output: truncate(result.text || result.stdout, 200_000),
        normalized_json: JSON.stringify(parsed, null, 2),
        stdout: truncate(result.stdout, 80_000),
        stderr: truncate(result.stderr, 20_000),
        exit_code: result.exitCode,
        finished_at: nowIso(),
        duration_ms: Date.now() - started,
        prompt_tokens: result.usage.promptTokens ?? null,
        completion_tokens: result.usage.completionTokens ?? null,
        cost: result.usage.cost ?? null,
        validation_error: null,
      });
      deps.store.log(
        job.id,
        `Reviewer ${run.role} done: verdict=${parsed.verdict} findings=${parsed.findings.length}`,
        "info",
        run.id,
      );
      return;
    } catch (error) {
      lastError = formatError(error);
      const cliDump = result ? truncate(result.stderr.trim() || result.stdout.trim(), 500) : "";
      deps.store.patchReviewer(run.id, {
        state: "failed",
        validation_error: lastError,
        raw_output: result ? truncate(result.text || result.stdout, 200_000) : null,
        stdout: result ? truncate(result.stdout, 80_000) : null,
        stderr: result ? truncate(result.stderr, 20_000) : null,
        exit_code: result?.exitCode ?? null,
        finished_at: nowIso(),
        duration_ms: Date.now() - started,
      });
      deps.store.log(
        job.id,
        `Reviewer ${run.role} attempt ${attempt} failed: ${lastError}${cliDump ? ` — ${cliDump}` : ""}`,
        "warn",
        run.id,
      );
      if (attempt <= retries) await sleep(500 * attempt, signal);
    }
  }
}

async function runAggregator(
  deps: PipelineDeps,
  job: JobRow,
  reviewers: ReviewerResult[],
  cwd: string,
  files: string[],
  signal: AbortSignal,
): Promise<AggregatorResult> {
  const model = deps.config.opencode.aggregatorModel || deps.config.opencode.reviewerModel;
  const started = Date.now();
  try {
    const result = await deps.opencode.run({
      cwd,
      model,
      prompt: buildAggregatorPrompt({
        repoFullName: job.repo_full_name,
        prNumber: job.pr_number,
        prTitle: job.pr_title,
        baseSha: job.base_sha,
        headSha: job.head_sha,
        reviewerEvidence: reviewers,
      }),
      files,
      timeoutMs: deps.config.opencode.timeoutMs,
      extraArgs: deps.config.opencode.extraArgs,
      bin: deps.config.opencode.bin,
      title: `maomao-aggregator-${job.id}`,
      signal,
    });
    const parsed = parseAggregatorResult(result.text || result.stdout);
    deps.store.patchJob(job.id, {
      aggregator_raw: truncate(result.text || result.stdout, 200_000),
      aggregator_normalized: JSON.stringify(parsed, null, 2),
      aggregator_model: model || null,
      aggregator_provider: model.includes("/") ? model.split("/")[0] : null,
      aggregator_state: "done",
      aggregator_finished_at: nowIso(),
      aggregator_duration_ms: Date.now() - started,
      aggregator_prompt_tokens: result.usage.promptTokens ?? null,
      aggregator_completion_tokens: result.usage.completionTokens ?? null,
      aggregator_cost: result.usage.cost ?? null,
    });
    return parsed;
  } catch (error) {
    const fallback = fallbackAggregator(reviewers);
    const message = formatError(error);
    deps.store.log(job.id, `Aggregator OpenCode run failed (${message}); using deterministic fallback`, "warn");
    deps.store.patchJob(job.id, {
      aggregator_raw: message,
      aggregator_normalized: JSON.stringify(fallback, null, 2),
      aggregator_model: model || null,
      aggregator_state: "done",
      aggregator_finished_at: nowIso(),
      aggregator_duration_ms: Date.now() - started,
    });
    return fallback;
  }
}

async function publishReview(
  deps: PipelineDeps,
  job: JobRow,
  aggregated: AggregatorResult,
  reviewerCount: number,
): Promise<{ id: string; url: string } | undefined> {
  if (deps.store.isStale(job.id)) return undefined;

  const existing = await deps.github.listReviews(job.installation_id, job.repo_owner, job.repo_name, job.pr_number);
  const already = findExistingReview(existing, job.head_sha);
  if (already) {
    deps.store.log(job.id, `Review already exists for ${job.head_sha}; skipping publish`);
    return already;
  }

  const findingsCount = aggregated.findings.length;
  if (findingsCount === 0 && aggregated.verdict === "clean" && !deps.config.postEmptyReview) {
    deps.store.log(job.id, "Clean review with no findings; POST_EMPTY_REVIEW is false, not posting");
    return undefined;
  }

  const body = buildReviewBody({
    headSha: job.head_sha,
    summary: aggregated.summary,
    findingsCount,
    reviewerCount,
  });
  const comments = toInlineComments(aggregated.findings, deps.config.maxInlineComments);
  return deps.github.createCommentReview({
    installationId: job.installation_id,
    owner: job.repo_owner,
    repo: job.repo_name,
    pullNumber: job.pr_number,
    commitId: job.head_sha,
    body,
    comments,
  });
}

function formatError(error: unknown): string {
  if (error instanceof SchemaValidationError) return `${error.message}: ${error.issues}`;
  if (error instanceof ZodError) return `schema invalid: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
