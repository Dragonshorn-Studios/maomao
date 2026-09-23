/**
 * GitLab webhook handling (issue #18 slice 3). Every delivery is verified
 * against the connection's secret, deduplicated per (provider, instance,
 * delivery id), bot-authored events are dropped, and events are scoped to
 * the connection's project/group/instance boundary before any job work.
 *
 * MR events anchor every job to `object_attributes.last_commit.id`; `update`
 * events only enqueue when `oldrev` proves the source revision changed, so
 * title edits never enqueue. Merge events reuse the shared cancellation
 * path (cancel + permanent merged marker), provider-scoped.
 */
import type { Config } from "../config.js";
import { canIssueOverride, parseOverrideCommand } from "../findings/commands.js";
import { parseFindingMarker } from "../findings/identity.js";
import { isAllowlistedOverrideAuthor, sanitizeCommentText, threadFingerprintIndex } from "../findings/overrides.js";
import { accessLevelToPermission, GitLabApiClient, toForgeDiscussions, type GitLabCommandApi } from "./client.js";
import { deliveryIdFrom, verifyGitLabWebhook } from "./signature.js";
import type { ForgeDiscussion } from "../forge/types.js";
import type { EnqueueResult, JobStore } from "../jobs/store.js";
import { enqueuePullJob } from "../jobs/enqueue.js";
import { cancelJobsForPull } from "../jobs/cancel.js";
import type { ForgeConnectionStore, OpenedConnection } from "../forge/connections.js";
import { commentLooksLikeMaomaoEscalation, mentionsEscalateCommand } from "../routing/escalation.js";
import type { RepoRateLimiter } from "../github/rate-limit.js";

export interface GitLabWebhookRequest {
  event: string;
  rawBody: string;
  /** Signature headers when the sender supplied them. */
  webhookId?: string;
  webhookTimestamp?: string;
  webhookSignature?: string;
  legacyToken?: string;
  /** Per-event and per-webhook UUIDs from newer GitLab; idempotency fallbacks. */
  eventUuid?: string;
  webhookUuid?: string;
}

export interface GitLabWebhookHandleResult {
  status: number;
  body: Record<string, unknown>;
  enqueue?: EnqueueResult;
  dispatchJobId?: number;
}

export interface GitLabProjectPayload {
  id?: number;
  path_with_namespace?: string;
}

export interface GitLabUserPayload {
  id?: number;
  username?: string;
}

export interface GitLabMergeRequestAttributes {
  iid?: number;
  title?: string;
  state?: string;
  action?: string;
  url?: string;
  source_branch?: string;
  target_branch?: string;
  /** Present on `update` only when the source revision changed. */
  oldrev?: string | null;
  last_commit?: { id?: string };
  work_in_progress?: boolean;
  draft?: boolean;
}

export interface GitLabMergeRequestEvent {
  object_kind?: string;
  user?: GitLabUserPayload;
  project?: GitLabProjectPayload;
  object_attributes?: GitLabMergeRequestAttributes;
}

export interface GitLabNoteEvent {
  object_kind?: string;
  user?: GitLabUserPayload;
  project?: GitLabProjectPayload;
  object_attributes?: {
    id?: number;
    note?: string;
    noteable_type?: string;
    action?: string;
  };
  merge_request?: { iid?: number };
}

function ignored(reason: string): GitLabWebhookHandleResult {
  return { status: 202, body: { ok: true, ignored: true, reason } };
}

/** project/group/instance scoping: events outside the connection's boundary are ignored. */
export function withinScope(connection: OpenedConnection, project: GitLabProjectPayload): boolean {
  const path = project.path_with_namespace?.toLowerCase();
  if (!path) return false;
  if (connection.row.scope_type === "instance") return true;
  if (connection.row.scope_type === "group") {
    const scope = connection.row.scope_path.toLowerCase();
    return path === scope || path.startsWith(`${scope}/`);
  }
  return path === connection.row.scope_path.toLowerCase();
}

