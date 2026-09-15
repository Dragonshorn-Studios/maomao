import { describe, expect, it } from "vitest";
import { RepoRateLimiter, WindowRateLimiter } from "./rate-limit.js";

describe("RepoRateLimiter", () => {
  it("allows up to the window limit per repository id", () => {
    let now = 1_000;
    const limiter = new RepoRateLimiter(() => now);
    expect(limiter.allow(11, 2, 1_000)).toBe(true);
    expect(limiter.allow(11, 2, 1_000)).toBe(true);
    expect(limiter.allow(11, 2, 1_000)).toBe(false);
    expect(limiter.allow(12, 2, 1_000)).toBe(true);
    now = 2_001;
    expect(limiter.allow(11, 2, 1_000)).toBe(true);
  });

  it("is disabled when the limit is zero", () => {
    const limiter = new RepoRateLimiter();
    expect(limiter.allow(11, 0, 1_000)).toBe(true);
    expect(limiter.allow(11, 0, 1_000)).toBe(true);
  });

  it("peeks without recording and prunes expired repository windows", () => {
    let now = 1_000;
    const limiter = new RepoRateLimiter(() => now);
    expect(limiter.wouldAllow(11, 1, 1_000)).toBe(true);
    expect(limiter.size()).toBe(0);
    expect(limiter.allow(11, 1, 1_000)).toBe(true);
    expect(limiter.wouldAllow(11, 1, 1_000)).toBe(false);
    expect(limiter.size()).toBe(1);
    now = 2_001;
    expect(limiter.wouldAllow(11, 1, 1_000)).toBe(true);
    expect(limiter.size()).toBe(0);
  });

  it("fails closed for missing repository ids when limiting is enabled", () => {
    const limiter = new RepoRateLimiter();
    expect(limiter.wouldAllow(0, 1, 1_000)).toBe(false);
    expect(limiter.wouldAllow(Number.NaN, 1, 1_000)).toBe(false);
    expect(limiter.wouldAllow(0, 0, 1_000)).toBe(true);
  });
});

describe("WindowRateLimiter", () => {
  it("enforces the per-key limit boundary", () => {
    let now = 1_000;
    const limiter = new WindowRateLimiter(() => now);
    expect(limiter.wouldAllow("ip", 2, 60_000)).toBe(true);
    limiter.record("ip", 2, 60_000);
    limiter.record("ip", 2, 60_000);
    expect(limiter.wouldAllow("ip", 2, 60_000)).toBe(false);
    limiter.record("ip", 2, 60_000);
    expect(limiter.wouldAllow("ip", 2, 60_000)).toBe(false);
  });

  it("allows again after the window expires and isolates keys", () => {
    let now = 1_000;
    const limiter = new WindowRateLimiter(() => now);
    for (let i = 0; i < 3; i += 1) limiter.record("a", 3, 10_000);
    expect(limiter.wouldAllow("a", 3, 10_000)).toBe(false);
    expect(limiter.wouldAllow("b", 3, 10_000)).toBe(true);
    now = 11_500;
    expect(limiter.wouldAllow("a", 3, 10_000)).toBe(true);
  });
});
