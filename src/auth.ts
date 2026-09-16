import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "maomao_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CSRF_COOKIE = "maomao_csrf";
export const CSRF_TTL_MS = SESSION_TTL_MS;
export const CSRF_FIELD = "csrf_token";

export function uiGateEnabled(password: string, sessionSecret: string): boolean {
  return Boolean(password && sessionSecret);
}

export function safeEqual(a: string, b: string): boolean {
  const digestA = createHmac("sha256", "maomao-eq").update(a).digest();
  const digestB = createHmac("sha256", "maomao-eq").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

export function passwordsMatch(provided: string, expected: string): boolean {
  return safeEqual(provided, expected);
}

export function signSession(secret: string, now = Date.now(), ttlMs = SESSION_TTL_MS): string {
  const payload = `v1.${now + ttlMs}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySession(secret: string, token: string | undefined, now = Date.now()): boolean {
  return verifySignedToken(secret, token, now, 1);
}

export function safeNextPath(raw: string | undefined | null): string {
  if (!raw) return "/";
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return "/";
  }
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value.startsWith("/login") || value.startsWith("/webhooks") || value.startsWith("/logout")) return "/";
  return value;
}

export function isPublicPath(path: string): boolean {
  return (
    path === "/health" ||
    path === "/webhooks/github" ||
    path === "/login" ||
    path === "/logout" ||
    path === "/login/github" ||
    path === "/login/github/callback" ||
    // Stylesheet and brand icons: fixed constants served by src/server.ts.
    path === "/assets/maomao.css" ||
    path === "/assets/favicon.svg" ||
    path === "/assets/favicon.png" ||
    path === "/assets/icon.svg" ||
    path === "/assets/icon.png"
  );
}

export function csrfExemptPath(path: string): boolean {
  return path === "/webhooks/github";
}

export type CsrfRejectReason = "missing-cookie" | "missing-field" | "mismatch" | "bad-token";

export function csrfRejectReason(cookieToken: string | undefined, fieldToken: string | undefined): CsrfRejectReason {
  if (!cookieToken) return "missing-cookie";
  if (!fieldToken) return "missing-field";
  if (!safeEqual(cookieToken, fieldToken)) return "mismatch";
  return "bad-token";
}

export function cookieSecure(url: string, forwardedProto?: string | null): boolean {
  if (forwardedProto?.split(",")[0]?.trim() === "https") return true;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function issueCsrfToken(secret: string, now = Date.now(), ttlMs = CSRF_TTL_MS): string {
  const nonce = randomBytes(16).toString("base64url");
  const payload = `v1.${nonce}.${now + ttlMs}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySignedToken(secret: string, token: string | undefined, now: number, expiryPart: number): boolean {
  if (!token) return false;
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return false;
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!safeEqual(sig, expected)) return false;
  const parts = payload.split(".");
  if (parts[0] !== "v1") return false;
  const exp = Number(parts[expiryPart]);
  return Number.isFinite(exp) && exp > now;
}

export function verifyCsrfToken(secret: string, token: string | undefined, now = Date.now()): boolean {
  return verifySignedToken(secret, token, now, 2);
}

export function verifyCsrfRequest(
  secret: string,
  cookieToken: string | undefined,
  fieldToken: string | undefined,
  now = Date.now(),
): boolean {
  if (!cookieToken || !fieldToken) return false;
  if (!safeEqual(cookieToken, fieldToken)) return false;
  return verifyCsrfToken(secret, cookieToken, now);
}

export interface OAuthSession {
  id: number;
  login: string;
  avatarUrl: string | null;
}

/**
 * OAuth sessions carry the operator identity (stable numeric GitHub id, mutable login and
 * avatar for display only) so the allowlist can be re-checked on every request. The random
 * nonce makes every issued value unique, so each login rotates the session id. Format:
 * `v2.<nonce>.<exp>.<id>.<base64url(login)>.<base64url(avatarUrl)>.<sig>` where the avatar
 * segment is empty when `avatarUrl` is null.
 */
export function signOAuthSession(
  secret: string,
  session: OAuthSession,
  now = Date.now(),
  ttlMs = SESSION_TTL_MS,
): string {
  if (!Number.isInteger(session.id) || session.id <= 0 || !session.login) {
    throw new Error("OAuth sessions require a positive numeric id and a login");
  }
  const nonce = randomBytes(16).toString("base64url");
  const avatar = session.avatarUrl ? Buffer.from(session.avatarUrl, "utf8").toString("base64url") : "";
  const payload = `v2.${nonce}.${now + ttlMs}.${session.id}.${Buffer.from(session.login, "utf8").toString("base64url")}.${avatar}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyOAuthSession(
  secret: string,
  token: string | undefined,
  now = Date.now(),
): OAuthSession | undefined {
  if (!token) return undefined;
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return undefined;
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!safeEqual(sig, expected)) return undefined;
  const [version, nonce, expRaw, idRaw, loginRaw, avatarRaw = ""] = payload.split(".");
  if (version !== "v2" || !nonce || !expRaw || !idRaw || !loginRaw) return undefined;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= now) return undefined;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) return undefined;
  // Buffer.from never throws here: the HMAC above already proved the payload is self-produced.
  const login = Buffer.from(loginRaw, "base64url").toString("utf8");
  if (!login) return undefined;
  const avatar = avatarRaw ? Buffer.from(avatarRaw, "base64url").toString("utf8") : "";
  return { id, login, avatarUrl: avatar.startsWith("https://") ? avatar : null };
}

/**
 * Single-use OAuth `state` values, held in process memory (matching the in-process queue and
 * rate limiter). `consume` deletes on first read, so replays fail; `issue` sweeps expired
 * leftovers, so abandoned flows do not accumulate.
 */
export class OAuthStateStore {
  private readonly entries = new Map<string, { expiresAt: number; next: string }>();

  issue(now: number, ttlMs: number, next = "/"): string {
    for (const [nonce, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(nonce);
    }
    const nonce = randomBytes(16).toString("base64url");
    this.entries.set(nonce, { expiresAt: now + ttlMs, next });
    return nonce;
  }

  consume(nonce: string | undefined, now = Date.now()): string | undefined {
    if (!nonce) return undefined;
    const entry = this.entries.get(nonce);
    if (!entry) return undefined;
    this.entries.delete(nonce);
    if (entry.expiresAt <= now) return undefined;
    return entry.next;
  }
}
