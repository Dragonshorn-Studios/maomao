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
  type ReviewThread,
} from "./client.js";
import type { EnqueueResult, JobStore } from "../jobs/store.js";
import { enqueuePullJob } from "../jobs/enqueue.js";
import { logAuthorizationRejection, logRateLimited, positiveGithubId, rejectUnauthorized } from "./authorize.js";
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
  installation?: { id?: number };
  repository?: {
    full_name?: string;
    name?: string;
    owner?: { login?: string };
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

export async function handleGithubWebhook(input: {
  config: Config;
  store: JobStore;
  request: WebhookRequest;
  rateLimiter?: RepoRateLimiter;
  github?: GithubPort;
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
    return {
      status: 400,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function handleIssueComment(input: {
  config: Config;
  store: JobStore;
  request: WebhookRequest;
  github?: GithubPort;
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
  input.store.patchJob(job.id, { manual_escalate_requested: 1 });
  input.store.log(job.id, `Authorized escalate command from ${actorLogin}`);
  return {
    status: 202,
    body: { ok: true, dispatchJobId: job.id, jobId: job.id, headSha: job.head_sha },
    dispatchJobId: job.id,
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
        warning: error instanceof Error ? error.message : String(error),
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
      warning: error instanceof Error ? error.message : String(error),
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
