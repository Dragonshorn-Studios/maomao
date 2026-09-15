import { describe, expect, it } from "vitest";
import {
  cookieSecure,
  isPublicPath,
  issueCsrfToken,
  passwordsMatch,
  safeNextPath,
  signSession,
  uiGateEnabled,
  verifyCsrfRequest,
  verifyCsrfToken,
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
    const expired = issueCsrfToken("secret", 1_000, 60_000);
    expect(verifyCsrfRequest("secret", expired, expired, 61_001)).toBe(false);
  });
});
