import { describe, expect, it } from "vitest";
import { RepoRateLimiter } from "./rate-limit.js";

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
});
