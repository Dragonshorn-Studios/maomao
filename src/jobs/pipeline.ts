import type { Config } from "../config.js";
import type { JobStore, JobRow, ReviewerRunRow, NewJobInput } from "./store.js";
import type { GithubPort } from "../github/client.js";
import type { ForgePort } from "../forge/port.js";
import { ForgeRegistry } from "../forge/registry.js";
import type { ForgeConnectionStore } from "../forge/connections.js";
import type { ForgeDiscussion, ForgeInlineComment, ForgeRepoTarget, ForgeSummary, ForgeVerdict } from "../forge/types.js";
import { forgeTargetOf, scopeOf } from "../forge/types.js";
import { buildReviewBody, findExistingReview, selectInlineComments, inlineCommentFingerprints } from "../forge/review-text.js";
import type { CheckoutPort } from "../checkout.js";
import {
  aggregatorUsagePersistence,
  usagePersistence,
  type OpenCodePort,
  type OpenCodeRunResult,
} from "../opencode/parse.js";
import { buildAggregatorPrompt, buildBriefPrompt, buildReviewerPrompt, buildStackCumulativePrompt } from "../prompts.js";
import { applyProfileToSpecs, reviewerSpecs } from "./enqueue.js";
import type { ProfileDefinition } from "../config-revisions.js";
import {
  fallbackAggregator,
  parseAggregatorResult,
  parseBriefResult,
  parseReviewerResult,
  severityRank,
  SchemaValidationError,
  extractJsonFromText,
  formatSchemaError,
  type AggregatorResult,
  type BriefResult,
  type ReviewerResult,
  type Severity,
} from "../schema.js";
import { buildBriefPayload, parseBriefPayload } from "./brief.js";
import { classifyPriorFindings, collectPriorFindings, findingsForPublish } from "../findings/reconcile.js";
import {
  collectHumanOverrides,
  emptyOverrideContext,
  isProtectedFinding,
  omitOverriddenFindings,
  type HumanOverrideContext,
} from "../findings/overrides.js";
import { resolveReviewEvent } from "./verdict.js";
import { applyReconciliationThreads, attachStoredThreadIds, closeResolvedScanIssues, findingDiffContext, persistClassifications, persistThreadsAsFindings } from "../findings/apply.js";
import { githubRetryReason } from "../github/errors.js";
import { fingerprintFinding } from "../findings/identity.js";
import type { ReconciliationSnapshot } from "../findings/types.js";
import { currentFindingsForRisk } from "../findings/types.js";
import { mapLimit, nowIso, sleep, truncate } from "../util.js";
import { authorizationLogLine, authorizeGithubTarget, logAuthorizationRejection } from "../github/authorize.js";
import { scanRoutingSignals, relevantDiffHunks } from "../routing/signals.js";
import {
  diagnosisFallback,
  deterministicDecision,
  mergeModelDecision,
} from "../routing/select.js";
import { parseInternalEscalationResult, parseRouterResult } from "../routing/parse.js";
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
  profileBudgetExceeded,
} from "../routing/policy.js";

