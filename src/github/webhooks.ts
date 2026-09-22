import { verify } from "@octokit/webhooks-methods";
import type { Config, PullRequestAction } from "../config.js";
import { canIssueOverride, parseOverrideCommand } from "../findings/commands.js";
import {
  isMaomaoLogin,
  isMaomaoThread,
  findingComment,
  parseThreadFindingMarker,
  threadContainsComment,
  type GithubPort,
  type ManualTriggerPort,
  type ReviewThread,
} from "./client.js";
import type { EnqueueResult, JobStore } from "../jobs/store.js";
import { enqueuePullJob } from "../jobs/enqueue.js";
import { parseStackCommand, validateStackMembers, type StackCommand } from "../stacks/commands.js";
import type { ResolvedPull } from "./client.js";
import { cancelJobsForPull } from "../jobs/cancel.js";
import { logAuthorizationRejection, logRateLimited, positiveGithubId, rejectUnauthorized } from "./authorize.js";
import { describeThreadResolveError } from "./errors.js";
import { repoRateLimitActive, type RepoRateLimiter } from "./rate-limit.js";
import {
  commentLooksLikeMaomaoEscalation,
  isBotActor,
  mentionsEscalateCommand,
} from "../routing/escalation.js";

export interface WebhookRequest {
  event: string;
  deliveryId: string;
  signature: string;
  rawBody: string;
}

export type WebhookHandleResult = {
  status: number;
  body: Record<string, unknown>;
  enqueue?: EnqueueResult;
  dispatchJobId?: number;
};

export interface IssueCommentWebhookPayload {
  action?: string;
  installation?: { id?: number; account?: { id?: number } };
  repository?: {
    id?: number;
    full_name?: string;
    name?: string;
    owner?: { login?: string; id?: number };
  };
  issue?: {
    number?: number;
    pull_request?: { url?: string };
  };
  comment?: {
    id?: number;
    body?: string | null;
    user?: { login?: string; type?: string };
    author_association?: string;
  };
  sender?: { login?: string; type?: string };
}

export interface ReviewCommentWebhookPayload {
  action?: string;
  installation?: { id?: number };
  repository?: {
    full_name?: string;
    name?: string;
    owner?: { login?: string };
  };
  pull_request?: {
    number?: number;
    head?: { sha?: string };
  };
  comment?: {
    id?: number;
    node_id?: string;
    body?: string;
    path?: string | null;
    in_reply_to_id?: number | null;
    user?: { login?: string };
    author_association?: string;
  };
}

export interface PullRequestWebhookPayload {
  action?: string;
  installation?: { id?: number; account?: { id?: number } };
  repository?: {
    id?: number;
    full_name?: string;
    name?: string;
    owner?: { login?: string; id?: number };
  };
  pull_request?: {
    number?: number;
    title?: string;
    body?: string | null;
    html_url?: string;
    draft?: boolean;
    merged?: boolean;
    user?: { login?: string };
    base?: { sha?: string; ref?: string };
    head?: { sha?: string; ref?: string };
  };
}

export async function verifyGithubSignature(secret: string, rawBody: string, signature: string): Promise<boolean> {
  if (!secret || !signature) return false;
  try {
    return await verify(secret, rawBody, signature);
  } catch {
    return false;
  }
}

export function shouldHandlePullRequest(config: Config, payload: PullRequestWebhookPayload): {
  handle: boolean;
  reason?: string;
} {
  const action = payload.action as PullRequestAction | undefined;
  if (!action || !config.pullRequestActions.includes(action)) {
    return { handle: false, reason: `ignored action ${payload.action ?? "unknown"}` };
  }
  if (payload.pull_request?.draft && !config.reviewDrafts) {
    return { handle: false, reason: "ignored draft pull request" };
  }
  return { handle: true };
}

function numericId(value: unknown): number | undefined {
  return positiveGithubId(value);
}

