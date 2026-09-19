import { describe, expect, it } from "vitest";
import {
  OAuthStateStore,
  cookieSecure,
  csrfExemptPath,
  csrfRejectReason,
  isPublicPath,
  issueCsrfToken,
  passwordsMatch,
  safeNextPath,
  signOAuthSession,
  signSession,
  uiGateEnabled,
  verifyCsrfRequest,
  verifyCsrfToken,
  verifyOAuthSession,
  verifySession,
} from "./auth.js";

describe("session helpers", () => {
  it("round-trips a signed session and rejects tampering or expiry", () => {
    const token = signSession("secret", 1_000, 60_000);
    expect(verifySession("secret", token, 1_500)).toBe(true);
    expect(verifySession("other", token, 1_500)).toBe(false);
    expect(verifySession("secret", token.slice(0, -2) + "ab", 1_500)).toBe(false);
    expect(verifySession("secret", token, 100_000)).toBe(false);
  });

  it("compares passwords without throwing on length mismatch", () => {
    expect(passwordsMatch("pw", "pw")).toBe(true);
    expect(passwordsMatch("pw", "no")).toBe(false);
    expect(passwordsMatch("", "x")).toBe(false);
  });

  it("only allows same-origin relative next paths", () => {
    expect(safeNextPath("/jobs/3")).toBe("/jobs/3");
    expect(safeNextPath("https://evil.test")).toBe("/");
    expect(safeNextPath("//evil.test")).toBe("/");
    expect(safeNextPath("/login")).toBe("/");
    expect(safeNextPath("/webhooks/github")).toBe("/");
  });

  it("keeps webhook and health public", () => {
    expect(isPublicPath("/health")).toBe(true);
    expect(isPublicPath("/webhooks/github")).toBe(true);
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/api/jobs")).toBe(false);
    expect(isPublicPath("/events")).toBe(false);
    expect(isPublicPath("/assets/maomao.css")).toBe(true);
    expect(isPublicPath("/assets/")).toBe(false);
    expect(isPublicPath("/assets/other.css")).toBe(false);
    expect(isPublicPath("/assets/maomao.css.bak")).toBe(false);
  });

  it("sets Secure only for HTTPS", () => {
    expect(cookieSecure("http://127.0.0.1:3000/login")).toBe(false);
    expect(cookieSecure("https://maomao.example/login")).toBe(true);
    expect(cookieSecure("http://maomao.example/login", "https")).toBe(true);
  });

  it("enables the UI gate only when password and session secret are both set", () => {
    expect(uiGateEnabled("", "")).toBe(false);
    expect(uiGateEnabled("pw", "")).toBe(false);
    expect(uiGateEnabled("", "secret")).toBe(false);
    expect(uiGateEnabled("pw", "secret")).toBe(true);
  });
});

describe("csrf tokens", () => {
  it("issues unique signed tokens that verify before expiry", () => {
    const first = issueCsrfToken("secret", 1_000, 60_000);
    const second = issueCsrfToken("secret", 1_000, 60_000);
    expect(first).not.toBe(second);
    expect(verifyCsrfToken("secret", first, 1_500)).toBe(true);
    expect(verifyCsrfToken("secret", first, 60_500)).toBe(true);
    expect(verifyCsrfToken("secret", first, 61_001)).toBe(false);
  });

  it("rejects tampered, foreign, and malformed csrf tokens", () => {
    const token = issueCsrfToken("secret", 1_000, 60_000);
    expect(verifyCsrfToken("other", token, 1_500)).toBe(false);
    expect(verifyCsrfToken("secret", token.slice(0, -2) + "ab", 1_500)).toBe(false);
    expect(verifyCsrfToken("secret", undefined, 1_500)).toBe(false);
    expect(verifyCsrfToken("secret", "", 1_500)).toBe(false);
    expect(verifyCsrfToken("secret", "garbage", 1_500)).toBe(false);
    expect(verifyCsrfToken("secret", "v2.abc.9999999999999.sig", 1_500)).toBe(false);
  });

  it("requires matching, valid cookie and field values", () => {
    const token = issueCsrfToken("secret", 1_000, 60_000);
    expect(verifyCsrfRequest("secret", token, token, 1_500)).toBe(true);
    expect(verifyCsrfRequest("secret", token, undefined, 1_500)).toBe(false);
    expect(verifyCsrfRequest("secret", undefined, token, 1_500)).toBe(false);
    expect(verifyCsrfRequest("secret", token, issueCsrfToken("secret", 1_000, 60_000), 1_500)).toBe(false);
    expect(verifyCsrfRequest("secret", token, token, 61_001)).toBe(false);
  });

  it("classifies rejection reasons for logging", () => {
    const token = issueCsrfToken("secret", 1_000, 60_000);
    expect(csrfRejectReason(undefined, undefined)).toBe("missing-cookie");
    expect(csrfRejectReason(token, undefined)).toBe("missing-field");
    expect(csrfRejectReason(token, issueCsrfToken("secret", 1_000, 60_000))).toBe("mismatch");
    expect(csrfRejectReason("v1.tampered", "v1.tampered")).toBe("bad-token");
  });

  it("keeps the webhook as the only csrf-exempt path", () => {
    expect(csrfExemptPath("/webhooks/github")).toBe(true);
    expect(csrfExemptPath("/webhooks/github/extra")).toBe(false);
    expect(csrfExemptPath("/login")).toBe(false);
    expect(csrfExemptPath("/reviews")).toBe(false);
    expect(csrfExemptPath("/health")).toBe(false);
  });
});