export interface PipelineDeps {
  config: Config;
  store: JobStore;
  /** GitHub client for GitHub-only features (issue creation, scan-issue closing) and the default registry's backing client. */
  github: GithubPort;
  /** Registry resolving each job's forge port; defaults to a registry over `github`. */
  forge?: ForgeRegistry;
  /** Persisted forge connections backing the default registry's GitLab bindings. */
  connections?: ForgeConnectionStore;
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
  const forge =
    deps.forge ?? new ForgeRegistry(deps.github, deps.config.github.appSlug, deps.getInstallationToken, deps.connections);
  return {
    abortJob,
    async run(jobId: number): Promise<void> {
      const existing = aborts.get(jobId);
      if (existing) existing.abort();
      const controller = new AbortController();
      aborts.set(jobId, controller);
      try {
        const job = deps.store.getJob(jobId);
        if (job?.job_type === "health_scan") {
          await runScanJob(deps, forge, jobId, controller.signal);
        } else if (job?.job_type === "repo_brief") {
          await runBriefJob(deps, forge, jobId, controller.signal);
        } else if (job?.job_type === "stack_review") {
          await runStackJob(deps, forge, jobId, controller.signal);
        } else {
          await runJob(deps, forge, jobId, controller.signal);
        }
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

/** Definition of the profile revision snapshotted onto the job, if any. */
function profileDefinitionForJob(store: JobStore, job: JobRow): ProfileDefinition | null {
  return job.profile_revision_id ? store.configs.getRevision(job.profile_revision_id)?.definition ?? null : null;
}

/** Per-role timeout overrides from a profile definition. */
function profileReviewerTimeouts(definition: ProfileDefinition | null): ReadonlyMap<string, number> {
  return new Map(
    (definition?.reviewers ?? [])
      .filter((reviewer) => reviewer.timeoutMs != null)
      .map((reviewer) => [reviewer.role, reviewer.timeoutMs as number]),
  );
}

/**
 * Persists the ceiling violation on the job so the UI alert and the logs agree:
 * every path that skips a paid stage records budget_exceeded_warning once.
 */
function patchBudgetWarning(store: JobStore, jobId: number, message: string): void {
  store.patchJob(jobId, { budget_exceeded_warning: message });
}

/**
 * Job-wide profile budget tracker. Usage accumulates across the verifier,
 * routing, reviewer, aggregation, and internal stages; `check()` returns and
 * latches the ceiling message once accumulated usage exceeds either optional
 * cap, so every later spend stage sees the same violation. Jobs without a
 * profile (or without ceilings) never trip it. Ceilings enforce at run
 * boundaries: runs already in flight when a cap trips still finish (the same
 * semantics as the poison-alert cap), so concurrent reviewers may collectively
 * overshoot by up to one in-flight batch — the retry loop also re-checks so
 * failed attempts cannot respend past a latched ceiling.
 */
interface ProfileBudget {
  behavior: "degrade" | "fail";
  check(): string | undefined;
  record(cost?: number | null, tokens?: number | null): void;
}

function createProfileBudget(definition: ProfileDefinition | null): ProfileBudget {
  const state = { cost: 0, tokens: 0 };
  let exceeded: string | undefined;
  return {
    behavior: definition?.onBudgetExceeded ?? "degrade",
    check(): string | undefined {
      if (exceeded) return exceeded;
      exceeded = profileBudgetExceeded({
        cost: state.cost,
        tokens: state.tokens,
        maxCostUsd: definition?.maxTotalCostUsd,
        maxTokens: definition?.maxTotalTokens,
      });
      return exceeded;
    },
    record(cost, tokens) {
      state.cost += cost ?? 0;
      state.tokens += tokens ?? 0;
    },
  };
}

/**
 * Canonical degraded-fallback aggregation patch — the single owner of what a
 * fallback aggregation looks like on the job row, shared by the budget
 * degradation path (no model output to preserve) and runAggregator's
 * model-failure catch (which preserves the truncated raw output).
 */
function applyAggregatorFallback(
  store: JobStore,
  jobId: number,
  model: string | null,
  reviewers: ReviewerResult[],
  raw: string | null,
  durationMs: number,
): AggregatorResult {
  const fallback = fallbackAggregator(reviewers);
  store.patchJob(jobId, {
    aggregator_raw: raw,
    aggregator_normalized: JSON.stringify(fallback, null, 2),
    aggregator_model: model,
    aggregator_state: "done",
    aggregator_fallback: 1,
    aggregator_finished_at: nowIso(),
    aggregator_duration_ms: durationMs,
  });
  return fallback;
}

/** Budget degradation: no model run happened, so there is no raw output to preserve. */
function degradedAggregation(
  store: JobStore,
  jobId: number,
  reviewers: ReviewerResult[],
  message: string,
): AggregatorResult {
  store.patchJob(jobId, { budget_exceeded_warning: message });
  return applyAggregatorFallback(store, jobId, null, reviewers, null, 0);
}

/**
 * Shared reviewer stage with profile budget enforcement: each run is
 * rescheduled only while the job-wide budget allows; once a ceiling trips,
 * degrade mode skips the remaining runs and fail mode aborts the job.
 */
async function runProfileReviewers(
  deps: PipelineDeps,
  job: JobRow,
  runs: ReviewerRunRow[],
  repoDir: string,
  files: string[],
  signal: AbortSignal,
  budget: ProfileBudget,
  timeouts: ReadonlyMap<string, number>,
  humanOverrides?: HumanOverrideContext,
): Promise<void> {
  const store = deps.store;
  await mapLimit(runs, deps.config.opencode.reviewerConcurrency, async (run) => {
    throwIfStale(store, job.id, signal);
    const over = budget.check();
    if (over) {
      if (budget.behavior === "fail") throw new Error(`profile budget exceeded — ${over}`);
      store.patchReviewer(run.id, {
        state: "failed",
        validation_error: `skipped: profile budget exceeded — ${over}`,
        finished_at: nowIso(),
      });
      store.log(job.id, `Reviewer ${run.role} skipped: ${over}`, "warn", run.id);
      patchBudgetWarning(store, job.id, over);
      return;
    }
    await runReviewer(deps, job, run, repoDir, files, signal, timeouts.get(run.role), budget, humanOverrides);
  });
}

/**
 * Shared aggregation stage with profile budget enforcement: a latched budget
 * violation replaces the aggregator model run with the deterministic fallback
 * (degrade) or aborts the job (fail); a successful run feeds its usage back
 * into the tracker.
 */
async function runBudgetedAggregation(
  deps: PipelineDeps,
  job: JobRow,
  reviewers: ReviewerResult[],
  cwd: string,
  files: string[],
  signal: AbortSignal,
  budget: ProfileBudget,
  humanOverrides?: HumanOverrideContext,
): Promise<AggregatorResult> {
  const store = deps.store;
  store.setJobState(job.id, "aggregating", {
    aggregator_state: "running",
    aggregator_started_at: nowIso(),
    aggregator_model: deps.config.opencode.aggregatorModel || deps.config.opencode.reviewerModel || null,
  });
  store.log(job.id, `Aggregating ${reviewers.length} reviewer result(s)`);
  const over = budget.check();
  if (over) {
    if (budget.behavior === "fail") throw new Error(`profile budget exceeded — ${over}`);
    store.log(job.id, `Aggregator model skipped: ${over}`, "warn");
    return degradedAggregation(store, job.id, reviewers, over);
  }
  const aggregated = await runAggregator(deps, job, reviewers, cwd, files, signal, budget, humanOverrides);
  // A stage that spent while the tracker had room can spill past a ceiling on
  // its own usage; surface the latch immediately (fail mode aborts downstream
  // anyway; degrade records the warning and publishes partials).
  const spilled = budget.check();
  if (spilled && budget.behavior === "degrade") {
    patchBudgetWarning(store, job.id, spilled);
    store.log(job.id, `Profile budget exceeded after aggregation: ${spilled}`, "warn");
  }
  return aggregated;
}

async function runJob(deps: PipelineDeps, forge: ForgeRegistry, jobId: number, signal: AbortSignal): Promise<void> {
  const { store, config } = deps;
  const job = store.getJob(jobId);
  if (!job) {
    // No row exists to log into; the queue runner still records the failure.
    console.warn(`pipeline: job ${jobId} vanished before run`);
    return;
  }
  if (["stale", "cancelled"].includes(job.state)) {
    store.log(jobId, `Skipped run: job is ${job.state}`, "warn");
    return;
  }
  if (job.state === "completed") {
    if (job.manual_escalate_requested && jobHasPendingDispatch(store, job)) {
      await dispatchExternalEscalation(deps, job, undefined);
    }
    return;
  }

  const auth =
    job.provider === "github"
      ? authorizeGithubTarget(config, {
          installationId: job.installation_id,
          accountId: job.github_account_id ?? undefined,
          repositoryId: job.github_repository_id ?? undefined,
        })
      : // Non-GitHub jobs were authorized by their connection binding at the
        // webhook (scope + secret + enabled checks); GitHub allowlists do not
        // apply to them.
        { ok: true as const };
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

    const target = forgeTargetOf(job);
    const provider = forge.forJob(job);
    const clone = await provider.cloneSpec(target);
    const diff = await provider.getChangeDiff(target, config.maxDiffBytes);
    const diffBytes = Buffer.byteLength(diff, "utf8");
    if (config.maxDiffBytes > 0 && diffBytes > config.maxDiffBytes) {
      throw new Error(`diff exceeds MAX_DIFF_BYTES (${diffBytes} > ${config.maxDiffBytes})`);
    }
    const workspace = await deps.checkout.prepare({
      jobId,
      cloneUrl: clone.cloneUrl,
      gitAuthArgs: clone.gitAuthArgs,
      remoteRef: clone.remoteRef,
      secrets: [...clone.secrets, ...globalSecrets(config)],
      baseSha: job.base_sha,
      headSha: job.head_sha,
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

    const profileDefinition = profileDefinitionForJob(store, job);
    const reviewerTimeouts = profileReviewerTimeouts(profileDefinition);
    const profileBudget = createProfileBudget(profileDefinition);
    const snapshot = await reconcileAndRoute(deps, provider, job, workspace.repoDir, workspace.dir, diff, signal, profileBudget);
    throwIfStale(store, jobId, signal);
    await routeSpecialists(deps, job, diff, workspace.repoDir, [workspace.diffPath, workspace.metaPath], signal, profileBudget);
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
    await runProfileReviewers(
      deps,
      job,
      runs,
      workspace.repoDir,
      [workspace.diffPath, workspace.metaPath],
      signal,
      profileBudget,
      reviewerTimeouts,
      snapshot.humanOverrides,
    );
    throwIfStale(store, jobId, signal);

    const completedRuns = store.listReviewerRuns(jobId);
    const parsedReviewers: ReviewerResult[] = [];
    for (const run of completedRuns) {
      if (run.state === "done" && run.normalized_json) {
        parsedReviewers.push(JSON.parse(run.normalized_json) as ReviewerResult);
      }
    }
    if (parsedReviewers.length === 0) {
      // Degrade cannot rescue zero output: with no reviewer results there is nothing
      // to publish, so this path still fails — but with an explicit budget reason.
      const over = profileBudget.check();
      if (over) throw new Error(`profile budget exceeded — ${over}`);
      throw new Error("all specialist reviewers failed or produced invalid JSON");
    }

    let aggregated = await runBudgetedAggregation(
      deps,
      job,
      parsedReviewers,
      workspace.repoDir,
      [workspace.diffPath],
      signal,
      profileBudget,
      snapshot.humanOverrides,
    );
    throwIfStale(store, jobId, signal);

    const afterReviewers = store.getJob(jobId);
    if (afterReviewers && shouldRunInternal(config.poisonAlert.policy, config.poisonAlert.internal.enabled, afterReviewers.routing_profile ?? "")) {
      const internalOver = profileBudget.check();
      if (internalOver) {
        if (profileBudget.behavior === "fail") throw new Error(`profile budget exceeded — ${internalOver}`);
        patchBudgetWarning(store, jobId, internalOver);
        store.patchJob(jobId, {
          internal_escalation_state: "skipped",
          internal_escalation_reason: `profile budget exceeded — ${internalOver}`,
        });
        store.log(jobId, `Internal poison-alert pass skipped: ${internalOver}`, "warn");
      } else {
        aggregated = await runInternalEscalation(deps, afterReviewers, aggregated, diff, workspace.repoDir, signal, profileBudget);
      }
      throwIfStale(store, jobId, signal);
    }

    aggregated = {
      ...aggregated,
      findings: assignFindingIds(aggregated.findings),
    };
    store.patchJob(jobId, { aggregator_normalized: JSON.stringify(aggregated, null, 2) });

    store.setJobState(jobId, "publishing", { aggregator_state: "done" });
    const posted = await publishReview(deps, provider, job, aggregated, parsedReviewers.length, snapshot, diff, signal);
    const afterPublish = store.getJob(jobId) ?? job;
    if (posted) {
      store.patchJob(jobId, { github_review_id: posted.id, github_review_url: posted.url });
    }
    store.log(
      jobId,
      posted ? `Published ${store.getJob(jobId)?.review_event ?? "COMMENT"} review ${posted.id}` : "No GitHub review posted",
    );
    if (store.isStale(jobId)) {
      throw new Error("stale");
    }
    persistClassifications(store, job, snapshot.items, diff);
    try {
      const threads = await provider.listDiscussions(forgeTargetOf(job));
      persistThreadsAsFindings({
        store,
        job,
        threads,
        postedFingerprints: posted?.postedFingerprints ?? [],
        diff,
      });
    } catch (error) {
      store.log(jobId, `Could not refresh finding thread ids: ${formatError(error)}`, "warn");
    }
    const closeSnapshot = attachStoredThreadIds(store, job, snapshot);
    try {
      const applied = await applyReconciliationThreads({
        forge: provider,
        job,
        snapshot: closeSnapshot,
        postedFingerprints: posted?.postedFingerprints ?? [],
      });
      if (applied.resolved.length > 0) {
        store.log(
          jobId,
          `Resolved ${applied.resolved.length} prior thread(s) after successful review (${applied.resolved.join(", ")})`,
        );
      }
      for (const skip of applied.skipped) {
        if (!skip.wantedClose) continue;
        store.log(jobId, `Did not close thread for ${skip.fingerprint}: ${skip.reason}`, "warn");
      }
      for (const failure of applied.failed) {
        store.log(jobId, `Could not resolve thread for ${failure.fingerprint}: ${failure.reason}`, "warn");
        const item = closeSnapshot.items.find((candidate) => candidate.fingerprint === failure.fingerprint);
        // A resolve that failed must not leave the DB claiming a state GitHub
        // does not have: keep the finding visible so the next run retries.
        // (dismissed is a human override; moved was already republished.)
        if (item?.status === "resolved") {
          store.setFindingStatus(
            job.repo_full_name,
            job.pr_number,
            failure.fingerprint,
            "uncertain",
            githubRetryReason("thread", failure.reason),
            scopeOf(job),
          );
        }
      }
    } catch (error) {
      store.log(jobId, `Thread resolve deferred: ${formatError(error)}`, "warn");
    }

    throwIfStale(store, jobId, signal);
    await dispatchExternalEscalation(deps, store.getJob(jobId) ?? afterPublish, aggregated);
    store.setJobState(jobId, "completed", {
      github_review_id: posted?.id ?? store.getJob(jobId)?.github_review_id ?? null,
      github_review_url: posted?.url ?? store.getJob(jobId)?.github_review_url ?? null,
      finished_at: nowIso(),
    });
  } catch (error) {
    if (store.isStale(jobId) || signal.aborted) {
      const afterAbort = store.getJob(jobId);
      const cancelled = afterAbort?.state === "cancelled";
      // A review POST already in flight can complete despite cancellation, so
      // the row — not the happy path's local variables — is the source of truth.
      const reviewPosted = Boolean(afterAbort?.github_review_id);
      let abortNote = "Job aborted or marked stale; skipping publish";
      if (cancelled) {
        abortNote = reviewPosted
          ? "Job cancelled after a review was posted; the posted review is stale"
          : "Job cancelled before publish; no review posted";
      }
      store.log(jobId, abortNote, "warn");
      const runningInternal = afterAbort?.internal_escalation_state === "running";
      if (runningInternal) {
        store.patchJob(jobId, {
          internal_escalation_state: "failed",
          internal_escalation_reason: "job ended before the internal pass finished",
        });
      }
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

/**
 * On-demand repository health scan of the pinned default-branch head SHA. Read-only:
 * checkout + specialists + aggregation, findings persisted locally. Never publishes a
 * GitHub review and never creates issues — issue creation is a separate operator action.
 */
async function runScanJob(deps: PipelineDeps, forge: ForgeRegistry, jobId: number, signal: AbortSignal): Promise<void> {
  const store = deps.store;
  const config = deps.config;
  const job = store.getJob(jobId);
  if (!job) return;
  try {
    // Health scans are a GitHub feature; non-github scan jobs fail with an
    // honest reason instead of a confusing cross-forge allowlist failure.
    if (job.provider !== "github") {
      store.setJobState(jobId, "failed", {
        failure_reason: `health scans are not available for ${job.provider}:${job.provider_instance}`,
        finished_at: nowIso(),
      });
      return;
    }
    // Allowlists can change after enqueue; re-check before doing any work.
    const auth = authorizeGithubTarget(config, {
      installationId: job.installation_id,
      accountId: job.github_account_id ?? undefined,
      repositoryId: job.github_repository_id ?? undefined,
    });
    if (!auth.ok) {
      logAuthorizationRejection({ installationId: job.installation_id, reason: auth.reason });
      store.setJobState(jobId, "failed", { failure_reason: `unauthorized: ${auth.reason}`, finished_at: nowIso() });
      return;
    }
    store.setJobState(jobId, "preparing", { started_at: nowIso() });
    store.log(jobId, `Health scan of ${job.repo_full_name} at ${job.head_sha}`);
    const provider = forge.forJob(job);
    if (!provider.getCommitDiff) throw new Error("health scans require a forge provider with commit diff support");
    const target = forgeTargetOf(job);
    const diff = await provider.getCommitDiff(target, job.head_sha);
    if (config.maxDiffBytes > 0 && diff.length > config.maxDiffBytes) {
      throw new Error(`commit diff exceeds MAX_DIFF_BYTES (${diff.length} > ${config.maxDiffBytes})`);
    }
    const clone = await provider.cloneSpec(target, { anonymous: job.installation_id === 0 });
    const workspace = await deps.checkout.prepare({
      jobId,
      cloneUrl: clone.cloneUrl,
      gitAuthArgs: clone.gitAuthArgs,
      remoteRef: clone.remoteRef,
      secrets: [...clone.secrets, ...globalSecrets(config)],
      baseSha: job.head_sha,
      headSha: job.head_sha,
      signal,
      fetchDiff: async () => diff,
      metadata: {
        repo: job.repo_full_name,
        pr: 0,
        title: job.pr_title,
        baseSha: job.head_sha,
        headSha: job.head_sha,
      },
    });
    store.patchJob(jobId, { workspace_path: workspace.dir });
    throwIfStale(store, jobId, signal);

    const profileDefinition = profileDefinitionForJob(store, job);
    const reviewerTimeouts = profileReviewerTimeouts(profileDefinition);
    const profileBudget = createProfileBudget(profileDefinition);

    await routeSpecialists(deps, job, diff, workspace.repoDir, [], signal, profileBudget);
    store.setJobState(jobId, "reviewing");
    const runs = store.listReviewerRuns(jobId);
    store.log(jobId, `Running ${runs.length} specialist(s)`);
    await runProfileReviewers(
      deps,
      job,
      runs,
      workspace.repoDir,
      [workspace.diffPath, workspace.metaPath],
      signal,
      profileBudget,
      reviewerTimeouts,
    );
    const parsedReviewers = runs
      .map((run) => ({ run: store.getReviewerRun(run.id), role: run.role }))
      .filter((entry): entry is { run: ReviewerRunRow; role: string } => entry.run?.state === "done")
      .map((entry) => ({ ...entry, parsed: parseReviewerResult(entry.run.normalized_json ?? "") }));
    if (parsedReviewers.length === 0) {
      // Degrade cannot rescue zero output: with no reviewer results there is nothing
      // to publish, so this path still fails — but with an explicit budget reason.
      const over = profileBudget.check();
      if (over) throw new Error(`profile budget exceeded — ${over}`);
      throw new Error("all specialist reviewers failed or produced invalid JSON");
    }

    let aggregated = await runBudgetedAggregation(
      deps,
      job,
      parsedReviewers.map((entry) => entry.parsed),
      workspace.repoDir,
      [workspace.diffPath],
      signal,
      profileBudget,
    );
    throwIfStale(store, jobId, signal);
    aggregated = { ...aggregated, findings: assignFindingIds(aggregated.findings) };
    store.patchJob(jobId, { aggregator_normalized: JSON.stringify(aggregated, null, 2) });

    // Persist scan findings locally; issue creation is a separate, explicit operator action.
    const threshold = severityRank(
      profileDefinitionForJob(store, job)?.minPublishableSeverity ?? "info",
    );
    const currentFingerprints = new Set<string>();
    let persisted = 0;
    for (const finding of aggregated.findings) {
      if (severityRank(finding.severity) > threshold) continue;
      const context = findingDiffContext(diff, finding.file, finding.line);
      const fingerprint = fingerprintFinding({ ...finding });
      currentFingerprints.add(fingerprint);
      store.upsertFinding({
        repoFullName: job.repo_full_name,
        prNumber: 0,
        scope: scopeOf(job),
        fingerprint,
        status: "open",
        reviewedSha: job.head_sha,
        currentSha: job.head_sha,
        originalPath: finding.file,
        originalLine: finding.line,
        currentPath: finding.file,
        currentLine: finding.line,
        category: finding.category,
        summary: finding.summary,
        body: finding.body,
        severity: finding.severity,
        confidence: finding.confidence,
        diffHunk: context.diffHunk,
        diffNote: context.diffNote,
        lastJobId: job.id,
      });
      persisted += 1;
    }

    const stored = store.listFindings(job.repo_full_name, 0, scopeOf(job));
    const priors = collectPriorFindings({ threads: [], stored }).filter(
      (prior) => !currentFingerprints.has(prior.fingerprint),
    );
    store.log(
      jobId,
      `Reconciling ${priors.length} prior scan finding(s) for ${job.repo_full_name} @ ${job.head_sha}`,
    );
    throwIfStale(store, jobId, signal);
    const items = await classifyPriorFindings({
      onVerifierError: (message) => store.log(jobId, `Verifier failed: ${message}`, "warn"),
      config,
      opencode: deps.opencode,
      job,
      repoDir: workspace.repoDir,
      diff,
      workspaceDir: workspace.dir,
      priors,
      signal,
      budgetBlock: () => profileBudget.check(),
      onVerifierUsage: (usage) => profileBudget.record(usage.cost, usage.totalTokens),
    });
    for (const item of items) {
      store.log(
        jobId,
        `Finding ${item.fingerprint} classified ${item.status} (confidence=${item.confidence}): ${item.reason}`,
      );
    }
    persistClassifications(store, job, items, diff);
    store.patchJob(jobId, { reconciliation_json: JSON.stringify({ headSha: job.head_sha, items }) });
    throwIfStale(store, jobId, signal);
    try {
      const closed = await closeResolvedScanIssues({
        github: deps.github,
        store,
        job,
        items,
      });
      if (closed.closed.length > 0) {
        store.log(
          jobId,
          `Closed ${closed.closed.length} Maomao scan issue(s) for resolved findings (${closed.closed.join(", ")})`,
        );
      }
      for (const skip of closed.skipped) {
        if (!skip.wantedClose) continue;
        store.log(jobId, `Did not close issue for ${skip.fingerprint}: ${skip.reason}`, "warn");
      }
      for (const failure of closed.failed) {
        store.log(jobId, `Could not close issue for ${failure.fingerprint}: ${failure.reason}`, "warn");
        store.setFindingStatus(
          job.repo_full_name,
          job.pr_number,
          failure.fingerprint,
          "uncertain",
          githubRetryReason("issue", failure.reason),
          scopeOf(job),
        );
      }
    } catch (error) {
      store.log(jobId, `Scan issue close deferred: ${formatError(error)}`, "warn");
    }

    store.setJobState(jobId, "completed", {
      aggregator_state: "done",
      finished_at: nowIso(),
    });
    store.log(jobId, `Health scan completed: ${persisted} finding(s) persisted; no GitHub review posted`);
  } catch (error) {
    if (store.isStale(jobId) || signal.aborted) {
      const cancelled = store.getJob(jobId)?.state === "cancelled";
      store.log(jobId, cancelled ? "Scan cancelled" : "Scan aborted or marked stale", "warn");
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
    store.log(jobId, `Scan failed: ${message}`, "error");
  }
}

/**
 * Repo-brief job (issue #88): a forge-aware checkout of the chosen SHA, then a
 * single read-only OpenCode run producing a 5–15-section TOC. The pipeline
 * reads bounded fragments of each section's file into `jobs.brief_json` before
 * the workspace is swept, so the TOC keeps working after retention cleans up.
 * No findings, no aggregation, nothing posted to the forge.
 *
 * Issue #89: payloads also persist into repo_brief_cache keyed by
 * forge/repo/SHA, so a repeat brief on the same tip skips both the checkout
 * and the OpenCode run — the new job is its own run that happens to be served
 * from cache. Ask still works on cache-hit jobs: it lazily prepares its own
 * chat workspace when the job has none.
 */
async function runBriefJob(deps: PipelineDeps, forge: ForgeRegistry, jobId: number, signal: AbortSignal): Promise<void> {
  const store = deps.store;
  const config = deps.config;
  const job = store.getJob(jobId);
  if (!job) return;
  try {
    // Repo briefs are a GitHub feature like health scans.
    if (job.provider !== "github") {
      store.setJobState(jobId, "failed", {
        failure_reason: `repo briefs are not available for ${job.provider}:${job.provider_instance}`,
        finished_at: nowIso(),
      });
      return;
    }
    // Allowlists can change after enqueue; re-check before doing any work.
    const auth = authorizeGithubTarget(config, {
      installationId: job.installation_id,
      accountId: job.github_account_id ?? undefined,
      repositoryId: job.github_repository_id ?? undefined,
    });
    if (!auth.ok) {
      logAuthorizationRejection({ installationId: job.installation_id, reason: auth.reason });
      store.setJobState(jobId, "failed", { failure_reason: `unauthorized: ${auth.reason}`, finished_at: nowIso() });
      return;
    }
    store.setJobState(jobId, "preparing", { started_at: nowIso() });
    store.log(jobId, `Repo brief of ${job.repo_full_name} at ${job.head_sha}`);
    const run = store.listReviewerRuns(jobId).find((entry) => entry.role === "repo_brief");
    if (!run) throw new Error("repo brief run was not enqueued");

    // A cache hit for this exact forge/repo/SHA skips the clone and the
    // OpenCode pass entirely; the stored payload's own sha is re-checked
    // before serving so a mismatched row can never produce a wrong brief.
    if (config.brief.cacheEnabled) {
      const cached = store.getRepoBriefCache(job.provider, job.provider_instance, job.repo_full_name, job.head_sha);
      const cachedPayload = cached ? parseBriefPayload(cached.payload) : undefined;
      if (cachedPayload && cachedPayload.sha === job.head_sha) {
        store.patchJob(jobId, { brief_json: JSON.stringify({ ...cachedPayload, served_from_cache: true }) });
        store.patchReviewer(run.id, { state: "done", finished_at: nowIso() });
        store.setJobState(jobId, "completed", { finished_at: nowIso() });
        store.log(
          jobId,
          `Repo brief served from the brief cache (generated ${cachedPayload.generated_at}): ${cachedPayload.sections.length} section(s), no OpenCode run`,
        );
        return;
      }
    }

    const provider = forge.forJob(job);
    const target = forgeTargetOf(job);
    const clone = await provider.cloneSpec(target, { anonymous: job.installation_id === 0 });
    const workspace = await deps.checkout.prepare({
      jobId,
      cloneUrl: clone.cloneUrl,
      gitAuthArgs: clone.gitAuthArgs,
      remoteRef: clone.remoteRef,
      secrets: [...clone.secrets, ...globalSecrets(config)],
      baseSha: job.head_sha,
      headSha: job.head_sha,
      signal,
      // Briefs read the tree, not a diff; the PR ref fetch (refs/pull/0/head)
      // fails and the checkout falls back to the head SHA refspec.
      fetchDiff: async () => "",
      metadata: {
        repo: job.repo_full_name,
        pr: 0,
        title: job.pr_title,
        baseSha: job.head_sha,
        headSha: job.head_sha,
      },
    });
    store.patchJob(jobId, { workspace_path: workspace.dir });
    throwIfStale(store, jobId, signal);

    store.setJobState(jobId, "reviewing");
    const brief = await runBriefRun(deps, job, run, workspace.repoDir, signal);
    const finished = store.getReviewerRun(run.id);
    if (!brief || finished?.state !== "done") {
      throw new Error(finished?.validation_error ?? "repo brief run failed");
    }
    throwIfStale(store, jobId, signal);

    const payload = await buildBriefPayload(workspace.repoDir, {
      repo: job.repo_full_name,
      sha: job.head_sha,
      brief,
    });
    store.patchJob(jobId, { brief_json: JSON.stringify(payload) });
    if (config.brief.cacheEnabled) {
      store.putRepoBriefCache(job.provider, job.provider_instance, job.repo_full_name, job.head_sha, JSON.stringify(payload));
    }
    store.setJobState(jobId, "completed", { finished_at: nowIso() });
    store.log(
      jobId,
      `Repo brief completed: ${payload.sections.length} section(s), ${payload.sections.filter((section) => section.fragment != null).length} fragment(s) persisted`,
    );
  } catch (error) {
    if (store.isStale(jobId) || signal.aborted) {
      const cancelled = store.getJob(jobId)?.state === "cancelled";
      store.log(jobId, cancelled ? "Repo brief cancelled" : "Repo brief aborted or marked stale", "warn");
      if (!store.isStale(jobId)) store.setJobState(jobId, "stale", { finished_at: nowIso() });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    for (const run of store.listReviewerRuns(jobId)) {
      if (run.state === "queued" || run.state === "running") {
        store.patchReviewer(run.id, {
          state: "failed",
          validation_error: "job ended before this run finished",
          finished_at: nowIso(),
        });
      }
    }
    store.setJobState(jobId, "failed", {
      failure_reason: message,
      finished_at: nowIso(),
    });
    store.log(jobId, `Repo brief failed: ${message}`, "error");
  }
}

// Stack reviews (issue #99): one job orchestrates a whole stack. It re-pins
// member SHAs at run start, reviews each member in dependency order as a
// normal pr_review job (same budgets, limits, and per-PR publishing), then
// re-checks every head and — only when nothing moved — runs one cumulative
// OpenCode pass for cross-PR breakage and posts the stack summary plus
// cross-PR findings on the top PR.
async function runStackJob(deps: PipelineDeps, forge: ForgeRegistry, jobId: number, signal: AbortSignal): Promise<void> {
  const { store, config } = deps;
  const job = store.getJob(jobId);
  if (!job) return;
  if (["stale", "cancelled"].includes(job.state)) {
    store.log(jobId, `Skipped run: job is ${job.state}`, "warn");
    return;
  }
  if (job.state === "completed") return;
  try {
    if (job.provider !== "github") {
      store.setJobState(jobId, "failed", {
        failure_reason: `stack reviews are not available for ${job.provider}:${job.provider_instance}`,
        finished_at: nowIso(),
      });
      return;
    }
    const auth = authorizeGithubTarget(config, {
      installationId: job.installation_id,
      accountId: job.github_account_id ?? undefined,
      repositoryId: job.github_repository_id ?? undefined,
    });
    if (!auth.ok) {
      logAuthorizationRejection({ installationId: job.installation_id, reason: auth.reason });
      store.setJobState(jobId, "failed", { failure_reason: `unauthorized: ${auth.reason}`, finished_at: nowIso() });
      return;
    }
    const provider = forge.forJob(job);
    const members = store.listStackMembers(jobId);
    if (!members.length) {
      store.setJobState(jobId, "failed", { failure_reason: "stack review has no recorded members", finished_at: nowIso() });
      return;
    }
    const stackId = job.dedup_key.startsWith("stack:") ? job.dedup_key.slice("stack:".length) : job.dedup_key;
    const memberTarget = (prNumber: number) => ({ ...forgeTargetOf(job), changeNumber: prNumber });
    store.setJobState(jobId, "preparing", { started_at: nowIso() });

    // Phase 1 — re-resolve and pin every member's base/head at run start.
    // Heads that moved before the run began simply update the pins; a move
    // detected later (pre-publish) marks the result stale instead.
    const meta = new Map<number, { title: string; body: string; htmlUrl: string; author: string }>();
    for (const member of members) {
      throwIfStale(store, jobId, signal);
      const change = await provider.getChange(memberTarget(member.pr_number));
      meta.set(member.pr_number, { title: change.title, body: change.body, htmlUrl: change.htmlUrl, author: change.author });
      if (change.baseSha !== member.base_sha || change.headSha !== member.head_sha) {
        store.patchStackMember(member.id, { baseSha: change.baseSha, headSha: change.headSha });
        member.base_sha = change.baseSha;
        member.head_sha = change.headSha;
        store.log(
          jobId,
          `Re-pinned #${member.pr_number} at ${change.headSha.slice(0, 8)} (base ${change.baseSha.slice(0, 8)}) before review`,
        );
      }
    }

    // Phase 2 — member reviews in dependency order. Each runs as a standard
    // pr_review job so the existing budget, concurrency, dedup, and publish
    // paths apply unchanged; a matching completed job is reused as-is.
    store.setJobState(jobId, "reviewing");
    const memberJobs: { member: (typeof members)[number]; jobId: number }[] = [];
    for (const member of members) {
      throwIfStale(store, jobId, signal);
      store.patchStackMember(member.id, { state: "reviewing" });
      const info = meta.get(member.pr_number)!;
      const enqueued = store.enqueue({
        repoFullName: job.repo_full_name,
        repoOwner: job.repo_owner,
        repoName: job.repo_name,
        installationId: job.installation_id,
        githubAccountId: job.github_account_id ?? undefined,
        githubRepositoryId: job.github_repository_id ?? undefined,
        prNumber: member.pr_number,
        prTitle: info.title,
        prBody: info.body,
        prHtmlUrl: info.htmlUrl,
        prAuthor: info.author,
        baseSha: member.base_sha,
        headSha: member.head_sha,
        baseRef: member.base_ref,
        headRef: member.head_ref,
        webhookDeliveryId: job.webhook_delivery_id ?? undefined,
        webhookEvent: "stack_review",
        reviewers: reviewerSpecs(config),
        jobType: "pr_review",
      });
      const memberJobId = enqueued.job.id;
      memberJobs.push({ member, jobId: memberJobId });
      store.patchStackMember(member.id, { memberJobId, state: "reviewing" });
      if (enqueued.created) {
        store.log(jobId, `Reviewing stack member #${member.pr_number} as job ${memberJobId}`);
        await runJob(deps, forge, memberJobId, signal);
      } else {
        store.log(
          jobId,
          `Stack member #${member.pr_number} reuses existing job ${memberJobId} (${enqueued.job.state})`,
        );
      }
      const outcome = await waitForJob(deps.store, memberJobId, jobId, signal);
      if (outcome !== "completed") {
        store.patchStackMember(member.id, { state: "failed" });
        throw new Error(`stack member #${member.pr_number} review ended ${outcome} (job ${memberJobId})`);
      }
      store.patchStackMember(member.id, { state: "done" });
    }

    // Phase 3 — re-check every head before anything stack-level is published.
    // A moved head makes this run's view inconsistent: mark it stale and post
    // nothing; the next trigger re-pins at run start instead.
    const diffs = new Map<number, string>();
    for (const member of members) {
      throwIfStale(store, jobId, signal);
      const change = await provider.getChange(memberTarget(member.pr_number));
      if (change.headSha !== member.head_sha) {
        store.setJobState(jobId, "stale", { finished_at: nowIso() });
        store.log(
          jobId,
          `PR #${member.pr_number} head moved ${member.head_sha.slice(0, 8)} → ${change.headSha.slice(0, 8)} after review; stack result stale, nothing published`,
          "warn",
        );
        return;
      }
      diffs.set(member.pr_number, await provider.getChangeDiff(memberTarget(member.pr_number), config.maxDiffBytes));
    }

    // Phase 4 — cumulative pass over the stack tip plus every member diff.
    const cumulativeRun = store.listReviewerRuns(jobId).find((entry) => entry.role === "stack_cumulative");
    const clone = await provider.cloneSpec(memberTarget(members[members.length - 1]!.pr_number), {
      anonymous: job.installation_id === 0,
    });
    const top = members[members.length - 1]!;
    const workspace = await deps.checkout.prepare({
      jobId,
      cloneUrl: clone.cloneUrl,
      gitAuthArgs: clone.gitAuthArgs,
      remoteRef: clone.remoteRef,
      secrets: [...clone.secrets, ...globalSecrets(config)],
      baseSha: top.head_sha,
      headSha: top.head_sha,
      signal,
      fetchDiff: async () => diffs.get(top.pr_number) ?? "",
      metadata: {
        repo: job.repo_full_name,
        pr: top.pr_number,
        title: job.pr_title,
        baseSha: top.head_sha,
        headSha: top.head_sha,
      },
    });
    store.patchJob(jobId, { workspace_path: workspace.dir });
    throwIfStale(store, jobId, signal);
    const cumulative = await runStackCumulativeRun(deps, job, cumulativeRun, workspace.repoDir, stackId, members, diffs, meta, signal);
    if (!cumulative) {
      throw new Error("stack cumulative pass failed");
    }

    // Phase 5 — publish the stack summary and each cross-PR finding as issue
    // comments on the top PR, naming every PR and SHA involved.
    store.setJobState(jobId, "publishing");
    const ordered = members
      .map((member) => `#${member.pr_number}@${member.head_sha.slice(0, 8)}`)
      .join(" → ");
    const summaryBody =
      `**Stack review "${stackId}"** — reviewed ${members.length} pull request(s) in order: ${ordered}.\n\n` +
      `Member reviews: ${memberJobs.map((entry) => `#${entry.member.pr_number} (job ${entry.jobId})`).join(", ")}.\n\n` +
      (cumulative.summary ? `${cumulative.summary}\n\n` : "") +
      `Cross-PR findings: ${cumulative.findings.length}.`;
    await postStackComment(deps, job, top.pr_number, summaryBody);
    for (const finding of cumulative.findings) {
      const location = finding.file ? `\`${finding.file}${finding.line ? `:${finding.line}` : ""}\`\n\n` : "";
      await postStackComment(
        deps,
        job,
        top.pr_number,
        `**Cross-PR finding (${finding.severity})** — ${finding.summary}\n\n${location}${finding.reason}\n\n_Stack "${stackId}" · members ${ordered}_`,
      );
    }
    store.setJobState(jobId, "completed", { finished_at: nowIso() });
    store.log(
      jobId,
      `Stack review completed: ${members.length} member(s), ${cumulative.findings.length} cross-PR finding(s)`,
    );
  } catch (error) {
    if (store.isStale(jobId) || signal.aborted) {
      const cancelled = store.getJob(jobId)?.state === "cancelled";
      store.log(jobId, cancelled ? "Stack review cancelled" : "Stack review aborted or marked stale", "warn");
      if (!store.isStale(jobId)) store.setJobState(jobId, "stale", { finished_at: nowIso() });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    for (const run of store.listReviewerRuns(jobId)) {
      if (run.state === "queued" || run.state === "running") {
        store.patchReviewer(run.id, {
          state: "failed",
          validation_error: "job ended before this run finished",
          finished_at: nowIso(),
        });
      }
    }
    store.setJobState(jobId, "failed", { failure_reason: message, finished_at: nowIso() });
    store.log(jobId, `Stack review failed: ${message}`, "error");
  }
}

/** Await a member review job; the stack job's own staleness/abort still wins. */
async function waitForJob(store: JobStore, memberJobId: number, stackJobId: number, signal: AbortSignal): Promise<string> {
  for (;;) {
    throwIfStale(store, stackJobId, signal);
    const member = store.getJob(memberJobId);
    if (!member) return "missing";
    if (["completed", "failed", "stale", "cancelled"].includes(member.state)) return member.state;
    await sleep(2000, signal);
  }
}

/** Post an issue comment on a member PR; absent the optional port the log records the text instead. */
async function postStackComment(deps: PipelineDeps, job: JobRow, prNumber: number, body: string): Promise<void> {
  if (typeof deps.github.createIssueComment !== "function") {
    deps.store.log(job.id, `Stack comment for #${prNumber} not posted (no issue-comment port): ${body.slice(0, 200)}`, "warn");
    return;
  }
  try {
    await deps.github.createIssueComment({
      installationId: job.installation_id,
      owner: job.repo_owner,
      repo: job.repo_name,
      pullNumber: prNumber,
      body,
    });
  } catch (error) {
    deps.store.log(
      job.id,
      `Stack comment for #${prNumber} failed: ${error instanceof Error ? error.message : error}`,
      "warn",
    );
  }
}

/** The cumulative OpenCode pass; retries follow the standard reviewer budget. */
async function runStackCumulativeRun(
  deps: PipelineDeps,
  job: JobRow,
  run: ReviewerRunRow | undefined,
  cwd: string,
  stackId: string,
  members: { pr_number: number; base_sha: string; head_sha: string }[],
  diffs: Map<number, string>,
  meta: Map<number, { title: string }>,
  signal: AbortSignal,
): Promise<ReviewerResult | undefined> {
  const model = run?.model || deps.config.chat.model || deps.config.opencode.reviewerModel;
  const retries = Math.max(0, deps.config.opencode.maxRetries);
  const prompt = buildStackCumulativePrompt({
    repoFullName: job.repo_full_name,
    stackId,
    members: members.map((member) => ({
      prNumber: member.pr_number,
      prTitle: meta.get(member.pr_number)?.title ?? "",
      baseSha: member.base_sha,
      headSha: member.head_sha,
      diff: truncate(diffs.get(member.pr_number) ?? "(diff unavailable)", Math.max(10_000, deps.config.maxDiffBytes)),
    })),
  });
  let lastError = "unknown error";
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    throwIfStale(deps.store, job.id, signal);
    const started = Date.now();
    if (run) {
      deps.store.patchReviewer(run.id, {
        state: "running",
        attempt,
        model: model || null,
        provider: model.includes("/") ? model.split("/")[0] : null,
        started_at: nowIso(),
      });
    }
    deps.store.log(job.id, `Stack cumulative attempt ${attempt}/${retries + 1} model=${model || "(default)"}`, "info", run?.id);
    let result: OpenCodeRunResult | undefined;
    try {
      result = await deps.opencode.run({
        cwd,
        model,
        prompt,
        files: [],
        timeoutMs: deps.config.chat.timeoutMs,
        extraArgs: deps.config.opencode.extraArgs,
        bin: deps.config.opencode.bin,
        title: `maomao-stack-${job.id}`,
        signal,
      });
      const parsed = parseReviewerResult(result.text || result.stdout, "stack_cumulative");
      if (run) {
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
      }
      deps.store.log(job.id, `Stack cumulative done: ${parsed.findings.length} cross-PR finding(s)`, "info", run?.id);
      return parsed;
    } catch (error) {
      lastError = formatError(error);
      if (run) {
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
      }
      deps.store.log(job.id, `Stack cumulative attempt ${attempt} failed: ${lastError}`, "warn", run?.id);
      if (attempt <= retries) await sleep(500 * attempt, signal);
    }
  }
  return undefined;
}

/**
 * The single OpenCode run behind a repo brief. Shares the reviewers' deny list
 * (applied in opencode spawn for every run) and the Ask budget knob: timeout
 * comes from `config.chat` so briefs and Ask are bounded the same way.
 */
async function runBriefRun(
  deps: PipelineDeps,
  job: JobRow,
  run: ReviewerRunRow,
  cwd: string,
  signal: AbortSignal,
): Promise<BriefResult | undefined> {
  // The run's stored model wins; otherwise follow the Ask model, then the
  // generic reviewer default.
  const model = run.model || deps.config.chat.model || deps.config.opencode.reviewerModel;
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
    deps.store.log(job.id, `Repo brief attempt ${attempt}/${retries + 1} model=${model || "(default)"}`, "info", run.id);

    let result: OpenCodeRunResult | undefined;
    try {
      result = await deps.opencode.run({
        cwd,
        model,
        prompt: buildBriefPrompt({ repoFullName: job.repo_full_name, sha: job.head_sha }),
        files: [],
        timeoutMs: deps.config.chat.timeoutMs,
        extraArgs: deps.config.opencode.extraArgs,
        bin: deps.config.opencode.bin,
        title: `maomao-brief-${job.id}`,
        signal,
        onStdout: (chunk) => {
          if (chunk.includes("error")) deps.store.log(job.id, chunk.slice(0, 500), "debug", run.id);
        },
      });
      const parsed = parseBriefResult(result.text || result.stdout);
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
      deps.store.log(job.id, `Repo brief done: ${parsed.sections.length} section(s)`, "info", run.id);
      if (result.usage.complete === false && result.usage.warning) {
        deps.store.log(job.id, result.usage.warning, "warn", run.id);
      }
      return parsed;
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
        `Repo brief attempt ${attempt} failed: ${lastError}${cliDump ? ` — ${cliDump}` : ""}`,
        "warn",
        run.id,
      );
      if (attempt <= retries) await sleep(500 * attempt, signal);
    }
  }
  return undefined;
}

function globalSecrets(config: Config): string[] {
  return [config.github.privateKey, config.github.webhookSecret].filter((value) => value.length > 4);
}

function throwIfStale(store: JobStore, jobId: number, signal: AbortSignal): void {
  if (signal.aborted || store.isStale(jobId)) {
    throw new Error("stale");
  }
}

function persistDecision(
  store: JobStore,
  jobId: number,
  decision: RoutingDecision,
  poisonAlertPolicy: string | null,
  extra: Partial<JobRow> = {},
): void {
  const reason = sanitizePublicReason(decision.reason, 300) || "router decision";
  // Record the escalation policy as soon as the profile is known, so the UI can show the
  // planned channels while the job is still running (not only after dispatch).
  store.patchJob(jobId, {
    ...extra,
    poison_alert_policy: decision.profile === "poison-alert" ? poisonAlertPolicy : null,
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
  profileBudget?: ProfileBudget,
): Promise<void> {
  const { store, config } = deps;
  const existing = store.listReviewerRuns(job.id);
  const allowlist = config.reviewers.map((role) => role.id);

  if (config.routing.mode === "fixed") {
    if (existing.length === 0) {
      store.ensureReviewerRuns(job.id, applyProfileToSpecs(store, config, reviewerSpecs(config), job.profile_revision_id));
    }
    const roles = store.listReviewerRuns(job.id).map((run) => run.role);
    persistDecision(store, job.id, {
      profile: "diagnosis",
      reviewers: roles,
      reason: "Fixed reviewer set from configuration",
      confidence: 1,
      source: "fixed",
      signals: scanRoutingSignals({ diff, title: job.pr_title, body: job.pr_body }),
      hardRuleEscalated: false,
    }, null, { routing_mode: "fixed" });
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
    }, null, { routing_mode: config.routing.mode });
    store.log(job.id, `Routing recorded preselected reviewers: ${roles.join(", ")}`);
    return;
  }

  store.setJobState(job.id, "routing", { routing_state: "running", routing_mode: config.routing.mode });
  const signals = scanRoutingSignals({ diff, title: job.pr_title, body: job.pr_body });
  let decision: RoutingDecision;
  const profileRouterModel = profileDefinitionForJob(store, job)?.routerModel;
  const routerModel = profileRouterModel || config.routing.model || config.opencode.reviewerModel;
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
      profileBudget?.record(result.usage.cost, result.usage.totalTokens);
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

  persistDecision(
    store,
    job.id,
    decision,
    decision.profile === "poison-alert" ? config.poisonAlert.policy : null,
    { routing_mode: config.routing.mode },
  );
  store.ensureReviewerRuns(
    job.id,
    applyProfileToSpecs(store, config, reviewerSpecs(config, decision.reviewers), job.profile_revision_id),
  );
  store.log(
    job.id,
    `Routed profile=${decision.profile} source=${decision.source} reviewers=${decision.reviewers.join(", ")} reason=${decision.reason}`,
  );
}

async function reconcileAndRoute(
  deps: PipelineDeps,
  forge: ForgePort,
  job: JobRow,
  repoDir: string,
  workspaceDir: string,
  diff: string,
  signal: AbortSignal,
  profileBudget?: ProfileBudget,
): Promise<ReconciliationSnapshot> {
  deps.store.setJobState(job.id, "reconciling");
  const threads = await forge.listDiscussions(forgeTargetOf(job));
  const humanOverrides = await loadHumanOverrides(deps, forge, job, threads);
  persistFingerprintOverrides(deps, job, humanOverrides);
  if (humanOverrides.commentCount > 0 || humanOverrides.overrides.length > 0) {
    deps.store.log(
      job.id,
      `Human discussion: ${humanOverrides.commentCount} non-Maomao comment(s), ${humanOverrides.overrides.length} allowlisted dismiss signal(s)`,
    );
  }
  const stored = deps.store.listFindings(job.repo_full_name, job.pr_number, scopeOf(job));
  const priors = collectPriorFindings({ threads, stored });
  deps.store.log(
    job.id,
    `Reconciling ${priors.length} prior finding(s) for ${job.repo_full_name}#${job.pr_number} @ ${job.head_sha}`,
  );
  const items = await classifyPriorFindings({
    onVerifierError: (message) => deps.store.log(job.id, `Verifier failed: ${message}`, "warn"),
    config: deps.config,
    opencode: deps.opencode,
    job,
    repoDir,
    diff,
    workspaceDir,
    priors,
    signal,
    budgetBlock: profileBudget ? () => profileBudget.check() : undefined,
    onVerifierUsage: profileBudget
      ? (usage) => profileBudget.record(usage.cost, usage.totalTokens)
      : undefined,
  });
  const snapshot: ReconciliationSnapshot = { headSha: job.head_sha, items, humanOverrides };
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
  profileTimeoutMs?: number,
  profileBudget?: ProfileBudget,
  humanOverrides?: HumanOverrideContext,
): Promise<void> {
  const role = deps.config.reviewers.find((item) => item.id === run.role);
  // The run's stored model (profile revision / enqueue spec) wins over config defaults.
  const model = run.model || role?.model || deps.config.opencode.reviewerModel;
  // An active prompt revision overrides the role's authored body; guardrails stay composed here.
  const promptRevision = deps.store.prompts.getActivePrompt(run.role);
  if (promptRevision) {
    deps.store.patchReviewer(run.id, { prompt_revision_id: promptRevision.id });
  }
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
        promptBody: promptRevision?.body,
        humanOverrideDigest: humanOverrides?.digest,
      });
      result = await deps.opencode.run({
        cwd,
        model,
        prompt,
        files,
        timeoutMs: profileTimeoutMs ?? deps.config.opencode.timeoutMs,
        extraArgs: deps.config.opencode.extraArgs,
        bin: deps.config.opencode.bin,
        title: `maomao-${run.role}-${job.id}`,
        signal,
        onStdout: (chunk) => {
          if (chunk.includes("error")) deps.store.log(job.id, chunk.slice(0, 500), "debug", run.id);
        },
      });
      const parsed = parseReviewerResult(result.text || result.stdout, run.role, (dropped) => {
        deps.store.log(job.id, `Reviewer ${run.role} dropped ${dropped} placeholder finding(s); raw output preserved`, "warn");
      });
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
      profileBudget?.record(result.usage.cost, result.usage.totalTokens);
      return;
    } catch (error) {
      lastError = formatError(error);
      const cliDump = result ? truncate(result.stderr.trim() || result.stdout.trim(), 500) : "";
      // Failed attempts still spent tokens/cost; on a later retry the run row
      // is overwritten, so the tracker must absorb partial usage per attempt.
      if (result) profileBudget?.record(result.usage.cost, result.usage.totalTokens);
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
      if (attempt <= retries) {
        await sleep(500 * attempt, signal);
        // A spent attempt may have tripped the ceiling; do not respend.
        const over = profileBudget?.check();
        if (over) {
          deps.store.log(job.id, `Reviewer ${run.role} retries stopped: ${over}`, "warn", run.id);
          break;
        }
      }
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
  profileBudget?: ProfileBudget,
  humanOverrides?: HumanOverrideContext,
): Promise<AggregatorResult> {
  const model = deps.config.opencode.aggregatorModel || deps.config.opencode.reviewerModel;
  const started = Date.now();
  // Hoisted so the catch can preserve the raw output for debugging.
  let result: Awaited<ReturnType<OpenCodePort["run"]>> | undefined;
  try {
    result = await deps.opencode.run({
      cwd,
      model,
      prompt: buildAggregatorPrompt({
        repoFullName: job.repo_full_name,
        prNumber: job.pr_number,
        prTitle: job.pr_title,
        baseSha: job.base_sha,
        headSha: job.head_sha,
        reviewerEvidence: reviewers,
        humanOverrideDigest: humanOverrides?.digest,
      }),
      files,
      timeoutMs: deps.config.opencode.timeoutMs,
      extraArgs: deps.config.opencode.extraArgs,
      bin: deps.config.opencode.bin,
      title: `maomao-aggregator-${job.id}`,
      signal,
    });
    const parsed = parseAggregatorResult(result.text || result.stdout, (dropped) => {
      deps.store.log(job.id, `Aggregator dropped ${dropped} placeholder finding(s); raw output preserved`, "warn");
    });
    deps.store.patchJob(job.id, {
      aggregator_raw: truncate(result.text || result.stdout, 200_000),
      aggregator_normalized: JSON.stringify(parsed, null, 2),
      aggregator_model: model || null,
      aggregator_provider: model.includes("/") ? model.split("/")[0] : null,
      aggregator_state: "done",
      aggregator_fallback: 0,
      aggregator_finished_at: nowIso(),
      aggregator_duration_ms: Date.now() - started,
      ...aggregatorUsagePersistence(result.usage),
    });
    profileBudget?.record(result.usage.cost, result.usage.totalTokens);
    return parsed;
  } catch (error) {
    const message = formatError(error);
    deps.store.log(job.id, `Aggregator OpenCode run failed (${message}); using deterministic fallback`, "warn");
    // A run that executed but failed to parse still spent usage; the columns are
    // not persisted on this path, so account the spend straight from the result.
    if (result) profileBudget?.record(result.usage.cost, result.usage.totalTokens);
    return applyAggregatorFallback(
      deps.store,
      job.id,
      model || null,
      reviewers,
      // Preserve the model's output for debugging; the reason is in the log above.
      truncate(result?.text || result?.stdout || "", 200_000),
      Date.now() - started,
    );
  }
}

async function runInternalEscalation(
  deps: PipelineDeps,
  job: JobRow,
  firstPass: AggregatorResult,
  diff: string,
  cwd: string,
  signal: AbortSignal,
  profileBudget?: ProfileBudget,
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

  // The lab model runs as its own stage so the UI can say "Sniffing" instead of "Aggregating".
  deps.store.setJobState(job.id, "sniffing");
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
  // Hoisted so the catch can account usage from a run that executed but threw.
  let result: Awaited<ReturnType<OpenCodePort["run"]>> | undefined;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    throwIfStale(deps.store, job.id, signal);
    result = undefined;
    try {
      result = await deps.opencode.run({
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
      // Count the spend whether the pass clears the alert or breaks on its own cap.
      profileBudget?.record(usage.cost, usage.total_tokens);
      if (over) {
        deps.store.log(job.id, over, "warn");
        lastError = over;
        break;
      }
      const parsed = parseInternalEscalationResult(result.text || result.stdout, (dropped) => {
        deps.store.log(job.id, `Internal escalation dropped ${dropped} placeholder finding(s); raw output preserved`, "warn");
      });
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
      // The attempt executed and may have spent on the profile budget even
      // though its output was unusable.
      if (result) profileBudget?.record(result.usage.cost, result.usage.totalTokens);
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
  forge: ForgePort,
  job: JobRow,
  aggregated: AggregatorResult,
  reviewerCount: number,
  snapshot: ReconciliationSnapshot,
  diff: string,
  signal: AbortSignal,
): Promise<{ id: string; url: string; postedFingerprints: string[] } | undefined> {
  if (deps.store.isStale(job.id)) return undefined;
  const target = forgeTargetOf(job);

  const existing: ForgeSummary[] = await forge.listSummaries(target);
  const already = findExistingReview(existing, job.head_sha);
  if (already) {
    deps.store.log(job.id, `Review already exists for ${job.head_sha}; skipping publish`);
    deps.store.patchJob(job.id, {
      review_event: "COMMENT",
      review_event_reason: "existing maomao review found by marker",
    });
    return { ...already, postedFingerprints: [] };
  }

  let publishable = findingsForPublish(aggregated.findings, snapshot);
  const overridden = omitOverriddenFindings(publishable, snapshot.humanOverrides?.overrides ?? []);
  for (const entry of overridden.suppressed) {
    deps.store.dismissFinding({
      repoFullName: job.repo_full_name,
      prNumber: job.pr_number,
      scope: scopeOf(job),
      fingerprint: entry.finding.fingerprint,
      actor: entry.override.author,
      command: entry.override.signal,
      reviewedSha: job.head_sha,
      summary: entry.finding.summary,
      path: entry.finding.file,
      line: entry.finding.line,
      category: entry.finding.category,
      severity: entry.finding.severity,
      body: entry.finding.body,
    });
    deps.store.log(
      job.id,
      `Omitting ${entry.finding.category ?? "finding"} ${entry.finding.fingerprint} (${entry.finding.file ?? "?"}:${entry.finding.line ?? "?"}): ${entry.override.signal} by ${entry.override.author}`,
    );
  }
  publishable = overridden.kept;
  // severityRank is inverted (blocker=0), so "at or above" the minimum means rank <= threshold.
  const profileDefinition = profileDefinitionForJob(deps.store, job);
  if (profileDefinition) {
    const threshold = severityRank(profileDefinition.minPublishableSeverity);
    publishable = publishable.filter(
      (finding) => severityRank((finding.severity ?? "info") as Severity) <= threshold,
    );
  }
  const dismissedCount = snapshot.items.filter((item) => item.status === "dismissed").length;
  if (dismissedCount > 0) {
    deps.store.log(job.id, `Omitting ${dismissedCount} dismissed finding(s) from this review`);
  }
  const findingsCount = publishable.length;
  // A review only counts as clean when the aggregator said so AND nothing survived filtering.
  const clean = findingsCount === 0 && aggregated.verdict === "clean";

  // Only the orchestrator selects the GitHub event; specialists never do.
  const runs = deps.store.listReviewerRuns(job.id);
  const allReviewersDone = runs.length > 0 && runs.every((run) => run.state === "done" && !run.validation_error);
  const aggregatorFallback = (deps.store.getJob(job.id)?.aggregator_fallback ?? 0) === 1;
  const decision = resolveReviewEvent({
    allowApprove: deps.config.reviewAllowApprove,
    allowRequestChanges: deps.config.reviewAllowRequestChanges,
    minSeverity: deps.config.reviewRequestChangesMinSeverity,
    clean,
    findings: publishable,
    allReviewersDone,
    aggregatorFallback,
    stale: deps.store.isStale(job.id),
  });

  if (clean && !deps.config.postEmptyReview) {
    const reason = `${decision.reason}; not posting because POST_EMPTY_REVIEW is false`;
    deps.store.log(job.id, `Clean review with no findings; POST_EMPTY_REVIEW is false, not posting`);
    deps.store.patchJob(job.id, { review_event: "COMMENT", review_event_reason: reason });
    return undefined;
  }

  deps.store.log(job.id, `Review event: ${decision.event} (${decision.reason})`);

  const { comments, demoted } = selectInlineComments(publishable, {
    limit: deps.config.maxInlineComments,
    headSha: job.head_sha,
    diff,
  });
  for (const entry of demoted) {
    deps.store.log(
      job.id,
      `Finding not shown inline: ${entry.finding.file}:${entry.finding.line} is not in the diff (${entry.reason}); listing it in the review body`,
      "warn",
    );
  }
  const body = buildReviewBody({
    headSha: job.head_sha,
    summary: aggregated.summary,
    findingsCount,
    reviewerCount,
    demoted,
  });
  // Re-check staleness after the decision: an APPROVE must never land on a superseded SHA.
  throwIfStale(deps.store, job.id, signal);
  const posted = await forge.publishReview({
    target,
    commitId: job.head_sha,
    body,
    comments,
    verdict: decision.event satisfies ForgeVerdict,
  });
  // Record the event only after the forge accepted the review, so a recorded event
  // always corresponds to a delivered one.
  deps.store.patchJob(job.id, {
    review_event: decision.event,
    review_event_reason: decision.reason,
  });
  // Fingerprints of what the forge actually accepted, not what we intended:
  // publishReview degrades to a body-only review when inline locations are rejected.
  const postedFingerprints = inlineCommentFingerprints(posted.postedComments ?? comments);
  for (const warning of posted.warnings ?? []) {
    deps.store.log(job.id, warning, "warn");
  }
  return { ...posted, postedFingerprints };
}

async function dispatchExternalEscalation(
  deps: PipelineDeps,
  job: JobRow,
  aggregated: AggregatorResult | undefined,
): Promise<void> {
  const config = deps.config.poisonAlert;
  const latest = deps.store.getJob(job.id) ?? job;
  // External pages must never fire for a job that was cancelled or superseded
  // while the pipeline was between checkpoints (completed jobs still dispatch);
  // the target loop below re-checks per iteration.
  if (latest.state === "stale" || latest.state === "cancelled") {
    deps.store.log(latest.id, `External dispatch skipped: job is ${latest.state}`, "warn");
    return;
  }
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

  const scope = scopeOf(latest);
  const provider = scope.provider;
  const instance = scope.instance;
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
    // The loop is not a checkpoint: a merge or cancellation landing between
    // targets must stop the remaining pages, not just the first one.
    if (deps.store.isStale(latest.id)) {
      deps.store.log(latest.id, `External dispatch aborted: job became ${deps.store.getJob(latest.id)?.state ?? "stale"} mid-dispatch`, "warn");
      return;
    }
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
  // ZodError.message is an unbounded multi-line JSON dump; formatSchemaError
  // keeps validation_error/failure_reason to bounded field paths.
  return formatSchemaError(error);
}

async function loadHumanOverrides(
  deps: PipelineDeps,
  forge: ForgePort,
  job: JobRow,
  threads: ForgeDiscussion[],
): Promise<HumanOverrideContext> {
  try {
    return await collectHumanOverrides({
      forge,
      config: deps.config,
      job,
      threads,
    });
  } catch (error) {
    deps.store.log(job.id, `Could not load PR comments for overrides: ${formatError(error)}`, "warn");
    return emptyOverrideContext();
  }
}

function persistFingerprintOverrides(
  deps: PipelineDeps,
  job: JobRow,
  context: HumanOverrideContext,
): void {
  if (context.overrides.length === 0) return;
  const stored = deps.store.listFindings(job.repo_full_name, job.pr_number, scopeOf(job));
  const byFingerprint = new Map(stored.map((row) => [row.fingerprint, row]));
  for (const override of context.overrides) {
    if (!override.fingerprint) continue;
    const row = byFingerprint.get(override.fingerprint);
    if (
      isProtectedFinding({
        category: row?.category ?? undefined,
        summary: row?.summary || override.quote,
        body: row?.body ?? undefined,
      })
    ) {
      continue;
    }
    deps.store.dismissFinding({
      repoFullName: job.repo_full_name,
      prNumber: job.pr_number,
      scope: scopeOf(job),
      fingerprint: override.fingerprint,
      actor: override.author,
      command: override.signal,
      reviewedSha: job.head_sha,
      summary: row?.summary || override.quote || override.fingerprint,
      path: override.path ?? row?.current_path,
      line: override.line ?? row?.current_line,
      category: row?.category,
      severity: row?.severity,
      body: row?.body,
      githubThreadId: row?.github_thread_id,
      githubCommentId: row?.github_comment_id,
    });
  }
}
