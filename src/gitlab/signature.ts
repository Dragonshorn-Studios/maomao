/**
 * GitLab webhook verification. Two mechanisms, per the GitLab webhook docs:
 *
 * - Signing tokens (newer GitLab): headers `webhook-id`, `webhook-timestamp`,
 *   `webhook-signature` (space-separated `v1,base64` HMAC-SHA256 list) over
 *   the string `{webhook-id}.{webhook-timestamp}.{body}`, with the signing
 *   secret formatted `whsec_<base64>` (prefix stripped, base64-decoded).
 * - Legacy secret tokens: the configured secret is sent verbatim in
 *   `X-Gitlab-Token`; compared constant-time.
 *
 * The connection stores whichever secret kind the operator configured; a
 * `whsec_` secret enables the signature path (replay-protected via the
 * timestamp window), a plain secret enables the legacy path.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "v1,";
/** Replay window for the webhook-timestamp header (GitLab: "validate it is recent"). */
export const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

export function computeSignature(signingSecret: string | Buffer, webhookId: string, timestamp: string, body: string): string {
  const digest = createHmac("sha256", signingSecret).update(`${webhookId}.${timestamp}.${body}`).digest("base64");
  return `${SIGNATURE_PREFIX}${digest}`;
}

/** Decodes a `whsec_`-prefixed signing secret into its raw HMAC key bytes. */
export function decodeSigningSecret(secret: string): Buffer | undefined {
  if (!secret.startsWith("whsec_")) return undefined;
  const raw = Buffer.from(secret.slice("whsec_".length), "base64");
  return raw.length > 0 ? raw : undefined;
}

export interface VerificationInput {
  body: string;
  secret: string;
  /** Whichever of the headers the sender actually supplied (possibly undefined). */
  webhookId?: string;
  webhookTimestamp?: string;
  webhookSignature?: string;
  legacyToken?: string;
  nowMs?: number;
}

export interface VerificationResult {
  ok: boolean;
  reason?: string;
}

export function verifyGitLabWebhook(input: VerificationInput): VerificationResult {
  const signingKey = decodeSigningSecret(input.secret);
  if (signingKey) {
    // Signature path: all three headers must be present and recent.
    if (input.webhookSignature == null || input.webhookId == null || input.webhookTimestamp == null) {
      return { ok: false, reason: "signature headers missing for signing-token connection" };
    }
    const timestampMs = Number(input.webhookTimestamp) * 1000;
    if (!Number.isFinite(timestampMs)) {
      return { ok: false, reason: "webhook-timestamp is not a unix timestamp" };
    }
    const now = input.nowMs ?? Date.now();
    if (Math.abs(now - timestampMs) > TIMESTAMP_TOLERANCE_MS) {
      return { ok: false, reason: "webhook-timestamp is outside the replay window" };
    }
    const expected = computeSignature(signingKey, input.webhookId, input.webhookTimestamp, input.body);
    const provided = input.webhookSignature.split(/\s+/).filter((part) => part.startsWith(SIGNATURE_PREFIX));
    const match = provided.some((candidate) => constantTimeEquals(candidate, expected));
    if (!match) {
      return { ok: false, reason: "webhook signature mismatch" };
    }
    return { ok: true };
  }

  // Legacy path: constant-time comparison of the configured token.
  if (!input.legacyToken) {
    return { ok: false, reason: "webhook token header missing" };
  }
  if (!constantTimeEquals(input.legacyToken, input.secret)) {
    return { ok: false, reason: "webhook token mismatch" };
  }
  return { ok: true };
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Burn comparable time so mismatched lengths do not short-circuit faster.
    createHmac("sha256", "burn").update(right).digest();
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Idempotency key for a delivery: the signed webhook id when present, then
 * the event UUID, then the webhook UUID, then a deterministic hash of the
 * delivery's content so retried unsigned deliveries still deduplicate.
 */
export function deliveryIdFrom(headers: Record<string, string | undefined>, event: string, fallbackContent: string): string {
  const id = headers["webhook-id"] ?? headers["x-gitlab-event-uuid"] ?? headers["x-gitlab-webhook-uuid"];
  if (id) return id;
  return createHmac("sha256", "gitlab-delivery").update(`${event}:${fallbackContent}`).digest("hex").slice(0, 32);
}
