/** In-memory sliding window keyed by stable GitHub repository id. */
export class RepoRateLimiter {
  private readonly hits = new Map<number, number[]>();

  constructor(private readonly clock: () => number = Date.now) {}

  /**
   * Record an event for `repositoryId` and return whether it is within the window.
   * `limit <= 0` or `windowMs <= 0` disables limiting.
   */
  allow(repositoryId: number, limit: number, windowMs: number): boolean {
    if (limit <= 0 || windowMs <= 0 || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      return true;
    }
    const now = this.clock();
    const windowStart = now - windowMs;
    const prior = (this.hits.get(repositoryId) ?? []).filter((stamp) => stamp > windowStart);
    if (prior.length >= limit) {
      this.hits.set(repositoryId, prior);
      return false;
    }
    prior.push(now);
    this.hits.set(repositoryId, prior);
    return true;
  }
}
