import type { ForgeScope, WebhookDeliveryContext } from "./types.js";
import { IGNORED_RESULT_PREFIX } from "./types.js";

/** The slice of JobStore the boundary recorder needs — structural, so this
 * module stays forge-layer and doesn't import the concrete store. */
export interface DeliveryClaimStore {
  claimWebhookDelivery(
    deliveryId: string,
    event: string,
    result: string,
    scope?: Partial<ForgeScope>,
    context?: WebhookDeliveryContext,
  ): boolean;
}

/**
 * Delivery log bookkeeping shared by the GitHub and GitLab webhook handlers.
 *
 * The claim sites inside the handlers record specific outcomes ("enqueued",
 * "pr_merged_cancel", command names) at the point where claiming is safe for
 * redelivery. `recordWebhookDelivery` runs at the handler boundary instead:
 * it fills in the deliveries those paths never claimed — everything answered
 * `ignored: true` (unsupported events, non-command comments, out-of-scope
 * actions, paused repos, unauthorized senders) with its reason, plus clean
 * `ok` results that ended without a claim (pings, escalations).
 *
 * Deliberately NOT recorded:
 * - `status >= 400` — signature failures are unverified (possibly spoofed),
 *   malformed bodies carry no trustworthy context, and 5xx must stay
 *   unclaimed so the forge retries.
 * - `ok` results carrying `warning` — those paths leave the delivery
 *   unclaimed on purpose so a redelivery can retry (e.g. truncated GitLab
 *   discussion listings).
 *
 * Ignored rows are observational, not dedup claims: `hasWebhookDelivery`
 * excludes them (the `ignored` column, derived once from
 * IGNORED_RESULT_PREFIX at claim time) so a redelivery of a transiently
 * ignored event (rate limit window passed, a job landed since, the connection
 * was re-enabled) still reprocesses — matching the pre-logging behavior — and
 * a successful retry's claim overwrites the stale ignored result via
 * `claimWebhookDelivery`. Ignored rows still render their `ignored: <reason>`
 * string in the log; the prefix is display text, the column is semantics.
 * Duplicate answers still write context: the INSERT is a no-op for the
 * result, but the claim call backfills repo/action/actor on the existing row.
 */
export function recordWebhookDelivery(input: {
  store: DeliveryClaimStore;
  deliveryId: string;
  event: string;
  rawBody: string;
  result: { status: number; body: Record<string, unknown> };
  scope?: Partial<ForgeScope>;
}): void {
  const { status, body } = input.result;
  if (status >= 400) return;
  const outcome = deliveryOutcome(body);
  if (outcome == null && body.duplicate !== true) return;
  input.store.claimWebhookDelivery(
    input.deliveryId,
    input.event,
    outcome ?? "duplicate",
    input.scope,
    webhookDeliveryContext(input.rawBody),
  );
}

function deliveryOutcome(body: Record<string, unknown>): string | null {
  if (body.ignored === true) {
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason : "no reason recorded";
    return `${IGNORED_RESULT_PREFIX} ${reason}`;
  }
  if (body.ok === true && body.warning == null && body.duplicate !== true) {
    const detail = firstString(body.command) ?? firstString(body.event) ?? firstString(body.reason);
    return detail ? `ok: ${detail}` : "ok";
  }
  return null;
}

/**
 * Shared claim-string for the enqueue path — one formatter so every provider's
 * deliveries log reads identically (`enqueued` / `skipped` / `skipped: <why>`).
 */
export function enqueueClaimResult(enqueue: { created: boolean; skippedReason?: string }): string {
  return enqueue.created ? "enqueued" : `skipped${enqueue.skippedReason ? `: ${enqueue.skippedReason}` : ""}`;
}

function firstString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Extracts display context from the raw payload of either forge's webhook
 * shape (GitHub `repository`/`sender`/`action`, GitLab
 * `project`/`user`/`object_attributes.action`). Malformed bodies yield no
 * context — callers still get a contextless row.
 */
export function webhookDeliveryContext(rawBody: string): WebhookDeliveryContext {
  try {
    const payload = JSON.parse(rawBody) as {
      repository?: { full_name?: string };
      project?: { path_with_namespace?: string };
      action?: string;
      object_attributes?: { action?: string };
      sender?: { login?: string };
      comment?: { user?: { login?: string } };
      pull_request?: { user?: { login?: string } };
      user?: { username?: string; name?: string };
    };
    // Payload fields are untrusted: a signed-but-malformed body could carry
    // non-strings (e.g. full_name: {...}) which better-sqlite3 would reject at
    // bind time — after the handler already ran. Guard every field.
    return {
      repoFullName: firstString(payload.repository?.full_name) ?? firstString(payload.project?.path_with_namespace),
      action: firstString(payload.action) ?? firstString(payload.object_attributes?.action),
      actor:
        firstString(payload.sender?.login) ??
        firstString(payload.comment?.user?.login) ??
        firstString(payload.pull_request?.user?.login) ??
        firstString(payload.user?.username) ??
        firstString(payload.user?.name),
    };
  } catch {
    return {};
  }
}