export function parsePullRequestPayload(payload: PullRequestWebhookPayload): {
  installationId: number;
  githubAccountId?: number;
  githubRepositoryId?: number;
  repoFullName: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prTitle: string;
  prBody: string;
  prHtmlUrl: string;
  prAuthor: string;
  baseSha: string;
  headSha: string;
  baseRef: string;
  headRef: string;
} {
  const installationId = numericId(payload.installation?.id);
  const githubAccountId =
    numericId(payload.installation?.account?.id) ?? numericId(payload.repository?.owner?.id);
  const githubRepositoryId = numericId(payload.repository?.id);
  const repoOwner = payload.repository?.owner?.login;
  const repoName = payload.repository?.name;
  const repoFullName = payload.repository?.full_name;
  const pr = payload.pull_request;
  if (!installationId || !repoOwner || !repoName || !repoFullName || !pr?.number || !pr.head?.sha || !pr.base?.sha) {
    throw new Error("webhook payload missing installation, repository, or pull request SHAs");
  }
  return {
    installationId,
    githubAccountId,
    githubRepositoryId,
    repoFullName,
    repoOwner,
    repoName,
    prNumber: pr.number,
    prTitle: pr.title ?? "",
    prBody: pr.body ?? "",
    prHtmlUrl: pr.html_url ?? "",
    prAuthor: pr.user?.login ?? "",
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    baseRef: pr.base.ref ?? "",
    headRef: pr.head.ref ?? "",
  };
}

function ignored(reason: string): WebhookHandleResult {
  return { status: 202, body: { ok: true, ignored: true, reason } };
}

/**
 * `pull_request.closed` with the authoritative `merged: true` flag: cancel every
 * non-terminal review job for that repository + PR (all head SHAs) through the
 * centralized cancellation service, and record the merge itself so later push
 * deliveries cannot enqueue work for the merged pull. Fails safe — an
 * incomplete payload or an uncertain merge state cancels nothing. Matches on
 * repo full name; a rename between enqueue and merge cancels nothing wrong,
 * but surviving jobs may still post to the merged pull.
 */
function handlePullClosed(
  input: {
    config: Config;
    store: JobStore;
    request: WebhookRequest;
    abortJobs?: (jobIds: number[]) => void;
  },
  payload: PullRequestWebhookPayload,
): WebhookHandleResult {
  const installationId = numericId(payload.installation?.id);
  const githubAccountId =
    numericId(payload.installation?.account?.id) ?? numericId(payload.repository?.owner?.id);
  const githubRepositoryId = numericId(payload.repository?.id);
  const repoOwner = payload.repository?.owner?.login;
  const repoName = payload.repository?.name;
  const repoFullName = payload.repository?.full_name;
  const prNumber = payload.pull_request?.number;
  if (!installationId || !repoOwner || !repoName || !repoFullName || !prNumber) {
    if (payload.pull_request?.merged === true) {
      // A merged pull we could not bind to an installation/repo left jobs
      // running with a 2xx answer; that must be visible somewhere.
      console.warn(
        `webhook: merged pull_request.closed payload missing context; nothing cancelled (delivery ${input.request.deliveryId || "unknown"})`,
      );
    }
    return ignored("closed payload missing installation, repository, or pull request context");
  }
  // Never infer a merge from the PR merely being closed.
  if (payload.pull_request?.merged !== true) {
    return ignored("pull request closed without merge");
  }
  const auth = rejectUnauthorized(input.config, {
    installationId,
    accountId: githubAccountId,
    repositoryId: githubRepositoryId,
  });
  if (!auth.ok) {
    return ignored(auth.reason);
  }
  if (input.store.hasWebhookDelivery(input.request.deliveryId)) {
    return { status: 200, body: { ok: true, duplicate: true, reason: "duplicate delivery" } };
  }
  const deliveryId = input.request.deliveryId;
  // Record the merge before cancelling: the marker must exist even when no
  // job was active at merge time (the common case), because the enqueue gate
  // reads it and merged pulls cannot be reopened.
  input.store.markPullMerged(repoFullName, prNumber, deliveryId || null);
  const { cancelledJobIds } = cancelJobsForPull(input.store, {
    repoFullName,
    prNumber,
    reason: "pr_merged",
    note: deliveryId ? `webhook delivery ${deliveryId}` : undefined,
    // Abort in-memory work before anything below can fail: cancellation is
    // idempotent, so a redelivery after a mid-handler crash retries safely.
    onCancelled: input.abortJobs,
  });
  // Claim only after cancelling: a crash in between must let the redelivery
  // retry, not report duplicate.
  input.store.claimWebhookDelivery(deliveryId, input.request.event, "pr_merged_cancel");
  return {
    status: 200,
    body: { ok: true, cancelled: cancelledJobIds.length, cancelledJobIds, repoFullName, prNumber },
  };
}

