import type { Config } from "../config.js";
import type { JobStore, JobRow, ReviewerRunRow } from "./store.js";
import type { GithubPort } from "../github/client.js";
import { buildReviewBody, findExistingReview, toInlineComments, inlineCommentFingerprints } from "../github/client.js";
import type { CheckoutPort } from "../checkout.js";
import {
  aggregatorUsagePersistence,
  usagePersistence,
  type OpenCodePort,
  type OpenCodeRunResult,
} from "../opencode/parse.js";
import { buildAggregatorPrompt, buildReviewerPrompt } from "../prompts.js";
import { reviewerSpecs } from "./enqueue.js";
import {
  fallbackAggregator,
  parseAggregatorResult,
  parseReviewerResult,
  SchemaValidationError,
  extractJsonFromText,
  type AggregatorResult,
  type ReviewerResult,
} from "../schema.js";
import { classifyPriorFindings, collectPriorFindings, findingsForPublish } from "../findings/reconcile.js";
import { applyReconciliationThreads, persistClassifications, persistThreadsAsFindings } from "../findings/apply.js";
import type { ReconciliationSnapshot } from "../findings/types.js";
import { currentFindingsForRisk } from "../findings/types.js";
import { mapLimit, nowIso, sleep, truncate } from "../util.js";
import { ZodError } from "zod";
import { authorizationLogLine, authorizeGithubTarget, logAuthorizationRejection } from "../github/authorize.js";
import { scanRoutingSignals, relevantDiffHunks } from "../routing/signals.js";
import {
  diagnosisFallback,
  deterministicDecision,
  mergeModelDecision,
} from "../routing/select.js";
import { parseRouterResult } from "../routing/parse.js";
import { buildInternalEscalationPrompt, buildRouterPrompt } from "../routing/prompts.js";
import { internalEscalationResultSchema } from "../routing/schema.js";
import type { RoutingDecision } from "../routing/types.js";
import {
  deliverSignedWebhook,
  escalationId,
  escalationMarker,
  parseEscalationMarker,
  resolveMention,
  sanitizePublicReason,
  targetKey,
} from "../routing/escalation.js";
import {
  assignFindingIds,
  findingsMeetThreshold,
  mergeInternalEscalation,
  shouldRunExternal,
  shouldRunInternal,
  usageOverBudget,
} from "../routing/policy.js";

export interface PipelineDeps {
  config: Config;
  store: JobStore;
  github: GithubPort;
  checkout: CheckoutPort;
  opencode: OpenCodePort;
  getInstallationToken?: (installationId: number) => Promise<string>;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
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
    async dispatchExternal(jobId: number): Promise<void> {
      const job = deps.store.getJob(jobId);
      if (!job) return;
      await dispatchExternalEscalation(deps, job, undefined);
    },
  };
}

