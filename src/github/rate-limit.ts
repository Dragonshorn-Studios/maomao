/**
 * In-memory sliding window keyed by a stable repository identity — GitHub
 * numeric repository ids, or `provider:instance:project` strings for other
 * forges (issue #18). Per-process only.
 */
export class RepoRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly clock: () => number = Date.now) {}

  /** True when this limiter is configured to enforce a positive windowed cap. */
  enabled(limit: number, windowMs: number): boolean {
    return limit > 0 && windowMs > 0;
  }

  /**
   * Whether `repositoryId` is still inside the window. Does not record a hit.
   * `limit <= 0` or `windowMs <= 0` disables limiting.
   */
  wouldAllow(repositoryId: number, limit: number, windowMs: number): boolean {
    if (!this.enabled(limit, windowMs)) return true;
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) return false;
    return this.wouldAllowKey(String(repositoryId), limit, windowMs);
  }

  /** String-keyed variant for forge scopes (e.g. gitlab:gitlab.com:42). */
  wouldAllowKey(key: string, limit: number, windowMs: number): boolean {
    if (!this.enabled(limit, windowMs)) return true;
    if (!key) return false;
    return this.windowed(key, windowMs).length < limit;
  }

  /** Record an accepted event. No-op when limiting is disabled. */
  record(repositoryId: number, limit: number, windowMs: number): void {
    if (!this.enabled(limit, windowMs) || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      return;
    }
    this.recordKey(String(repositoryId), limit, windowMs);
  }

  /** String-keyed variant for forge scopes. */
  recordKey(key: string, limit: number, windowMs: number): void {
    if (!this.enabled(limit, windowMs) || !key) return;
    const now = this.clock();
    const prior = this.windowed(key, windowMs);
    prior.push(now);
    this.hits.set(key, prior);
  }

  /**
   * Record an event for `repositoryId` and return whether it is within the window.
   * Prefer `wouldAllow` + `record` when the hit should land only after work is created.
   */
  allow(repositoryId: number, limit: number, windowMs: number): boolean {
    if (!this.wouldAllow(repositoryId, limit, windowMs)) return false;
    this.record(repositoryId, limit, windowMs);
    return true;
  }

  /** Test helper: number of repository keys currently retained. */
  size(): number {
    return this.hits.size;
  }

  private windowed(key: string, windowMs: number): number[] {
    const now = this.clock();
    this.prune(now, windowMs);
    return (this.hits.get(key) ?? []).filter((stamp) => stamp > now - windowMs);
  }

  private prune(now: number, windowMs: number): void {
    const windowStart = now - windowMs;
    for (const [id, stamps] of this.hits) {
      const kept = stamps.filter((stamp) => stamp > windowStart);
      if (kept.length === 0) this.hits.delete(id);
      else this.hits.set(id, kept);
    }
  }
}

export function repoRateLimitActive(limit: number, windowMs: number): boolean {
  return limit > 0 && windowMs > 0;
}

/** In-memory sliding window keyed by an arbitrary string (e.g. OAuth flow counters). Per-process only. */
export class WindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly clock: () => number = Date.now) {}

  wouldAllow(key: string, limit: number, windowMs: number): boolean {
    if (limit <= 0 || windowMs <= 0) return true;
    return this.windowed(key, windowMs).length < limit;
  }

  record(key: string, limit: number, windowMs: number): void {
    if (limit <= 0 || windowMs <= 0) return;
    const now = this.clock();
    const prior = this.windowed(key, windowMs);
    prior.push(now);
    this.hits.set(key, prior);
  }

  private windowed(key: string, windowMs: number): number[] {
    const now = this.clock();
    const windowStart = now - windowMs;
    for (const [existingKey, stamps] of this.hits) {
      const kept = stamps.filter((stamp) => stamp > windowStart);
      if (kept.length === 0) this.hits.delete(existingKey);
      else this.hits.set(existingKey, kept);
    }
    return (this.hits.get(key) ?? []).filter((stamp) => stamp > now - windowMs);
  }
}
