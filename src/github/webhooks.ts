import { verify } from "@octokit/webhooks-methods";
import type { Config, PullRequestAction } from "../config.js";
import type { EnqueueResult, JobStore } from "../jobs/store.js";
import { enqueuePullJob } from "../jobs/enqueue.js";
import { authorizeGithubTarget, logAuthorizationRejection } from "./authorize.js";
import type { RepoRateLimiter } from "./rate-limit.js";

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
  const n = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
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
    const auth = authorizeGithubTarget(input.config, {
      installationId: parsed.installationId,
      accountId: parsed.githubAccountId,
      repositoryId: parsed.githubRepositoryId,
    });
    if (!auth.ok) {
      logAuthorizationRejection({
        installationId: parsed.installationId,
        repositoryId: parsed.githubRepositoryId,
        reason: auth.reason,
      });
      return ignored(auth.reason);
    }

    if (
      parsed.githubRepositoryId != null &&
      input.rateLimiter &&
      !input.rateLimiter.allow(
        parsed.githubRepositoryId,
        input.config.repoRateLimitPerWindow,
        input.config.repoRateWindowMs,
      )
    ) {
      logAuthorizationRejection({
        installationId: parsed.installationId,
        repositoryId: parsed.githubRepositoryId,
        reason: "rate limited",
      });
      return ignored("rate limited");
    }

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