export async function handleGithubWebhook(input: {
  config: Config;
  store: JobStore;
  request: WebhookRequest;
  rateLimiter?: RepoRateLimiter;
  github?: GithubPort & Partial<ManualTriggerPort>;
  /** Queue hook so cancelled jobs are dropped from memory before the claim/audit steps. */
  abortJobs?: (jobIds: number[]) => void;
}): Promise<WebhookHandleResult> {
  const valid = await verifyGithubSignature(
    input.config.github.webhookSecret,
    input.request.rawBody,
    input.request.signature,
  );
  if (!valid) {
    return { status: 401, body: { error: "invalid signature" } };
  }

  if (input.request.event === "ping") {
    return { status: 200, body: { ok: true, event: "ping" } };
  }

  if (input.request.event === "issue_comment") {
    return await handleIssueComment(input);
  }

  if (input.request.event === "pull_request_review_comment") {
    return handleReviewCommentWebhook(input);
  }

  if (input.request.event !== "pull_request") {
    return ignored(`event ${input.request.event}`);
  }

  let payload: PullRequestWebhookPayload;
  try {
    payload = JSON.parse(input.request.rawBody) as PullRequestWebhookPayload;
  } catch {
    return { status: 400, body: { error: "invalid JSON" } };
  }

  if (payload.action === "closed") {
    return handlePullClosed(input, payload);
  }

  const decision = shouldHandlePullRequest(input.config, payload);
  if (!decision.handle) {
    return ignored(decision.reason ?? "ignored");
  }

  try {
    const parsed = parsePullRequestPayload(payload);
    const auth = rejectUnauthorized(input.config, {
      installationId: parsed.installationId,
      accountId: parsed.githubAccountId,
      repositoryId: parsed.githubRepositoryId,
    });
    if (!auth.ok) {
      return ignored(auth.reason);
    }

    // GitHub does not guarantee delivery order: a delayed or redelivered push
    // event arriving after the merge must not enqueue fresh work for a merged
    // pull. The marker is written by every verified merged close (even with
    // zero active jobs) and merged pulls cannot be reopened, so the gate is
    // permanent. Keyed by repo full name, so a rename slips past it.
    if (input.store.hasMergedPull(parsed.repoFullName, parsed.prNumber)) {
      console.warn(
        `webhook: ignoring ${input.request.event}.${payload.action} for merged ${parsed.repoFullName}#${parsed.prNumber} (delivery ${input.request.deliveryId || "unknown"})`,
      );
      return ignored("pull request already merged; not enqueueing");
    }

    // Timed repository pause (issue #99): while active, automatic
    // pull_request deliveries enqueue nothing and spend nothing. The skip is
    // claimed on the delivery row (idempotent across redelivery) and logged;
    // manual forms, scans, briefs, and stack commands are unaffected. An
    // expired pause falls through with no backfill of intermediate SHAs.
    const pause = input.store.getActivePause(parsed.repoFullName);
    if (pause) {
      input.store.claimWebhookDelivery(
        input.request.deliveryId,
        input.request.event,
        `paused (expires ${pause.expires_at})`,
      );
      console.warn(
        `webhook: skipped ${input.request.event}.${payload.action} for paused ${parsed.repoFullName} ` +
          `(pause expires ${pause.expires_at}, delivery ${input.request.deliveryId || "unknown"})`,
      );
      return ignored(`automatic reviews paused until ${pause.expires_at}`);
    }

    const rateOn = repoRateLimitActive(input.config.repoRateLimitPerWindow, input.config.repoRateWindowMs);
    if (rateOn) {
      if (parsed.githubRepositoryId == null) {
        logAuthorizationRejection({
          installationId: parsed.installationId,
          reason: "missing repository id",
        });
        return ignored("missing repository id");
      }
      if (
        input.rateLimiter &&
        !input.rateLimiter.wouldAllow(
          parsed.githubRepositoryId,
          input.config.repoRateLimitPerWindow,
          input.config.repoRateWindowMs,
        )
      ) {
        logRateLimited({
          installationId: parsed.installationId,
          repositoryId: parsed.githubRepositoryId,
        });
        return ignored("rate limited");
      }
    }

    const enqueue = enqueuePullJob(input.store, input.config, {
      ...parsed,
      webhookDeliveryId: input.request.deliveryId,
      webhookEvent: `${input.request.event}.${payload.action}`,
    });
    if (
      enqueue.created &&
      rateOn &&
      parsed.githubRepositoryId != null &&
      input.rateLimiter
    ) {
      input.rateLimiter.record(
        parsed.githubRepositoryId,
        input.config.repoRateLimitPerWindow,
        input.config.repoRateWindowMs,
      );
    }
    return {
      status: enqueue.created ? 202 : 200,
      body: {
        ok: true,
        jobId: enqueue.job.id,
        created: enqueue.created,
        skippedReason: enqueue.skippedReason,
        staleJobIds: enqueue.staleJobIds,
        headSha: enqueue.job.head_sha,
      },
      enqueue,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `webhook: enqueue failed for ${input.request.event}.${payload.action} delivery ${input.request.deliveryId || "unknown"}: ${message}`,
    );
    return {
      status: 400,
      body: { error: message },
    };
  }
}