async function runJob(deps: PipelineDeps, jobId: number, signal: AbortSignal): Promise<void> {
  const { store, config } = deps;
  const job = store.getJob(jobId);
  if (!job) return;
  if (["stale", "cancelled"].includes(job.state)) return;
  if (job.state === "completed") {
    if (job.manual_escalate_requested && jobHasPendingDispatch(store, job)) {
      await dispatchExternalEscalation(deps, job, undefined);
    }
    return;
  }

  const auth = authorizeGithubTarget(config, {
    installationId: job.installation_id,
    accountId: job.github_account_id ?? undefined,
    repositoryId: job.github_repository_id ?? undefined,
  });
  if (!auth.ok) {
    const subject = {
      installationId: job.installation_id,
      repositoryId: job.github_repository_id ?? undefined,
      reason: auth.reason,
    };
    logAuthorizationRejection(subject);
    store.log(jobId, authorizationLogLine(subject), "warn");
    for (const run of store.listReviewerRuns(jobId)) {
      if (run.state === "queued" || run.state === "running") {
        store.patchReviewer(run.id, {
          state: "failed",
          validation_error: `unauthorized: ${auth.reason}`,
          finished_at: nowIso(),
        });
      }
    }
    store.setJobState(jobId, "failed", {
      failure_reason: `unauthorized: ${auth.reason}`,
      finished_at: nowIso(),
    });
    return;
  }

  try {
    store.setJobState(jobId, "preparing", { started_at: nowIso() });
    store.log(jobId, `Preparing isolated workspace for ${job.repo_full_name}#${job.pr_number} @ ${job.head_sha}`);
    throwIfStale(store, jobId, signal);

    const token = deps.getInstallationToken
      ? await deps.getInstallationToken(job.installation_id)
      : await deps.github.getInstallationToken(job.installation_id);
    const diff = await deps.github.getPullDiff(
      job.installation_id,
      job.repo_owner,
      job.repo_name,
      job.pr_number,
      config.maxDiffBytes,
    );
    const diffBytes = Buffer.byteLength(diff, "utf8");
    if (config.maxDiffBytes > 0 && diffBytes > config.maxDiffBytes) {
      throw new Error(`diff exceeds MAX_DIFF_BYTES (${diffBytes} > ${config.maxDiffBytes})`);
    }
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
      fetchDiff: async () => diff,
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

    const snapshot = await reconcileAndRoute(deps, job, workspace.repoDir, workspace.dir, diff, signal);
    throwIfStale(store, jobId, signal);
    await routeSpecialists(deps, job, diff, workspace.repoDir, [workspace.diffPath, workspace.metaPath], signal);
    const routed = store.getJob(jobId);
    const currentFindings = currentFindingsForRisk(snapshot.items);
    store.patchJob(jobId, {
      risk_profile: routed?.routing_profile ?? null,
      risk_reason: routed?.routing_reason ?? null,
    });
    store.log(
      jobId,
      `Risk route: ${routed?.routing_profile ?? "diagnosis"} — ${routed?.routing_reason ?? ""}; current findings=${currentFindings.length} (resolved/dismissed excluded)`,
    );
    throwIfStale(store, jobId, signal);

    store.setJobState(jobId, "reviewing");
    const runs = store.listReviewerRuns(jobId).filter((run) => run.state !== "done");
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
    let aggregated = await runAggregator(deps, job, parsedReviewers, workspace.repoDir, [workspace.diffPath], signal);
    throwIfStale(store, jobId, signal);

    const afterReviewers = store.getJob(jobId);
    if (afterReviewers && shouldRunInternal(config.poisonAlert.policy, config.poisonAlert.internal.enabled, afterReviewers.routing_profile ?? "")) {
      aggregated = await runInternalEscalation(deps, afterReviewers, aggregated, diff, workspace.repoDir, signal);
      throwIfStale(store, jobId, signal);
    }

    aggregated = {
      ...aggregated,
      findings: assignFindingIds(aggregated.findings),
    };
    store.patchJob(jobId, { aggregator_normalized: JSON.stringify(aggregated, null, 2) });

    store.setJobState(jobId, "publishing", { aggregator_state: "done" });
    const posted = await publishReview(deps, job, aggregated, parsedReviewers.length, snapshot);
    const afterPublish = store.getJob(jobId) ?? job;
    if (posted) {
      store.patchJob(jobId, { github_review_id: posted.id, github_review_url: posted.url });
    }
    store.log(jobId, posted ? `Published COMMENT review ${posted.id}` : "No GitHub review posted");
    if (store.isStale(jobId)) {
      throw new Error("stale");
    }
    persistClassifications(store, job, snapshot.items);
    try {
      const threads = await deps.github.listReviewThreads(
        job.installation_id,
        job.repo_owner,
        job.repo_name,
        job.pr_number,
      );
      persistThreadsAsFindings({
        store,
        job,
        threads,
        publishedFingerprints: posted?.postedFingerprints ?? [],
      });
    } catch (error) {
      store.log(jobId, `Could not refresh finding thread ids: ${formatError(error)}`, "warn");
    }
    try {
      const applied = await applyReconciliationThreads({
        github: deps.github,
        job,
        snapshot,
        postedFingerprints: posted?.postedFingerprints ?? [],
      });
      if (applied.resolved.length > 0) {
        store.log(
          jobId,
          `Resolved ${applied.resolved.length} prior thread(s) after successful review (${applied.resolved.join(", ")})`,
        );
      }
    } catch (error) {
      store.log(jobId, `Thread resolve deferred: ${formatError(error)}`, "warn");
    }

    await dispatchExternalEscalation(deps, store.getJob(jobId) ?? afterPublish, aggregated);
    store.setJobState(jobId, "completed", {
      github_review_id: posted?.id ?? store.getJob(jobId)?.github_review_id ?? null,
      github_review_url: posted?.url ?? store.getJob(jobId)?.github_review_url ?? null,
      finished_at: nowIso(),
    });
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

function persistDecision(store: JobStore, jobId: number, decision: RoutingDecision, extra: Partial<JobRow> = {}): void {
  const reason = sanitizePublicReason(decision.reason, 300) || "router decision";
  store.patchJob(jobId, {
    ...extra,
    routing_state: "done",
    routing_profile: decision.profile,
    routing_reason: reason,
    routing_confidence: decision.confidence,
    routing_signals: JSON.stringify(decision.signals),
    routing_reviewers: JSON.stringify(decision.reviewers),
    routing_source: decision.source,
    routing_raw: decision.modelRaw ? truncate(decision.modelRaw, 20_000) : extra.routing_raw,
    risk_profile: decision.profile,
    risk_reason: reason,
  });
}

async function routeSpecialists(
  deps: PipelineDeps,
  job: JobRow,
  diff: string,
  cwd: string,
  files: string[],
  signal: AbortSignal,
): Promise<void> {
  const { store, config } = deps;
  const existing = store.listReviewerRuns(job.id);
  const allowlist = config.reviewers.map((role) => role.id);

  if (config.routing.mode === "fixed") {
    if (existing.length === 0) store.ensureReviewerRuns(job.id, reviewerSpecs(config));
    const roles = store.listReviewerRuns(job.id).map((run) => run.role);
    persistDecision(store, job.id, {
      profile: "diagnosis",
      reviewers: roles,
      reason: "Fixed reviewer set from configuration",
      confidence: 1,
      source: "fixed",
      signals: scanRoutingSignals({ diff, title: job.pr_title, body: job.pr_body }),
      hardRuleEscalated: false,
    }, { routing_mode: "fixed" });
    store.log(job.id, `Routing skipped (fixed): ${roles.join(", ") || "(none)"}`);
    return;
  }

  if (existing.length > 0 && job.routing_profile) {
    store.log(job.id, `Routing reused: profile=${job.routing_profile} reviewers=${existing.map((run) => run.role).join(", ")}`);
    return;
  }

  if (existing.length > 0) {
    const roles = existing.map((run) => run.role);
    persistDecision(store, job.id, {
      profile: "diagnosis",
      reviewers: roles,
      reason: "Preselected reviewer set for this job",
      confidence: 1,
      source: "fixed",
      signals: scanRoutingSignals({ diff, title: job.pr_title, body: job.pr_body }),
      hardRuleEscalated: false,
    }, { routing_mode: config.routing.mode });
    store.log(job.id, `Routing recorded preselected reviewers: ${roles.join(", ")}`);
    return;
  }

  store.setJobState(job.id, "routing", { routing_state: "running", routing_mode: config.routing.mode });
  const signals = scanRoutingSignals({ diff, title: job.pr_title, body: job.pr_body });
  let decision: RoutingDecision;
  const routerModel = config.routing.model || config.opencode.reviewerModel;
  const useModel = (config.routing.mode === "model" || config.routing.mode === "hybrid") && Boolean(routerModel);

  if (!useModel) {
    decision = deterministicDecision(signals, allowlist, config.routing);
  } else {
    const started = Date.now();
    try {
      const result = await deps.opencode.run({
        cwd,
        model: routerModel,
        prompt: buildRouterPrompt({
          allowedRoles: allowlist,
          signals,
          diff,
          maxDiffChars: config.routing.maxDiffChars,
          title: job.pr_title,
          body: job.pr_body,
        }),
        files,
        timeoutMs: config.routing.timeoutMs,
        extraArgs: config.opencode.extraArgs,
        bin: config.opencode.bin,
        title: `maomao-router-${job.id}`,
        signal,
      });
      const parsed = parseRouterResult(result.text || result.stdout);
      decision = mergeModelDecision(
        {
          profile: parsed.profile,
          reviewers: parsed.reviewers,
          reason: parsed.reason,
          confidence: parsed.confidence,
        },
        signals,
        allowlist,
        config.routing,
        result.text || result.stdout,
      );
      const usage = usagePersistence(result.usage);
      store.patchJob(job.id, {
        routing_model: routerModel,
        routing_provider: routerModel.includes("/") ? routerModel.split("/")[0] : null,
        routing_prompt_tokens: usage.prompt_tokens,
        routing_completion_tokens: usage.completion_tokens,
        routing_cost: usage.cost,
        routing_total_tokens: usage.total_tokens,
        routing_usage_complete: usage.usage_complete,
        routing_usage_warning: usage.usage_warning,
        routing_duration_ms: Date.now() - started,
        routing_raw: truncate(result.text || result.stdout, 20_000),
      });
    } catch (error) {
      const message = formatError(error);
      store.log(job.id, `Router model failed (${message}); falling back to diagnosis`, "warn");
      decision = diagnosisFallback(signals, allowlist, config.routing, `Router failed: ${message}`);
      store.patchJob(job.id, {
        routing_model: routerModel,
        routing_duration_ms: Date.now() - started,
        routing_usage_warning: message,
      });
    }
  }

  persistDecision(store, job.id, decision, { routing_mode: config.routing.mode });
  store.ensureReviewerRuns(job.id, reviewerSpecs(config, decision.reviewers));
  store.log(
    job.id,
    `Routed profile=${decision.profile} source=${decision.source} reviewers=${decision.reviewers.join(", ")} reason=${decision.reason}`,
  );
}

async function reconcileAndRoute(
  deps: PipelineDeps,
  job: JobRow,
  repoDir: string,
  workspaceDir: string,
  diff: string,
  signal: AbortSignal,
): Promise<ReconciliationSnapshot> {
  deps.store.setJobState(job.id, "reconciling");
  const threads = await deps.github.listReviewThreads(
    job.installation_id,
    job.repo_owner,
    job.repo_name,
    job.pr_number,
  );
  const stored = deps.store.listFindings(job.repo_full_name, job.pr_number);
  const priors = collectPriorFindings({ threads, stored });
  deps.store.log(
    job.id,
    `Reconciling ${priors.length} prior finding(s) for ${job.repo_full_name}#${job.pr_number} @ ${job.head_sha}`,
  );
  const items = await classifyPriorFindings({
    config: deps.config,
    opencode: deps.opencode,
    job,
    repoDir,
    diff,
    workspaceDir,
    priors,
    signal,
  });
  const snapshot: ReconciliationSnapshot = { headSha: job.head_sha, items };
  for (const item of items) {
    deps.store.log(
      job.id,
      `Finding ${item.fingerprint} classified ${item.status} (confidence=${item.confidence}): ${item.reason}`,
    );
  }
  deps.store.patchJob(job.id, {
    reconciliation_json: JSON.stringify(snapshot),
  });
  return snapshot;
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
        ...usagePersistence(result.usage),
        validation_error: null,
      });
      deps.store.log(
        job.id,
        `Reviewer ${run.role} done: verdict=${parsed.verdict} findings=${parsed.findings.length}`,
        "info",
        run.id,
      );
      if (result.usage.complete === false && result.usage.warning) {
        deps.store.log(job.id, result.usage.warning, "warn", run.id);
      }
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
        ...(result ? usagePersistence(result.usage) : {}),
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
      ...aggregatorUsagePersistence(result.usage),
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

async function runInternalEscalation(
  deps: PipelineDeps,
  job: JobRow,
  firstPass: AggregatorResult,
  diff: string,
  cwd: string,
  signal: AbortSignal,
): Promise<AggregatorResult> {
  const internal = deps.config.poisonAlert.internal;
  if (!internal.model) {
    deps.store.patchJob(job.id, {
      internal_escalation_state: "skipped",
      internal_escalation_reason: "POISON_ALERT_INTERNAL_MODEL is not configured",
    });
    deps.store.log(job.id, "Internal poison-alert pass skipped: no model configured", "warn");
    return firstPass;
  }

  const started = Date.now();
  deps.store.patchJob(job.id, {
    internal_escalation_state: "running",
    internal_escalation_model: internal.model,
    internal_escalation_provider: internal.model.includes("/") ? internal.model.split("/")[0] : null,
  });
  deps.store.log(job.id, `Internal poison-alert pass model=${internal.model}`);

  const files = assignFindingIds(firstPass.findings)
    .map((finding) => finding.file)
    .filter((file): file is string => Boolean(file));
  const hunks = relevantDiffHunks(diff, files, deps.config.routing.maxContextChars);
  const retries = Math.max(0, internal.retries);
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    throwIfStale(deps.store, job.id, signal);
    try {
      const result = await deps.opencode.run({
        cwd,
        model: internal.model,
        prompt: buildInternalEscalationPrompt({
          signals: JSON.parse(job.routing_signals || "null") ?? scanRoutingSignals({ diff }),
          firstPass,
          hunks,
          reason: job.routing_reason || "poison-alert",
        }),
        timeoutMs: internal.timeoutSeconds * 1000,
        extraArgs: deps.config.opencode.extraArgs,
        bin: deps.config.opencode.bin,
        title: `maomao-poison-alert-${job.id}`,
        signal,
      });
      const usage = usagePersistence(result.usage);
      const over = usageOverBudget({
        cost: usage.cost,
        tokens: usage.total_tokens,
        maxCostUsd: internal.maxCostUsd,
        maxTokens: internal.maxTokens,
      });
      deps.store.patchJob(job.id, {
        internal_escalation_raw: truncate(result.text || result.stdout, 200_000),
        internal_escalation_prompt_tokens: usage.prompt_tokens,
        internal_escalation_completion_tokens: usage.completion_tokens,
        internal_escalation_cost: usage.cost,
        internal_escalation_total_tokens: usage.total_tokens,
        internal_escalation_usage_complete: usage.usage_complete,
        internal_escalation_usage_warning: over ?? usage.usage_warning,
        internal_escalation_duration_ms: Date.now() - started,
        internal_escalation_model: internal.model,
        internal_escalation_provider: internal.model.includes("/") ? internal.model.split("/")[0] : null,
      });
      if (over) {
        deps.store.log(job.id, over, "warn");
        lastError = over;
        break;
      }
      const parsed = internalEscalationResultSchema.parse(extractJsonFromText(result.text || result.stdout));
      const merged = mergeInternalEscalation(firstPass, parsed);
      deps.store.patchJob(job.id, {
        internal_escalation_state: "done",
        internal_escalation_normalized: JSON.stringify(parsed, null, 2),
        internal_escalation_alert_cleared: parsed.alert_cleared ? 1 : 0,
        internal_escalation_reason: parsed.alert_cleared ? "internal pass cleared the alert" : "internal pass confirmed risk",
        aggregator_normalized: JSON.stringify(merged, null, 2),
      });
      deps.store.log(
        job.id,
        `Internal poison-alert pass done: alert_cleared=${parsed.alert_cleared} findings=${merged.findings.length}`,
      );
      return merged;
    } catch (error) {
      lastError = formatError(error);
      deps.store.log(job.id, `Internal poison-alert attempt ${attempt} failed: ${lastError}`, "warn");
      if (attempt <= retries) await sleep(500 * attempt, signal);
    }
  }

  deps.store.patchJob(job.id, {
    internal_escalation_state: "failed",
    internal_escalation_reason: lastError,
    internal_escalation_duration_ms: Date.now() - started,
  });
  if (internal.fallback === "fail") throw new Error(`internal poison-alert pass failed: ${lastError}`);
  deps.store.log(job.id, `Keeping first-pass findings after internal escalation failure: ${lastError}`, "warn");
  return firstPass;
}

