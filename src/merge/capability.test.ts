import { describe, expect, it } from "vitest";
import { MergeCapabilityService, unavailableMergeCapabilities } from "./capability.js";
import type { ForgeRegistry } from "../forge/registry.js";
import type { ForgeMergeCapabilities } from "../forge/types.js";
import type { JobRow } from "../jobs/store.js";

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
  mergeMode: "manual",
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
    expect(unavailableMergeCapabilities("x")).toMatchObject({ mergeMode: "manual", mergeMethods: [], reasons: ["x"] });
  });
});