async function handleIssueComment(input: {
  config: Config;
  store: JobStore;
  request: WebhookRequest;
  github?: GithubPort & Partial<ManualTriggerPort>;
}): Promise<WebhookHandleResult> {
  let payload: IssueCommentWebhookPayload;
  try {
    payload = JSON.parse(input.request.rawBody) as IssueCommentWebhookPayload;
  } catch {
    return { status: 400, body: { error: "invalid JSON" } };
  }
  if (payload.action !== "created") {
    return { status: 202, body: { ok: true, ignored: true, reason: `ignored action ${payload.action ?? "unknown"}` } };
  }
  if (!payload.issue?.pull_request) {
    return { status: 202, body: { ok: true, ignored: true, reason: "not a pull request comment" } };
  }
  const body = payload.comment?.body ?? "";
  const actor = payload.comment?.user ?? payload.sender;
  // Stack commands run before the bot filter: allowlisted automation
  // identities (MAOMAO_STACK_AUTHORS) may issue them; every other actor is
  // authorized by collaborator permission inside the handler.
  const stackCommand = parseStackCommand(body);
  if (stackCommand) {
    return handleStackCommand(input, payload, stackCommand);
  }
  if (isBotActor({ login: actor?.login, type: actor?.type })) {
    return { status: 202, body: { ok: true, ignored: true, reason: "ignored bot comment" } };
  }
  if (commentLooksLikeMaomaoEscalation(body)) {
    return { status: 202, body: { ok: true, ignored: true, reason: "ignored maomao marker comment" } };
  }
  if (!mentionsEscalateCommand(body, input.config.poisonAlert.mentionName, input.config.poisonAlert.escalateCommand)) {
    return { status: 202, body: { ok: true, ignored: true, reason: "not an escalate command" } };
  }
  const installationId = payload.installation?.id;
  const repoOwner = payload.repository?.owner?.login;
  const repoName = payload.repository?.name;
  const repoFullName = payload.repository?.full_name;
  const prNumber = payload.issue.number;
  const actorLogin = actor?.login;
  if (!installationId || !repoOwner || !repoName || !repoFullName || !prNumber || !actorLogin || !input.github) {
    return { status: 202, body: { ok: true, ignored: true, reason: "missing github context" } };
  }
  const permission = await input.github.getCollaboratorPermission(installationId, repoOwner, repoName, actorLogin);
  if (!canIssueOverride(permission, payload.comment?.author_association)) {
    return { status: 202, body: { ok: true, ignored: true, reason: "actor is not authorized to escalate", actor: actorLogin, permission } };
  }
  const job = input.store.findLatestJobForPull(repoFullName, prNumber);
  if (!job) {
    return { status: 202, body: { ok: true, ignored: true, reason: "no maomao job for this pull request" } };
  }
  if (job.state === "cancelled" || job.state === "stale") {
    // The job can never dispatch; accepting would swallow the operator's
    // intent with a success response and no GitHub-visible trace.
    return {
      status: 202,
      body: { ok: true, ignored: true, reason: `job for this pull request is ${job.state}; not escalating` },
    };
  }
  input.store.patchJob(job.id, { manual_escalate_requested: 1 });
  input.store.log(job.id, `Authorized escalate command from ${actorLogin}`);
  return {
    status: 202,
    body: { ok: true, dispatchJobId: job.id, jobId: job.id, headSha: job.head_sha },
    dispatchJobId: job.id,
  };
}

