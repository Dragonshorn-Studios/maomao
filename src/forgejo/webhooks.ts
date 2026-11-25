/**
 * Forgejo pull-request ingestion. Deliveries are verified with the
 * connection-local webhook secret, deduplicated provider+instance scoped, and
 * anchored to the immutable pull_request.head.sha before enqueueing.
 */
import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import type { ForgeConnectionStore, OpenedConnection } from "../forge/connections.js";
import { emitWebhookHandled, enqueueClaimResult, recordWebhookDelivery } from "../forge/deliveries.js";
import type { RepoRateLimiter } from "../github/rate-limit.js";
import { cancelJobsForPull } from "../jobs/cancel.js";
import { enqueuePullJob } from "../jobs/enqueue.js";
import type { EnqueueResult, JobStore } from "../jobs/store.js";
import { verifyForgejoWebhook } from "./signature.js";

export interface ForgejoWebhookRequest {
  event: string;
  rawBody: string;
  deliveryId?: string;
  forgejoSignature?: string;
  giteaSignature?: string;
  hubSignature256?: string;
  gogsSignature?: string;
}

export interface ForgejoWebhookHandleResult {
  status: number;
  body: Record<string, unknown>;
  enqueue?: EnqueueResult;
}

interface ForgejoPullPayload {
  action?: string;
  number?: number;
  pull_request?: {
    number?: number;
    title?: string;
    body?: string | null;
    html_url?: string;
    user?: { login?: string };
    merged?: boolean;
    draft?: boolean;
    base?: { sha?: string; ref?: string };
    head?: { sha?: string; ref?: string };
  };
  repository?: { id?: number; full_name?: string; owner?: { login?: string }; name?: string };
  sender?: { login?: string };
}

function ignored(reason: string): ForgejoWebhookHandleResult {
  return { status: 202, body: { ok: true, ignored: true, reason } };
}

export function withinForgejoScope(connection: OpenedConnection, repoFullName: string): boolean {
  const path = repoFullName.toLowerCase();
  if (connection.row.scope_type === "instance") return true;
  if (connection.row.scope_type === "group") {
    const owner = path.split("/")[0] ?? "";
    return owner === connection.row.scope_path.toLowerCase();
  }
  return path === connection.row.scope_path.toLowerCase();
}

export function parseForgejoPullEvent(rawBody: string) {
  const payload = JSON.parse(rawBody) as ForgejoPullPayload;
  const pull = payload.pull_request;
  const fullName = payload.repository?.full_name;
  const number = payload.number ?? pull?.number;
  const headSha = pull?.head?.sha;
  if (!fullName || !Number.isSafeInteger(number) || !headSha) {
    throw new Error("pull_request payload is missing repository, number, or head sha");
  }
  const separator = fullName.lastIndexOf("/");
  const ownerPart = separator > 0 ? fullName.slice(0, separator) : "";
  const repoPart = separator > 0 ? fullName.slice(separator + 1) : "";
  if (separator <= 0 || separator !== fullName.indexOf("/") || !ownerPart || !repoPart || ownerPart === ".." || repoPart === ".." || /[\s\u0000-\u001f]/.test(fullName)) {
    throw new Error("pull_request payload has an invalid repository full_name");
  }
  return {
    action: payload.action ?? "",
    repositoryId: payload.repository?.id ?? 0,
    repoFullName: fullName,
    repoOwner: separator > 0 ? fullName.slice(0, separator) : fullName,
    repoName: separator > 0 ? fullName.slice(separator + 1) : fullName,
    prNumber: number!,
    title: pull?.title ?? "",
    body: pull?.body ?? "",
    htmlUrl: pull?.html_url ?? "",
    author: pull?.user?.login ?? payload.sender?.login ?? "",
    baseSha: pull?.base?.sha ?? "",
    headSha,
    baseRef: pull?.base?.ref ?? "",
    headRef: pull?.head?.ref ?? "",
    draft: Boolean(pull?.draft),
    merged: Boolean(pull?.merged),
    actor: payload.sender?.login ?? "",
  };
}

export function shouldHandleForgejoPull(config: Config, payload: ReturnType<typeof parseForgejoPullEvent>): { handle: boolean; reason?: string } {
  if (!["opened", "reopened", "synchronize", "synchronized"].includes(payload.action)) {
    return { handle: false, reason: `ignored action ${payload.action || "unknown"}` };
  }
  if (payload.draft && !config.reviewDrafts) return { handle: false, reason: "ignored draft pull request" };
  return { handle: true };
}

