import type { ForgePort } from "../forge/port.js";
import type { ForgeRegistry } from "../forge/registry.js";
import type { ForgeMergeCapabilities, ForgeMergeMode, MergeCapabilityReport } from "../forge/types.js";
import type { JobRow } from "../jobs/store.js";
import { forgeTargetOf } from "../forge/types.js";
import type { MergeModeSettingsStore } from "./settings.js";

const TTL_MS = 60_000;

export function unavailableMergeCapabilities(reason: string, source = "unavailable"): ForgeMergeCapabilities {
  return {
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
  constructor(private readonly forge: ForgeRegistry, private readonly ttlMs = TTL_MS, private readonly mergeModes?: MergeModeSettingsStore) {}

  forJob(job: JobRow): Promise<MergeCapabilityReport> {
    const mergeMode = this.modeFor(job);
    if (mergeMode === "disabled") {
      return Promise.resolve({
        ...unavailableMergeCapabilities("Merge integration is disabled by operator policy", "operator-policy"),
        mergeMode,
      });
    }
    const key = [job.provider, job.provider_instance, job.repo_full_name, job.pr_number].join("\0");
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) return this.withMode(job, hit.value, mergeMode);
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
    // Probe evidence is cached because it costs forge API calls; operator policy
    // is local and deliberately read fresh so opt-in/opt-out is not delayed.
    return this.withMode(job, value, mergeMode);
  }

  private modeFor(job: JobRow) {
    return this.mergeModes?.effective({
      provider: job.provider ?? undefined,
      instance: job.provider_instance ?? undefined,
      repoFullName: job.repo_full_name,
    }) ?? "manual";
  }

  private withMode(job: JobRow, value: Promise<ForgeMergeCapabilities>, mergeMode: ForgeMergeMode): Promise<MergeCapabilityReport> {
    return value.then((capabilities) => {
      const reasons = [...capabilities.reasons];
      if (mergeMode === "native_auto_merge" && capabilities.nativeAutoMerge !== "available") {
        reasons.push("Configured native auto-merge is not currently detected as available for this pull request");
      }
      if (mergeMode === "github_native_queue" && capabilities.githubNativeQueue !== "available") {
        reasons.push("Configured GitHub native queue is not currently detected as available for this base branch");
      }
      return { ...capabilities, mergeMode, reasons };
    });
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