// Stack commands (issue #99): "issue X of Y in stack <id>" declares a member,
// "top of stack <id>: #n,…" validates the whole stack and enqueues exactly one
// stack_review job. Both reply on the PR so every accepted or rejected command
// leaves a GitHub-visible trace; duplicate comment deliveries are deduped by
// comment id so they can never double-post or double-enqueue.
async function handleStackCommand(
  input: {
    config: Config;
    store: JobStore;
    request: WebhookRequest;
    github?: GithubPort & Partial<ManualTriggerPort>;
  },
  payload: IssueCommentWebhookPayload,
  command: StackCommand,
): Promise<WebhookHandleResult> {
  const actor = payload.comment?.user ?? payload.sender;
  const actorLogin = actor?.login;
  const installationId = payload.installation?.id;
  const repoOwner = payload.repository?.owner?.login;
  const repoName = payload.repository?.name;
  const repoFullName = payload.repository?.full_name;
  const prNumber = payload.issue?.number;
  if (!installationId || !repoOwner || !repoName || !repoFullName || !prNumber || !actorLogin || !input.github) {
    return { status: 202, body: { ok: true, ignored: true, reason: "missing github context" } };
  }
  // Stack commands only make sense on pull requests — the same text on a
  // plain issue must not record a declaration against an issue number.
  if (!payload.issue?.pull_request) {
    return { status: 202, body: { ok: true, ignored: true, reason: "stack commands require a pull request comment" } };
  }

  if (isBotActor({ login: actor?.login, type: actor?.type })) {
    // Automation identities are admitted only via the explicit allowlist.
    if (!input.config.stackCommandAuthors.includes(actorLogin.toLowerCase())) {
      return { status: 202, body: { ok: true, ignored: true, reason: "bot actor is not an allowlisted stack command author", actor: actorLogin } };
    }
  } else {
    const permission = await input.github.getCollaboratorPermission(installationId, repoOwner, repoName, actorLogin);
    if (!canIssueOverride(permission, payload.comment?.author_association)) {
      return {
        status: 202,
        body: { ok: true, ignored: true, reason: "actor is not authorized for stack commands", actor: actorLogin, permission },
      };
    }
  }

  const commentId = payload.comment?.id;
  if (commentId != null && input.store.hasReviewCommand(String(commentId))) {
    input.store.claimWebhookDelivery(input.request.deliveryId, input.request.event, "duplicate-stack-command");
    return { status: 200, body: { ok: true, duplicate: true, reason: "duplicate command comment" } };
  }
  const finish = (result: string, body: Record<string, unknown>): WebhookHandleResult => {
    input.store.claimWebhookDelivery(input.request.deliveryId, input.request.event, result);
    if (commentId != null) input.store.claimReviewCommand(String(commentId), input.request.deliveryId, "stack-command", result);
    return { status: 200, body };
  };
  const reply = async (text: string): Promise<void> => {
    try {
      await input.github?.createIssueComment?.({
        installationId,
        owner: repoOwner,
        repo: repoName,
        pullNumber: prNumber,
        body: text,
      });
    } catch (error) {
      console.warn(`stack command: could not post reply on ${repoFullName}#${prNumber}: ${error instanceof Error ? error.message : error}`);
    }
  };

  if (command.kind === "declare") {
    const result = input.store.upsertStackDeclaration({
      repoFullName,
      stackId: command.stackId,
      prNumber,
      position: command.position,
      expectedCount: command.expectedCount,
      actor: actorLogin,
      commentId: commentId != null ? String(commentId) : undefined,
    });
    if (!result.ok) {
      await reply(`Could not record stack membership: ${result.error}.`);
      return finish("declare-conflict", { ok: true, command: "declare", stackId: command.stackId, recorded: false, error: result.error });
    }
    if (result.created) {
      await reply(`Recorded this pull request as issue ${command.position} of ${command.expectedCount} in stack "${command.stackId}".`);
    }
    return finish(result.created ? "declare-recorded" : "declare-duplicate", {
      ok: true,
      command: "declare",
      stackId: command.stackId,
      recorded: result.created,
    });
  }

  if (typeof input.github.getPull !== "function") {
    return { status: 202, body: { ok: true, ignored: true, reason: "github client cannot resolve pull requests" } };
  }
  const getPull = input.github.getPull.bind(input.github);
  const pulls: ResolvedPull[] = [];
  for (const n of command.prNumbers) {
    try {
      pulls.push(await getPull(installationId, repoOwner, repoName, n));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await reply(`Could not run stack "${command.stackId}": PR #${n} does not resolve in ${repoFullName} (${message}).`);
      return finish("top-unresolved", { ok: true, command: "top", stackId: command.stackId, enqueued: false, error: `PR #${n} unresolved` });
    }
  }
  const declarations = input.store.listStackDeclarations(repoFullName, command.stackId);
  const validation = validateStackMembers({
    stackId: command.stackId,
    prNumbers: command.prNumbers,
    pulls,
    declarations,
    repoFullName,
    commentPrNumber: prNumber,
  });
  if (!validation.ok) {
    await reply(`Could not run stack "${command.stackId}": ${validation.error}.`);
    return finish("top-invalid", { ok: true, command: "top", stackId: command.stackId, enqueued: false, error: validation.error });
  }

  const top = validation.members[validation.members.length - 1]!;
  const bottom = validation.members[0]!;
  const topPull = pulls[pulls.length - 1]!;
  const enqueue = input.store.enqueue({
    repoFullName,
    repoOwner,
    repoName,
    installationId,
    githubAccountId: numericId(payload.installation?.account?.id) ?? numericId(payload.repository?.owner?.id),
    githubRepositoryId: numericId(payload.repository?.id),
    prNumber: top.prNumber,
    prTitle: topPull.prTitle,
    prBody: topPull.prBody,
    prHtmlUrl: topPull.prHtmlUrl,
    prAuthor: topPull.prAuthor,
    baseSha: bottom.baseSha,
    headSha: top.headSha,
    baseRef: bottom.baseRef,
    headRef: top.headRef,
    webhookDeliveryId: input.request.deliveryId,
    webhookEvent: "issue_comment",
    // One placeholder run row for the cumulative pass; member reviews get the
    // profile reviewers when runStackJob enqueues them as pr_review jobs.
    reviewers: [{ role: "stack_cumulative", title: "Stack cumulative" }],
    jobType: "stack_review",
    dedupKey: `stack:${command.stackId}`,
  });
  if (enqueue.created) {
    input.store.insertStackMembers(enqueue.job.id, validation.members);
    input.store.log(
      enqueue.job.id,
      `Stack "${command.stackId}" of ${validation.members.length} triggered by ${actorLogin}: ` +
        validation.members.map((m) => `#${m.prNumber}@${m.headSha.slice(0, 8)}`).join(" → "),
    );
    await reply(
      `Stack review enqueued for "${command.stackId}" — job ${enqueue.job.id} pinned ` +
        `${validation.members.map((m) => `#${m.prNumber}@${m.headSha.slice(0, 8)}`).join(" → ")}.`,
    );
  } else {
    await reply(
      `Stack "${command.stackId}" deduped onto job ${enqueue.job.id} ` +
        `(${enqueue.skippedReason ?? `job ${enqueue.job.state}`}); nothing enqueued.`,
    );
  }
  return {
    status: 200,
    body: {
      ok: true,
      command: "top",
      stackId: command.stackId,
      enqueued: enqueue.created,
      jobId: enqueue.job.id,
      staleJobIds: enqueue.staleJobIds,
    },
    enqueue,
  };
}