async function handleForgejoWebhookRequest(input: {
  config: Config;
  store: JobStore;
  connections: ForgeConnectionStore;
  rateLimiter?: RepoRateLimiter;
  connectionId: string;
  request: ForgejoWebhookRequest;
  abortJobs?: (jobIds: number[]) => void;
}): Promise<ForgejoWebhookHandleResult> {
  const { store, request } = input;
  let connection: OpenedConnection;
  try {
    connection = input.connections.open(input.connectionId);
  } catch {
    return { status: 404, body: { error: "forgejo connection not found" } };
  }
  if (connection.row.provider !== "forgejo") return { status: 404, body: { error: "forgejo connection not found" } };
  if (!verifyForgejoWebhook(connection.webhookSecret, request.rawBody, request)) {
    return { status: 401, body: { error: "invalid webhook signature" } };
  }
  if (connection.row.enabled !== 1) return ignored("connection is disabled");

  const scope = { provider: "forgejo", instance: connection.instance.hostname };
  const deliveryId = request.deliveryId || `forgejo-fallback-${createHash("sha256").update(request.rawBody).digest("hex").slice(0, 24)}`;
  if (store.hasWebhookDelivery(deliveryId, scope)) {
    return { status: 200, body: { ok: true, duplicate: true, reason: "duplicate delivery" } };
  }
  if (request.event === "ping") return { status: 200, body: { ok: true, event: "ping" } };
  if (request.event !== "pull_request") return ignored(`unsupported event ${request.event || "unknown"}`);

  let payload: ReturnType<typeof parseForgejoPullEvent>;
  try {
    payload = parseForgejoPullEvent(request.rawBody);
  } catch (error) {
    return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
  }
  if (!withinForgejoScope(connection, payload.repoFullName)) return ignored("outside connection scope");
  if (connection.row.bot_username && payload.actor.toLowerCase() === connection.row.bot_username.toLowerCase()) {
    return ignored("bot-authored event");
  }

  if (payload.action === "closed") {
    if (!payload.merged) return ignored("pull request closed without merge");
    store.markPullMerged(payload.repoFullName, payload.prNumber, deliveryId, scope);
    const { cancelledJobIds } = cancelJobsForPull(store, {
      repoFullName: payload.repoFullName,
      prNumber: payload.prNumber,
      scope,
      reason: "pr_merged",
      note: `webhook delivery ${deliveryId}`,
      onCancelled: input.abortJobs,
    });
    store.claimWebhookDelivery(deliveryId, request.event, "pr_merged_cancel", scope);
    return { status: 200, body: { ok: true, cancelled: cancelledJobIds.length, cancelledJobIds } };
  }

  const decision = shouldHandleForgejoPull(input.config, payload);
  if (!decision.handle) return ignored(decision.reason ?? "ignored");
  if (store.getGlobalPause()) return ignored("reviews paused globally");
  if (store.hasMergedPull(payload.repoFullName, payload.prNumber, scope)) return ignored("pull request already merged; not enqueueing");

  const rateOn = input.config.repoRateLimitPerWindow > 0 && input.config.repoRateWindowMs > 0;
  const rateKey = `forgejo:${connection.instance.hostname}:${payload.repositoryId || payload.repoFullName}`;
  if (rateOn && input.rateLimiter && !input.rateLimiter.wouldAllowKey(rateKey, input.config.repoRateLimitPerWindow, input.config.repoRateWindowMs)) {
    return ignored("rate limited");
  }
  const enqueue = enqueuePullJob(store, input.config, {
    repoFullName: payload.repoFullName,
    repoOwner: payload.repoOwner,
    repoName: payload.repoName,
    installationId: payload.repositoryId,
    provider: "forgejo",
    providerInstance: connection.instance.hostname,
    forgeConnectionId: connection.row.id,
    prNumber: payload.prNumber,
    prTitle: payload.title,
    prBody: payload.body,
    prHtmlUrl: payload.htmlUrl,
    prAuthor: payload.author,
    baseSha: payload.baseSha,
    headSha: payload.headSha,
    baseRef: payload.baseRef,
    headRef: payload.headRef,
    webhookDeliveryId: deliveryId,
    webhookEvent: `${request.event}.${payload.action}`,
  });
  if (enqueue.created && rateOn && input.rateLimiter) {
    input.rateLimiter.recordKey(rateKey, input.config.repoRateLimitPerWindow, input.config.repoRateWindowMs);
  }
  store.claimWebhookDelivery(deliveryId, request.event, enqueueClaimResult(enqueue), scope);
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
}

export async function handleForgejoWebhook(input: Parameters<typeof handleForgejoWebhookRequest>[0]): Promise<ForgejoWebhookHandleResult> {
  const startedAt = Date.now();
  const result = await handleForgejoWebhookRequest(input).catch((error: unknown): ForgejoWebhookHandleResult => {
    const sanitize = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, " ");
    const message = sanitize(error instanceof Error ? error.message : String(error));
    console.error(`forgejo webhook: handling failed for ${sanitize(input.request.event)}: ${message}`);
    return { status: 500, body: { error: "webhook handling failed; see server logs" } };
  });
  let instance = "";
  try {
    instance = input.connections.open(input.connectionId).instance.hostname;
  } catch {
    // Unknown connections already produced 404; do not record unverified context.
  }
  if (instance) {
    const deliveryId = input.request.deliveryId || `forgejo-fallback-${createHash("sha256").update(input.request.rawBody).digest("hex").slice(0, 24)}`;
    recordWebhookDelivery({
      store: input.store,
      deliveryId,
      event: input.request.event,
      rawBody: input.request.rawBody,
      result,
      scope: { provider: "forgejo", instance },
    });
    emitWebhookHandled(input.store, {
      provider: "forgejo",
      event: input.request.event,
      deliveryId,
      result,
      durationMs: Date.now() - startedAt,
    });
  }
  return result;
}
