import { verify } from "@octokit/webhooks-methods";
import type { Config, PullRequestAction } from "../config.js";
import type { EnqueueResult, JobStore } from "../jobs/store.js";
import { enqueuePullJob } from "../jobs/enqueue.js";
import {
  commentLooksLikeMaomaoEscalation,
  isAuthorizedEscalateActor,
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
    return handleIssueComment(input);
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

function handleIssueComment(input: {
  config: Config;
  store: JobStore;
  request: WebhookRequest;
}): WebhookHandleResult {
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
  if (!isAuthorizedEscalateActor(payload.comment?.author_association)) {
    return { status: 202, body: { ok: true, ignored: true, reason: "actor is not authorized to escalate" } };
  }
  const repoFullName = payload.repository?.full_name;
  const prNumber = payload.issue.number;
  if (!repoFullName || !prNumber) {
    return { status: 400, body: { error: "comment payload missing repository or issue number" } };
  }
  const job = input.store.findLatestJobForPull(repoFullName, prNumber);
  if (!job) {
    return { status: 202, body: { ok: true, ignored: true, reason: "no maomao job for this pull request" } };
  }
  input.store.patchJob(job.id, { manual_escalate_requested: 1 });
  input.store.log(job.id, `Authorized escalate command from ${actor?.login ?? "unknown"}`);
  return {
    status: 202,
    body: { ok: true, dispatchJobId: job.id, jobId: job.id, headSha: job.head_sha },
    dispatchJobId: job.id,
  };
}
