import { verify } from "@octokit/webhooks-methods";
import type { Config, PullRequestAction } from "../config.js";
import { hasOverridePermission, parseOverrideCommand } from "../findings/commands.js";
import { parseFindingMarker } from "../findings/identity.js";
import {
  isMaomaoLogin,
  isMaomaoThread,
  threadContainsComment,
  threadRoot,
  type GithubPort,
  type ReviewThread,
} from "./client.js";
import type { EnqueueResult, JobStore } from "../jobs/store.js";
import { enqueuePullJob } from "../jobs/enqueue.js";

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
};

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
  installation?: { id?: number };
  repository?: {
    full_name?: string;
    name?: string;
    owner?: { login?: string };
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

export function parsePullRequestPayload(payload: PullRequestWebhookPayload): {
  installationId: number;
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
  const installationId = payload.installation?.id;
  const repoOwner = payload.repository?.owner?.login;
  const repoName = payload.repository?.name;
  const repoFullName = payload.repository?.full_name;
  const pr = payload.pull_request;
  if (!installationId || !repoOwner || !repoName || !repoFullName || !pr?.number || !pr.head?.sha || !pr.base?.sha) {
    throw new Error("webhook payload missing installation, repository, or pull request SHAs");
  }
  return {
    installationId,
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

export async function handleGithubWebhook(input: {
  config: Config;
  store: JobStore;
  request: WebhookRequest;
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

  if (input.request.event === "pull_request_review_comment") {
    return handleReviewCommentWebhook(input);
  }

  if (input.request.event !== "pull_request") {
    return { status: 202, body: { ok: true, ignored: true, reason: `event ${input.request.event}` } };
  }

  let payload: PullRequestWebhookPayload;
  try {
    payload = JSON.parse(input.request.rawBody) as PullRequestWebhookPayload;
  } catch {
    return { status: 400, body: { error: "invalid JSON" } };
  }

  const decision = shouldHandlePullRequest(input.config, payload);
  if (!decision.handle) {
    return { status: 202, body: { ok: true, ignored: true, reason: decision.reason } };
  }

  try {
    const parsed = parsePullRequestPayload(payload);
    const enqueue = enqueuePullJob(input.store, input.config, {
      ...parsed,
      webhookDeliveryId: input.request.deliveryId,
      webhookEvent: `${input.request.event}.${payload.action}`,
    });
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
  const ownerAssociation = payload.comment?.author_association === "OWNER";
  if (!hasOverridePermission(permission) && !ownerAssociation) {
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

  const root = threadRoot(thread);
  const marker = root ? parseFindingMarker(root.body) : undefined;
  if (!marker) {
    return { status: 202, body: { ok: true, ignored: true, reason: "thread is missing a finding marker" } };
  }

  const reviewedSha = payload.pull_request?.head?.sha || marker.sha;
  const summary = (root?.body ?? marker.id).replace(/<!--[\s\S]*?-->/g, "").trim().slice(0, 240) || marker.id;

  if (parsed.command === "dismiss") {
    const result = input.store.dismissFinding({
      repoFullName,
      prNumber,
      fingerprint: marker.id,
      actor,
      command: parsed.token,
      reviewedSha,
      githubThreadId: thread.id,
      githubCommentId: root?.databaseId != null ? String(root.databaseId) : String(comment.in_reply_to_id),
      summary,
      path: comment.path ?? root?.path ?? thread.path,
      line: root?.line ?? thread.line,
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
    githubCommentId: root?.databaseId != null ? String(root.databaseId) : String(comment.in_reply_to_id),
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
