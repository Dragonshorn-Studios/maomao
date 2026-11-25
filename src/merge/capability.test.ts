import { describe, expect, it } from "vitest";
import { MergeCapabilityService, unavailableMergeCapabilities } from "./capability.js";
import type { ForgeRegistry } from "../forge/registry.js";
import type { ForgeMergeCapabilities } from "../forge/types.js";
import type { JobRow } from "../jobs/store.js";
import { openDb } from "../db.js";
import { MergeModeSettingsStore } from "./settings.js";

const job = {
  provider: "github",
  provider_instance: "github.com",
  repo_owner: "acme",
  repo_name: "widgets",
  repo_full_name: "acme/widgets",
  pr_number: 7,
  installation_id: 1,
} as JobRow;

const capabilities: ForgeMergeCapabilities = {
  nativeAutoMerge: "available",
  githubNativeQueue: "unavailable",
  requiredStatusContexts: [],
  mergeMethods: [],
  reasons: [],
  source: "test",
};

describe("MergeCapabilityService", () => {
  it("caches read-only probes briefly per pull request", async () => {
    let calls = 0;
    const registry = {
      forJob: () => ({ provider: "github", probeMergeCapabilities: async () => { calls += 1; return capabilities; } }),
    } as unknown as ForgeRegistry;
    const service = new MergeCapabilityService(registry, 60_000);
    await service.forJob(job);
    await service.forJob(job);
    expect(calls).toBe(1);
  });

  it("overlays the operator-configured merge mode without changing probe evidence", async () => {
    const settings = new MergeModeSettingsStore(openDb(":memory:"));
    settings.save({ provider: "github", providerInstance: "github.com", repoFullName: "acme/widgets", mergeMode: "github_native_queue", actor: "octocat" });
    const registry = {
      forJob: () => ({ provider: "github", probeMergeCapabilities: async () => capabilities }),
    } as unknown as ForgeRegistry;
    const service = new MergeCapabilityService(registry, 60_000, settings);
    const result = await service.forJob(job);
    expect(result.mergeMode).toBe("github_native_queue");
    expect(result.githubNativeQueue).toBe("unavailable");
    expect(result.reasons.join(" ")).toContain("Configured GitHub native queue");
    settings.save({ provider: "github", providerInstance: "github.com", repoFullName: "acme/widgets", mergeMode: "disabled", actor: "octocat" });
    expect((await service.forJob(job)).mergeMode).toBe("disabled");
  });

  it("does not probe the forge when merge integration is disabled", async () => {
    const settings = new MergeModeSettingsStore(openDb(":memory:"));
    settings.save({ provider: "github", providerInstance: "github.com", repoFullName: "acme/widgets", mergeMode: "disabled", actor: "octocat" });
    let calls = 0;
    const registry = {
      forJob: () => ({ provider: "github", probeMergeCapabilities: async () => { calls += 1; return capabilities; } }),
    } as unknown as ForgeRegistry;
    const result = await new MergeCapabilityService(registry, 60_000, settings).forJob(job);
    expect(calls).toBe(0);
    expect(result).toMatchObject({ mergeMode: "disabled", nativeAutoMerge: "unknown", source: "operator-policy" });
  });

  it("fails closed to an explained unknown when the adapter cannot probe", async () => {
    const registry = { forJob: () => ({ provider: "gitlab" }) } as unknown as ForgeRegistry;
    const result = await new MergeCapabilityService(registry).forJob(job);
    expect(result).toMatchObject({ mergeMode: "manual", nativeAutoMerge: "unknown", githubNativeQueue: "unknown", mergeMethods: [] });
    expect(result.reasons[0]).toContain("does not expose merge capability detection");
  });

  it("turns probe errors into diagnostics instead of throwing from job rendering", async () => {
    const registry = { forJob: () => { throw new Error("missing connection"); } } as unknown as ForgeRegistry;
    const result = await new MergeCapabilityService(registry).forJob(job);
    expect(result.reasons[0]).toContain("missing connection");
  });

  it("uses manual read-only mode for unavailable fallbacks", () => {
    expect(unavailableMergeCapabilities("x")).toMatchObject({ mergeMethods: [], reasons: ["x"] });
  });
});