describe("oauth sessions", () => {
  const session = { id: 1001, login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/1001" };

  it("round-trips an oauth session and rejects tampering or expiry", () => {
    const token = signOAuthSession("secret", session, 1_000, 60_000);
    expect(verifyOAuthSession("secret", token, 1_500)).toEqual(session);
    expect(verifyOAuthSession("other", token, 1_500)).toBeUndefined();
    const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    expect(verifyOAuthSession("secret", tampered, 1_500)).toBeUndefined();
    expect(verifyOAuthSession("secret", token, 61_000)).toBeUndefined();
    expect(verifyOAuthSession("secret", undefined, 1_500)).toBeUndefined();
    expect(verifyOAuthSession("secret", "garbage", 1_500)).toBeUndefined();
  });

  it("keeps avatar urls only when they are https", () => {
    const without = signOAuthSession("secret", { ...session, avatarUrl: null }, 1_000, 60_000);
    expect(verifyOAuthSession("secret", without, 1_500)?.avatarUrl).toBeNull();
    const insecure = signOAuthSession("secret", { ...session, avatarUrl: "http://evil.test/a.png" }, 1_000, 60_000);
    expect(verifyOAuthSession("secret", insecure, 1_500)?.avatarUrl).toBeNull();
  });

  it("issues a fresh value on every login (rotation)", () => {
    const first = signOAuthSession("secret", session, 1_000, 60_000);
    const second = signOAuthSession("secret", session, 1_000, 60_000);
    expect(first).not.toBe(second);
  });
});

describe("oauth state store", () => {
  it("consumes a state exactly once and returns its next path", () => {
    const states = new OAuthStateStore();
    const nonce = states.issue(1_000, 60_000, "/jobs/3");
    expect(states.consume(nonce, 1_500)).toBe("/jobs/3");
    expect(states.consume(nonce, 1_500)).toBeUndefined();
  });

  it("rejects expired, missing, or foreign states", () => {
    const states = new OAuthStateStore();
    const nonce = states.issue(1_000, 60_000);
    expect(states.consume(nonce, 61_000)).toBeUndefined();
    expect(states.consume(undefined)).toBeUndefined();
    expect(states.consume("not-a-nonce")).toBeUndefined();
  });
});
describe("gitlab webhook path exemptions", () => {
  it("treats the gitlab webhook route as public and CSRF-exempt", () => {
    expect(isPublicPath("/webhooks/gitlab/abc-123")).toBe(true);
    expect(isPublicPath("/webhooks/gitlab/abc-123/extra")).toBe(true);
    expect(csrfExemptPath("/webhooks/gitlab/abc-123")).toBe(true);
    // Only the webhook prefix is public; the connections page stays gated.
    expect(isPublicPath("/webhooks/gitlab")).toBe(false);
    expect(isPublicPath("/connections")).toBe(false);
  });
});
