import { describe, expect, it } from "vitest";
import {
  cookieSecure,
  isPublicPath,
  passwordsMatch,
  safeNextPath,
  signSession,
  uiGateEnabled,
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