export function parseMergeRequestEvent(rawBody: string): {
  projectId: number;
  projectPath: string;
  repoOwner: string;
  repoName: string;
  mrIid: number;
  mrTitle: string;
  mrUrl: string;
  authorUsername: string;
  headSha: string;
  sourceBranch: string;
  targetBranch: string;
  draft: boolean;
  action: string;
  state: string;
  oldrev?: string;
} {
  const payload = JSON.parse(rawBody) as GitLabMergeRequestEvent;
  const attributes = payload.object_attributes;
  const projectId = payload.project?.id;
  const projectPath = payload.project?.path_with_namespace;
  const mrIid = attributes?.iid;
  const headSha = attributes?.last_commit?.id;
  if (!Number.isSafeInteger(projectId) || !projectPath || !Number.isSafeInteger(mrIid) || !headSha) {
    throw new Error("merge_request payload is missing project, iid, or last_commit id");
  }
  const separator = projectPath.lastIndexOf("/");
  return {
    projectId: projectId!,
    projectPath,
    repoOwner: separator > 0 ? projectPath.slice(0, separator) : projectPath,
    repoName: separator > 0 ? projectPath.slice(separator + 1) : projectPath,
    mrIid: mrIid!,
    mrTitle: attributes?.title ?? "",
    mrUrl: attributes?.url ?? "",
    authorUsername: payload.user?.username ?? "",
    headSha: headSha!,
    sourceBranch: attributes?.source_branch ?? "",
    targetBranch: attributes?.target_branch ?? "",
    draft: Boolean(attributes?.work_in_progress || attributes?.draft),
    action: attributes?.action ?? "",
    state: attributes?.state ?? "",
    oldrev: attributes?.oldrev ?? undefined,
  };
}

/** The one place a GitLab MR action decides whether Maomao reviews it. */
export function shouldHandleMergeRequest(
  config: Config,
  payload: ReturnType<typeof parseMergeRequestEvent>,
): { handle: boolean; reason?: string } {
  if (payload.state === "merged") {
    return { handle: false, reason: "merge handled by the merged path" };
  }
  if (payload.action === "update" && !payload.oldrev) {
    return { handle: false, reason: "update did not change the source revision" };
  }
  if (payload.action === "close" || payload.action === "merge") {
    return { handle: false, reason: `ignored action ${payload.action}` };
  }
  if (!["open", "reopen", "update"].includes(payload.action)) {
    return { handle: false, reason: `ignored action ${payload.action || "unknown"}` };
  }
  if (payload.draft && !config.reviewDrafts) {
    return { handle: false, reason: "ignored draft merge request" };
  }
  return { handle: true };
}

