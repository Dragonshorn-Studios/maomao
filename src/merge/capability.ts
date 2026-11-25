import type { ForgePort } from "../forge/port.js";
import type { ForgeRegistry } from "../forge/registry.js";
import type { ForgeMergeCapabilities } from "../forge/types.js";
import type { JobRow } from "../jobs/store.js";
import { forgeTargetOf } from "../forge/types.js";

const TTL_MS = 60_000;

export function unavailableMergeCapabilities(reason: string, source = "unavailable"): ForgeMergeCapabilities {
  return {
    mergeMode: "manual",
    nativeAutoMerge: "unknown",
    githubNativeQueue: "unknown",
    requiredStatusContexts: [],
    mergeMethods: [],
    reasons: [reason],
    source,
  };
}

/** Small read-only cache; capability probes are forge API reads and must not run on every render. */
export class MergeCapabilityService {
  private readonly cache = new Map<string, { expires: number; value: Promise<ForgeMergeCapabilities> }>();
  constructor(private readonly forge: ForgeRegistry, private readonly ttlMs = TTL_MS) {}

  forJob(job: JobRow): Promise<ForgeMergeCapabilities> {
    const key = [job.provider, job.provider_instance, job.repo_full_name, job.pr_number].join("\0");
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) return hit.value;
    for (const [cachedKey, entry] of this.cache) {
      if (entry.expires <= now) this.cache.delete(cachedKey);
    }
    const value = Promise.race([
      this.probe(job),
      new Promise<ForgeMergeCapabilities>((resolve) => {
        const timer = setTimeout(() => resolve(unavailableMergeCapabilities("Merge capability probe timed out; native state is unknown")), 8_000);
        timer.unref?.();
      }),
    ]).catch((error) =>
      unavailableMergeCapabilities(`Merge capability probe failed: ${error instanceof Error ? error.message : String(error)}`),
    );
    this.cache.set(key, { expires: now + this.ttlMs, value });
    return value;
  }

  private async probe(job: JobRow): Promise<ForgeMergeCapabilities> {
    let provider: ForgePort;
    try {
      provider = this.forge.forJob(job);
    } catch (error) {
      return unavailableMergeCapabilities(`No forge connection can probe merge capabilities: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!provider.probeMergeCapabilities) {
      return unavailableMergeCapabilities(`The ${provider.provider} adapter does not expose merge capability detection`, `${provider.provider}-unsupported`);
    }
    return provider.probeMergeCapabilities(forgeTargetOf(job));
  }
}