async function publishReview(
  deps: PipelineDeps,
  job: JobRow,
  aggregated: AggregatorResult,
  reviewerCount: number,
  snapshot: ReconciliationSnapshot,
): Promise<{ id: string; url: string; postedFingerprints: string[] } | undefined> {
  if (deps.store.isStale(job.id)) return undefined;

  const existing = await deps.github.listReviews(job.installation_id, job.repo_owner, job.repo_name, job.pr_number);
  const already = findExistingReview(existing, job.head_sha);
  if (already) {
    deps.store.log(job.id, `Review already exists for ${job.head_sha}; skipping publish`);
    return { ...already, postedFingerprints: [] };
  }

  const publishable = findingsForPublish(aggregated.findings, snapshot);
  const dismissedCount = snapshot.items.filter((item) => item.status === "dismissed").length;
  if (dismissedCount > 0) {
    deps.store.log(job.id, `Omitting ${dismissedCount} dismissed finding(s) from this review`);
  }
  const findingsCount = publishable.length;
  const verdict = findingsCount === 0 && aggregated.verdict === "clean" ? "clean" : aggregated.verdict;
  if (findingsCount === 0 && verdict === "clean" && !deps.config.postEmptyReview) {
    deps.store.log(job.id, "Clean review with no findings; POST_EMPTY_REVIEW is false, not posting");
    return undefined;
  }

  const body = buildReviewBody({
    headSha: job.head_sha,
    summary: aggregated.summary,
    findingsCount,
    reviewerCount,
  });
  const comments = toInlineComments(publishable, deps.config.maxInlineComments, job.head_sha);
  const postedFingerprints = inlineCommentFingerprints(comments);
  const posted = await deps.github.createCommentReview({
    installationId: job.installation_id,
    owner: job.repo_owner,
    repo: job.repo_name,
    pullNumber: job.pr_number,
    commitId: job.head_sha,
    body,
    comments,
  });
  return { ...posted, postedFingerprints };
}

