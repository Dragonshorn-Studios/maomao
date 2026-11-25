import { createHmac, timingSafeEqual } from "node:crypto";

function equalHex(secret: string, rawBody: string, supplied: string, prefixed: boolean): boolean {
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const candidate = prefixed ? `sha256=${digest}` : digest;
  const a = Buffer.from(candidate);
  const b = Buffer.from(supplied.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Forgejo signs the raw JSON body with HMAC-SHA256; accept its native bare hex and GitHub-compatible header. */
export function verifyForgejoWebhook(secret: string, rawBody: string, headers: { forgejoSignature?: string; hubSignature256?: string;
  gogsSignature?: string; giteaSignature?: string }): boolean {
  if (!secret) return false;
  if (headers.forgejoSignature && equalHex(secret, rawBody, headers.forgejoSignature, false)) return true;
  if (headers.giteaSignature && equalHex(secret, rawBody, headers.giteaSignature, false)) return true;
  if (headers.gogsSignature && equalHex(secret, rawBody, headers.gogsSignature, false)) return true;
  if (headers.hubSignature256 && equalHex(secret, rawBody, headers.hubSignature256, true)) return true;
  return false;
}