function enqueueMergeRequestJob(input: {
  store: JobStore;
  config: Config;
  connection: OpenedConnection;
  rateLimiter?: RepoRateLimiter;
  deliveryId: string;
  event: string;
  payload: ReturnType<typeof parseMergeRequestEvent>;
}): GitLabWebhookHandleResult {
  const { store, config, connection, payload } = input;
  const scope = { provider: "gitlab", instance: connection.instance.hostname };
  // Instance-wide review pause: same gate as the GitHub path — automatic
  // merge-request deliveries enqueue nothing while the switch is on.
  const globalPause = store.getGlobalPause();
  if (globalPause) {
    store.claimWebhookDelivery(input.deliveryId, input.event, "paused (global)", {
      provider: "gitlab",
      instance: connection.instance.hostname,
    });
    return ignored("reviews paused globally");
  }
  if (store.hasMergedPull(payload.projectPath, payload.mrIid, scope)) {
    return ignored("merge request already merged; not enqueueing");
  }
  const rateOn = config.repoRateLimitPerWindow > 0 && config.repoRateWindowMs > 0;
  const rateKey = `gitlab:${connection.instance.hostname}:${payload.projectId}`;
  if (rateOn && input.rateLimiter && !input.rateLimiter.wouldAllowKey(rateKey, config.repoRateLimitPerWindow, config.repoRateWindowMs)) {
    return ignored("rate limited");
  }
  const enqueue = enqueuePullJob(store, config, {
    repoFullName: payload.projectPath,
    repoOwner: payload.repoOwner,
    repoName: payload.repoName,
    installationId: payload.projectId,
    provider: "gitlab",
    providerInstance: connection.instance.hostname,
    forgeConnectionId: connection.row.id,
    prNumber: payload.mrIid,
    prTitle: payload.mrTitle,
    prBody: payload.authorUsername ? `_authored by ${payload.authorUsername}_` : "",
    prHtmlUrl: payload.mrUrl,
    prAuthor: payload.authorUsername,
    baseSha: "",
    headSha: payload.headSha,
    baseRef: payload.targetBranch,
    headRef: payload.sourceBranch,
    webhookDeliveryId: input.deliveryId,
    webhookEvent: `${input.event}.${payload.action}`,
  });
  if (enqueue.created && rateOn && input.rateLimiter) {
    input.rateLimiter.recordKey(rateKey, config.repoRateLimitPerWindow, config.repoRateWindowMs);
  }
  // Claim the delivery only after handling: a crash before here lets the
  // redelivery retry instead of reporting duplicate.
  store.claimWebhookDelivery(input.deliveryId, input.event, enqueue.created ? "enqueued" : "skipped", {
    provider: "gitlab",
    instance: connection.instance.hostname,
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
}

async function handleMergeRequestEvent(input: {
  store: JobStore;
  config: Config;
  connection: OpenedConnection;
  rateLimiter?: RepoRateLimiter;
  request: GitLabWebhookRequest;
  deliveryId: string;
  abortJobs?: (jobIds: number[]) => void;
}): Promise<GitLabWebhookHandleResult> {
  let payload: ReturnType<typeof parseMergeRequestEvent>;
  try {
    payload = parseMergeRequestEvent(input.request.rawBody);
  } catch (error) {
    return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
  }
  const scope = { provider: "gitlab", instance: input.connection.instance.hostname };

  if (payload.state === "merged" || payload.action === "merge") {
    // Record the merged marker BEFORE cancelling, mirroring the GitHub path:
    // the gate must exist even when no job was active at merge time.
    input.store.markPullMerged(payload.projectPath, payload.mrIid, input.deliveryId || null, scope);
    const { cancelledJobIds } = cancelJobsForPull(
      input.store,
      {
        repoFullName: payload.projectPath,
        prNumber: payload.mrIid,
        scope,
        reason: "pr_merged",
        note: input.deliveryId ? `webhook delivery ${input.deliveryId}` : undefined,
        onCancelled: input.abortJobs,
      },
    );
    input.store.claimWebhookDelivery(
      input.deliveryId,
      input.request.event,
      "pr_merged_cancel",
      scope,
    );
    return {
      status: 200,
      body: { ok: true, cancelled: cancelledJobIds.length, cancelledJobIds },
    };
  }

  const decision = shouldHandleMergeRequest(input.config, payload);
  if (!decision.handle) {
    return ignored(decision.reason ?? "ignored");
  }
  return enqueueMergeRequestJob({
    store: input.store,
    config: input.config,
    connection: input.connection,
    rateLimiter: input.rateLimiter,
    deliveryId: input.deliveryId,
    event: input.request.event,
    payload,
  });
}

async function handleNoteEvent(input: {
  store: JobStore;
  config: Config;
  connection: OpenedConnection;
  request: GitLabWebhookRequest;
  deliveryId: string;
  gitlab: GitLabCommandApi;
}): Promise<GitLabWebhookHandleResult> {
  const { store, connection } = input;
  let payload: GitLabNoteEvent;
  try {
    payload = JSON.parse(input.request.rawBody) as GitLabNoteEvent;
  } catch {
    return { status: 400, body: { error: "invalid JSON" } };
  }
  const note = payload.object_attributes;
  if (note?.noteable_type !== "MergeRequest" || !payload.merge_request?.iid) {
    return ignored("note is not on a merge request");
  }
  if (note.action !== "created") {
    return ignored(`ignored note action ${note.action ?? "unknown"}`);
  }
  const projectId = payload.project?.id;
  const projectPath = payload.project?.path_with_namespace;
  const noteId = note.id;
  const mrIid = payload.merge_request.iid;
  if (!Number.isSafeInteger(projectId) || !projectPath || !Number.isSafeInteger(noteId) || !Number.isSafeInteger(mrIid)) {
    return { status: 400, body: { error: "note payload is missing project, note id, or merge request iid" } };
  }

  const actorId = payload.user?.id;
  const actorUsername = payload.user?.username;
  if (!actorId || !actorUsername) {
    return ignored("note payload is missing the author");
  }
  // Review-loop guard: the connection's own bot identity never triggers work.
  if (connection.row.bot_user_id != null && actorId === connection.row.bot_user_id) {
    return ignored("ignored bot-authored note");
  }

  const body = note.note ?? "";
  // Maomao's own marker comments (escalation banners, reviews, findings) are
  // dead on arrival regardless of whether the connection has a probed bot
  // identity — finding bodies quote the diff, so they can carry planted text.
  if (commentLooksLikeMaomaoEscalation(body) || parseFindingMarker(body)) {
    return ignored("ignored maomao marker comment");
  }
  const command = parseOverrideCommand(body);
  const escalate = mentionsEscalateCommand(body, input.config.poisonAlert.mentionName, input.config.poisonAlert.escalateCommand);
  if (!command && !escalate) {
    return ignored("not a maomao command");
  }

  const scope = { provider: "gitlab", instance: connection.instance.hostname };
  // The escalate branch never reads discussions; only the dismiss/reopen
  // branches pay the lookup cost.
  let discussions: ForgeDiscussion[] = [];
  if (!escalate) {
    const listed = await input.gitlab.listDiscussions(projectId!, mrIid!);
    if (listed.truncated) {
      // A truncated listing cannot prove the note is outside a Maomao
      // discussion; leave the delivery unclaimed so a redelivery can try
      // again. GitLab never shows response bodies, so the log is the only
      // human-visible trace of the dropped command.
      console.error(
        `gitlab webhook: discussion listing exceeded the processing cap for connection ${connection.row.id} project ${projectId} MR ${mrIid} note ${noteId}; command not applied`,
      );
      return {
        status: 200,
        body: { ok: true, warning: "discussion list exceeded the processing cap; command not applied" },
      };
    }
    discussions = toForgeDiscussions(listed.discussions);
  }
  const noteDiscussion = discussions.find((discussion) =>
    discussion.comments.some((candidate) => candidate.databaseId === noteId),
  );

  const memberLevel = await input.gitlab.getAccessLevel(projectId!, actorId);
  const permission = accessLevelToPermission(memberLevel);
  if (
    !isAllowlistedOverrideAuthor({
      login: actorUsername,
      permission,
      allowlist: input.config.overrideAuthors,
      appSlug: input.config.github.appSlug,
    })
  ) {
    store.claimWebhookDelivery(input.deliveryId, input.request.event, "unauthorized", scope);
    return {
      status: 202,
      body: { ok: true, ignored: true, reason: "actor is not authorized", actor: actorUsername, permission },
    };
  }

  const latest = store.findLatestJobForPull(projectPath!, mrIid!, undefined, scope);
  if (escalate) {
    if (!latest) {
      return ignored("no maomao job for this merge request");
    }
    if (latest.state === "cancelled" || latest.state === "stale") {
      return ignored(`job for this merge request is ${latest.state}; not escalating`);
    }
    store.patchJob(latest.id, { manual_escalate_requested: 1 });
    store.log(latest.id, `Authorized escalate command from ${actorUsername}`);
    store.claimWebhookDelivery(input.deliveryId, input.request.event, "escalate", scope);
    return {
      status: 202,
      body: { ok: true, dispatchJobId: latest.id, headSha: latest.head_sha },
      dispatchJobId: latest.id,
    };
  }

  const fingerprints = threadFingerprintIndex(discussions);
  const fingerprint = fingerprints.get(String(noteId));
  const marker = noteDiscussion
    ? noteDiscussion.comments.map((candidate) => parseFindingMarker(candidate.body)).find(Boolean)
    : undefined;
  if (!fingerprint && !marker) {
    store.claimWebhookDelivery(input.deliveryId, input.request.event, "not-maomao-thread", scope);
    return ignored("note is not inside a Maomao finding discussion");
  }
  const resolvedFingerprint = fingerprint ?? marker!.id;
  const markerSha = marker?.sha ?? "";
  const noteBody = sanitizeCommentText(body);

  if (command!.command === "dismiss") {
    const result = store.dismissFinding({
      repoFullName: projectPath!,
      prNumber: mrIid!,
      fingerprint: resolvedFingerprint,
      scope,
      actor: actorUsername,
      command: command!.token,
      reviewedSha: markerSha || latest?.head_sha || "",
      summary: noteBody || resolvedFingerprint,
      githubThreadId: noteDiscussion?.id,
      githubCommentId: String(noteId),
    });
    try {
      if (noteDiscussion) {
        await input.gitlab.resolveDiscussion(projectId!, mrIid!, noteDiscussion.id, true);
      }
    } catch (error) {
      // Dismissal is persisted; the next successful review retries the resolve.
      store.claimWebhookDelivery(input.deliveryId, input.request.event, "dismiss", scope);
      return {
        status: 200,
        body: { ok: true, command: command!.token, fingerprint: resolvedFingerprint, changed: result.changed, threadResolved: false, warning: error instanceof Error ? error.message : String(error) },
      };
    }
    store.claimWebhookDelivery(input.deliveryId, input.request.event, "dismiss", scope);
    store.claimReviewCommand(String(noteId), input.deliveryId, command!.token, "ok", scope);
    return {
      status: 200,
      body: { ok: true, command: command!.token, fingerprint: resolvedFingerprint, changed: result.changed, status: "dismissed" },
    };
  }

  // reopen
  const result = store.reopenFinding({
    repoFullName: projectPath!,
    prNumber: mrIid!,
    fingerprint: resolvedFingerprint,
    scope,
    actor: actorUsername,
    command: command!.token,
    reviewedSha: markerSha || latest?.head_sha || "",
    summary: noteBody || resolvedFingerprint,
    githubThreadId: noteDiscussion?.id,
    githubCommentId: String(noteId),
  });
  try {
    if (noteDiscussion) {
      await input.gitlab.resolveDiscussion(projectId!, mrIid!, noteDiscussion.id, false);
    }
  } catch (error) {
    store.claimWebhookDelivery(input.deliveryId, input.request.event, "reopen", scope);
    return {
      status: 200,
      body: { ok: true, command: command!.token, fingerprint: resolvedFingerprint, changed: result.changed, threadUnresolved: false, warning: error instanceof Error ? error.message : String(error) },
    };
  }
  store.claimWebhookDelivery(input.deliveryId, input.request.event, "reopen", scope);
  store.claimReviewCommand(String(noteId), input.deliveryId, command!.token, "ok", scope);
  return {
    status: 200,
    body: { ok: true, command: command!.token, fingerprint: resolvedFingerprint, changed: result.changed, status: "open" },
  };
}

export async function handleGitLabWebhook(input: {
  config: Config;
  store: JobStore;
  connections: ForgeConnectionStore;
  rateLimiter?: RepoRateLimiter;
  request: GitLabWebhookRequest;
  connectionId: string;
  /** Queued aborts for cancelled jobs; wired from the server like the GitHub path. */
  abortJobs?: (jobIds: number[]) => void;
  gitlabFactory?: (connection: OpenedConnection) => GitLabCommandApi;
}): Promise<GitLabWebhookHandleResult> {
  const { store, request } = input;
  let connection: OpenedConnection;
  try {
    connection = input.connections.open(input.connectionId);
  } catch {
    return { status: 404, body: { error: "unknown connection" } };
  }
  if (connection.row.enabled !== 1) {
    return ignored("connection is disabled");
  }

  const verification = verifyGitLabWebhook({
    body: request.rawBody,
    secret: connection.webhookSecret,
    webhookId: request.webhookId,
    webhookTimestamp: request.webhookTimestamp,
    webhookSignature: request.webhookSignature,
    legacyToken: request.legacyToken,
  });
  if (!verification.ok) {
    return { status: 401, body: { error: verification.reason } };
  }

  if (request.event.toLowerCase() === "ping" || request.event.toLowerCase() === "ping hook") {
    return { status: 200, body: { ok: true, event: "ping" } };
  }
  let parsed: GitLabMergeRequestEvent;
  try {
    parsed = JSON.parse(request.rawBody) as GitLabMergeRequestEvent;
  } catch {
    return { status: 400, body: { error: "invalid JSON" } };
  }
  if (parsed.object_kind !== "merge_request" && parsed.object_kind !== "note") {
    return ignored(`event ${parsed.object_kind || "unknown"}`);
  }
  if (!withinScope(connection, parsed.project ?? {})) {
    return ignored("event is outside the connection scope");
  }
  // Review-loop guard: anything the connection's bot authored is dropped
  // before idempotency claims, so bot-driven replays cannot wedge deliveries.
  if (connection.row.bot_user_id != null && parsed.user?.id === connection.row.bot_user_id) {
    return ignored("ignored bot-authored event");
  }

  const deliveryId = deliveryIdFrom(
    {
      "webhook-id": request.webhookId,
      "x-gitlab-event-uuid": request.eventUuid,
      "x-gitlab-webhook-uuid": request.webhookUuid,
    },
    request.event,
    `${connection.row.id}:${request.rawBody}`,
  );
  const scope = { provider: "gitlab", instance: connection.instance.hostname };
  try {
    if (deliveryId && store.hasWebhookDelivery(deliveryId, scope)) {
      return { status: 200, body: { ok: true, duplicate: true, reason: "duplicate delivery" } };
    }

    if (parsed.object_kind === "merge_request") {
      return await handleMergeRequestEvent({
        store,
        config: input.config,
        connection,
        rateLimiter: input.rateLimiter,
        request,
        deliveryId,
        abortJobs: input.abortJobs,
      });
    }
    return await handleNoteEvent({
      store,
      config: input.config,
      connection,
      request,
      deliveryId,
      gitlab: (input.gitlabFactory ?? ((opened: OpenedConnection) => new GitLabApiClient(opened)))(connection),
    });
  } catch (error) {
    // An escaped API failure would otherwise become Hono's bare 500 with no
    // log at all; log it so the operator can see GitLab delivery failures.
    // Permanent upstream failures (expired/rotated tokens answering 401)
    // ride this same path: GitLab retries 5xx with backoff and eventually
    // auto-disables the webhook, which is the operator-visible signal.
    const sanitize = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, " ");
    const message = sanitize(error instanceof Error ? error.message : String(error));
    console.error(
      `gitlab webhook: handling failed for ${sanitize(request.event)} delivery ${sanitize(deliveryId || "unknown")}: ${message}`,
    );
    return { status: 500, body: { error: "webhook handling failed; see server logs" } };
  }
}
