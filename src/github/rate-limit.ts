/** In-memory sliding window keyed by stable GitHub repository id. Per-process only. */
export class RepoRateLimiter {
  private readonly hits = new Map<number, number[]>();

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
    return this.windowed(repositoryId, windowMs).length < limit;
  }

  /** Record an accepted event. No-op when limiting is disabled. */
  record(repositoryId: number, limit: number, windowMs: number): void {
    if (!this.enabled(limit, windowMs) || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      return;
    }
    const now = this.clock();
    const prior = this.windowed(repositoryId, windowMs);
    prior.push(now);
    this.hits.set(repositoryId, prior);
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

  private windowed(repositoryId: number, windowMs: number): number[] {
    const now = this.clock();
    this.prune(now, windowMs);
    return (this.hits.get(repositoryId) ?? []).filter((stamp) => stamp > now - windowMs);
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