async function handleReviewCommentWebhook(input: {
  config: Config;
  store: JobStore;
  request: WebhookRequest;
  github?: GithubPort;
}): Promise<WebhookHandleResult> {
  if (input.store.hasWebhookDelivery(input.request.deliveryId)) {
    return { status: 200, body: { ok: true, duplicate: true, reason: "duplicate delivery" } };
  }

  let payload: ReviewCommentWebhookPayload;
  try {
    payload = JSON.parse(input.request.rawBody) as ReviewCommentWebhookPayload;
  } catch {
    return { status: 400, body: { error: "invalid JSON" } };
  }

  if (payload.action !== "created") {
    return { status: 202, body: { ok: true, ignored: true, reason: `ignored action ${payload.action ?? "unknown"}` } };
  }

  const comment = payload.comment;
  const body = comment?.body ?? "";
  const parsed = parseOverrideCommand(body);
  if (!parsed) {
    return { status: 202, body: { ok: true, ignored: true, reason: "not an override command" } };
  }

  const commentId = comment?.id;
  if (commentId != null && input.store.hasReviewCommand(String(commentId))) {
    input.store.claimWebhookDelivery(input.request.deliveryId, input.request.event, "duplicate-comment");
    return { status: 200, body: { ok: true, duplicate: true, reason: "duplicate command comment" } };
  }

  if (!comment?.in_reply_to_id) {
    return { status: 202, body: { ok: true, ignored: true, reason: "override commands must be thread replies" } };
  }

  const actor = comment.user?.login;
  if (!actor || isMaomaoLogin(actor, input.config.github.appSlug)) {
    return { status: 202, body: { ok: true, ignored: true, reason: "ignored bot or missing author" } };
  }

  const installationId = payload.installation?.id;
  const repoOwner = payload.repository?.owner?.login;
  const repoName = payload.repository?.name;
  const repoFullName = payload.repository?.full_name;
  const prNumber = payload.pull_request?.number;
  if (!installationId || !repoOwner || !repoName || !repoFullName || !prNumber || !input.github) {
    return { status: 202, body: { ok: true, ignored: true, reason: "missing github context" } };
  }

  const permission = await input.github.getCollaboratorPermission(installationId, repoOwner, repoName, actor);
  if (!canIssueOverride(permission, payload.comment?.author_association)) {
    input.store.claimWebhookDelivery(input.request.deliveryId, input.request.event, "unauthorized");
    return {
      status: 202,
      body: { ok: true, ignored: true, reason: "unauthorized", actor, permission },
    };
  }

  const threads = await input.github.listReviewThreads(installationId, repoOwner, repoName, prNumber);
  const thread = findCommandThread(threads, comment.id, comment.in_reply_to_id);
  if (!thread || !isMaomaoThread(thread)) {
    input.store.claimWebhookDelivery(input.request.deliveryId, input.request.event, "not-maomao-thread");
    return { status: 202, body: { ok: true, ignored: true, reason: "not a Maomao review thread" } };
  }

  const commentWithMarker = findingComment(thread);
  const marker = parseThreadFindingMarker(thread);
  if (!marker) {
    return { status: 202, body: { ok: true, ignored: true, reason: "thread is missing a finding marker" } };
  }

  const reviewedSha = payload.pull_request?.head?.sha || marker.sha;
  const summary = (commentWithMarker?.body ?? marker.id).replace(/<!--[\s\S]*?-->/g, "").trim().slice(0, 240) || marker.id;

  if (parsed.command === "dismiss") {
    const result = input.store.dismissFinding({
      repoFullName,
      prNumber,
      fingerprint: marker.id,
      actor,
      command: parsed.token,
      reviewedSha,
      githubThreadId: thread.id,
      githubCommentId: commentWithMarker?.databaseId != null ? String(commentWithMarker.databaseId) : String(comment.in_reply_to_id),
      summary,
      path: comment.path ?? commentWithMarker?.path ?? thread.path,
      line: commentWithMarker?.line ?? thread.line,
    });
    try {
      await input.github.resolveReviewThread(installationId, thread.id);
    } catch (error) {
      // Dismissal is persisted; the next successful review will retry resolve.
      return finishCommand(input, commentId, parsed.token, {
        ok: true,
        command: parsed.command,
        token: parsed.token,
        fingerprint: marker.id,
        changed: result.changed,
        threadResolved: false,
        warning: describeThreadResolveError(error),
      });
    }
    return finishCommand(input, commentId, parsed.token, {
      ok: true,
      command: parsed.command,
      token: parsed.token,
      fingerprint: marker.id,
      changed: result.changed,
      threadResolved: true,
      status: "dismissed",
    });
  }

  const result = input.store.reopenFinding({
    repoFullName,
    prNumber,
    fingerprint: marker.id,
    actor,
    command: parsed.token,
    reviewedSha,
    githubThreadId: thread.id,
    githubCommentId: commentWithMarker?.databaseId != null ? String(commentWithMarker.databaseId) : String(comment.in_reply_to_id),
    summary,
  });
  try {
    await input.github.unresolveReviewThread(installationId, thread.id);
  } catch (error) {
    return finishCommand(input, commentId, parsed.token, {
      ok: true,
      command: parsed.command,
      token: parsed.token,
      fingerprint: marker.id,
      changed: result.changed,
      threadUnresolved: false,
      warning: describeThreadResolveError(error),
    });
  }
  return finishCommand(input, commentId, parsed.token, {
    ok: true,
    command: parsed.command,
    token: parsed.token,
    fingerprint: marker.id,
    changed: result.changed,
    threadUnresolved: true,
    status: "open",
  });
}

function finishCommand(
  input: { store: JobStore; request: WebhookRequest },
  commentId: number | undefined,
  command: string,
  body: Record<string, unknown>,
): WebhookHandleResult {
  input.store.claimWebhookDelivery(input.request.deliveryId, input.request.event, command);
  if (commentId != null) input.store.claimReviewCommand(String(commentId), input.request.deliveryId, command, "ok");
  return { status: 200, body };
}

function findCommandThread(
  threads: ReviewThread[],
  commentId: number | undefined,
  inReplyToId: number,
): ReviewThread | undefined {
  return threads.find((thread) => {
    if (commentId != null && threadContainsComment(thread, commentId)) return true;
    return threadContainsComment(thread, inReplyToId);
  });
}
