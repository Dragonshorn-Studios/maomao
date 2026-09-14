import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "maomao_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
  if (!token) return false;
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return false;
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!safeEqual(sig, expected)) return false;
  const [version, expRaw] = payload.split(".");
  if (version !== "v1") return false;
  const exp = Number(expRaw);
  return Number.isFinite(exp) && exp > now;
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
    path === "/assets/maomao.css" ||
    path.startsWith("/assets/")
  );
}

export function cookieSecure(url: string, forwardedProto?: string | null): boolean {
  if (forwardedProto?.split(",")[0]?.trim() === "https") return true;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