async function dispatchExternalEscalation(
  deps: PipelineDeps,
  job: JobRow,
  aggregated: AggregatorResult | undefined,
): Promise<void> {
  const config = deps.config.poisonAlert;
  const latest = deps.store.getJob(job.id) ?? job;
  const findings = aggregated?.findings ?? parseStoredFindings(latest.aggregator_normalized);
  const withIds = assignFindingIds(findings);
  const alertCleared = latest.internal_escalation_alert_cleared === 1;
  const internalFailed = latest.internal_escalation_state === "failed";
  const internalRan = latest.internal_escalation_state === "done" || internalFailed;
  const meets = findingsMeetThreshold(withIds, config.external.minSeverity);
  const want = shouldRunExternal({
    policy: config.policy,
    enabled: config.external.enabled,
    profile: latest.routing_profile ?? "",
    manualRequested: Boolean(latest.manual_escalate_requested),
    internalRan,
    internalFailed,
    alertCleared: alertCleared || !meets,
  });

  if (!want) {
    if (!latest.external_dispatch_status || latest.external_dispatch_status === "not_requested") {
      const reason = alertCleared
        ? "internal pass cleared the alert"
        : latest.routing_profile !== "poison-alert"
          ? "profile is not poison-alert"
          : "external dispatch not requested by policy";
      const patch: Partial<JobRow> = {
        external_dispatch_status: "not_requested",
        external_dispatch_reason: reason,
      };
      if (latest.routing_profile === "poison-alert" || latest.manual_escalate_requested) {
        patch.poison_alert_policy = config.policy;
      }
      deps.store.patchJob(job.id, patch);
    }
    return;
  }

  if (!latest.github_review_id && !latest.github_review_url) {
    deps.store.patchJob(job.id, {
      external_dispatch_status: "dispatch_failed",
      external_dispatch_reason: "Maomao review was not published; external dispatch skipped",
      poison_alert_policy: config.policy,
    });
    deps.store.log(job.id, "External poison-alert dispatch skipped because the Maomao review was not published", "warn");
    return;
  }

  const provider = "github";
  const instance = "github.com";
  const id = latest.escalation_id || escalationId({
    provider,
    instance,
    repoFullName: latest.repo_full_name,
    prNumber: latest.pr_number,
    headSha: latest.head_sha,
    policy: config.policy,
  });
  deps.store.patchJob(job.id, {
    external_dispatch_status: "dispatching",
    external_dispatch_targets: JSON.stringify(config.external.targets),
    escalation_id: id,
    poison_alert_policy: config.policy,
  });

  const findingsList = withIds.map((finding) => finding.id).join(", ") || "(none)";
  const riskSummary =
    sanitizePublicReason(latest.routing_reason || aggregated?.summary || "", 300) || "poison-alert";
  const errors: string[] = [];
  let anySuccess = false;

  for (const target of config.external.targets) {
    const key = targetKey(target);
    const claimed = deps.store.claimDispatch({
      escalationId: id,
      jobId: latest.id,
      provider,
      instance,
      repoFullName: latest.repo_full_name,
      prNumber: latest.pr_number,
      headSha: latest.head_sha,
      policy: config.policy,
      targetKey: key,
      targetType: target.type,
    });
    if (!claimed.created && claimed.row.status === "dispatched") {
      anySuccess = true;
      continue;
    }
    try {
      if (target.type === "webhook") {
        const env = deps.env ?? process.env;
        const url = env[target.urlSecretRef]?.trim();
        const secret = env[target.signingSecretRef]?.trim();
        if (!url || !secret) throw new Error(`missing ${target.urlSecretRef} or ${target.signingSecretRef}`);
        const payload = JSON.stringify({
          event: "maomao.poison_alert",
          escalation_id: id,
          provider,
          instance,
          repository: latest.repo_full_name,
          pull_request: latest.pr_number,
          head_sha: latest.head_sha,
          job_id: latest.id,
          review_id: latest.github_review_id,
          review_url: latest.github_review_url,
          profile: latest.routing_profile,
          reason: riskSummary,
          policy: config.policy,
          finding_ids: withIds.map((finding) => finding.id),
          risk_summary: riskSummary,
          status: "dispatched",
        });
        const delivered = await deliverSignedWebhook({
          url,
          secret,
          body: payload,
          fetchImpl: deps.fetchImpl,
        });
        if (!delivered.ok) throw new Error(delivered.error || `webhook status ${delivered.status}`);
        deps.store.updateDispatch(claimed.row.id, "dispatched", `webhook ${delivered.status}`);
        anySuccess = true;
      } else {
        const recipient = resolveMention(target.recipient, latest.repo_owner);
        const command = target.type === "command" ? target.command : undefined;
        const marker = escalationMarker({
          id,
          provider,
          instance,
          repo: latest.repo_full_name,
          pr: latest.pr_number,
          sha: latest.head_sha,
          job: latest.id,
          targetKey: key,
          status: "dispatched",
        });
        if (deps.github.listIssueComments) {
          const comments = await deps.github.listIssueComments(
            latest.installation_id,
            latest.repo_owner,
            latest.repo_name,
            latest.pr_number,
          );
          const already = comments.find((comment) => {
            const parsed = parseEscalationMarker(comment.body);
            return parsed?.id === id && parsed.sha === latest.head_sha && parsed.target === key;
          });
          if (already) {
            deps.store.updateDispatch(claimed.row.id, "dispatched", `comment ${already.id}`);
            anySuccess = true;
            continue;
          }
        }
        if (!deps.github.createIssueComment) {
          throw new Error("GitHub issue comments are not available on this client");
        }
        const lines = [
          marker,
          command ? `${recipient} ${command}` : recipient,
          "",
          `Maomao published a poison-alert review for \`${latest.repo_full_name}#${latest.pr_number}\` at \`${latest.head_sha}\`.`,
          latest.github_review_url ? `Review: ${latest.github_review_url}` : "",
          `Finding IDs: ${findingsList}`,
          `Risk: ${riskSummary}`,
          "",
          "This is a fire-and-forget notification. Maomao does not track downstream review completion.",
        ].filter((line) => line !== "");
        const posted = await deps.github.createIssueComment({
          installationId: latest.installation_id,
          owner: latest.repo_owner,
          repo: latest.repo_name,
          pullNumber: latest.pr_number,
          body: lines.join("\n"),
        });
        deps.store.updateDispatch(claimed.row.id, "dispatched", posted.url || posted.id);
        anySuccess = true;
      }
    } catch (error) {
      const message = formatError(error);
      errors.push(`${target.type}: ${message}`);
      deps.store.updateDispatch(claimed.row.id, "dispatch_failed", message);
    }
  }

  const jobStatus = errors.length === 0 ? "dispatched" : "dispatch_failed";
  deps.store.patchJob(job.id, {
    external_dispatch_status: jobStatus,
    external_dispatch_reason:
      errors.length === 0
        ? "immediate dispatch completed"
        : anySuccess
          ? `partial dispatch: ${errors.join("; ")}`
          : errors.join("; ") || "dispatch failed",
    external_dispatch_error: errors.length ? errors.join("; ") : null,
  });
  deps.store.log(
    job.id,
    anySuccess
      ? `External poison-alert dispatch ${errors.length ? "partially " : ""}completed`
      : `External poison-alert dispatch failed: ${errors.join("; ")}`,
    errors.length ? "warn" : "info",
  );
}

function jobHasPendingDispatch(store: JobStore, job: JobRow): boolean {
  if (job.external_dispatch_status !== "dispatched") return true;
  return store.listDispatches(job.id).some((row) => row.status !== "dispatched");
}

function parseStoredFindings(raw: string | null): AggregatorResult["findings"] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as AggregatorResult;
    return Array.isArray(parsed.findings) ? parsed.findings : [];
  } catch {
    return [];
  }
}

function formatError(error: unknown): string {
  if (error instanceof SchemaValidationError) return `${error.message}: ${error.issues}`;
  if (error instanceof ZodError) return `schema invalid: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
