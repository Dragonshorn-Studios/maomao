import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { openDb } from "../db.js";
import { JobStore } from "../jobs/store.js";
import type { CheckoutPort, Workspace } from "../checkout.js";
import type { ForgeRegistry } from "../forge/registry.js";
import type { OpenCodePort } from "../opencode/parse.js";
import { GuidedWalkthroughService } from "./walkthrough.js";
import { guidedWalkthroughFingerprint, GuidedWalkthroughStore, guidedWalkthroughView } from "./walkthrough-store.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const nextHeadSha = "c".repeat(40);

function fixture(outputText?: string, briefCache?: { getRepoBriefCache(provider: string, providerInstance: string, repoFullName: string, sha: string): { payload: string; created_at: string } | undefined }) {
  const db = openDb(":memory:");
  const jobs = new JobStore(db);
  const walkthroughs = new GuidedWalkthroughStore(db);
  const config = loadConfig({
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "k",
    MAOMAO_EXPLAIN_ENABLED: "true",
  });
  const opened = jobs.guidedReview.open({
    actorProvider: "github",
    actorId: "1001",
    provider: "github",
    instance: "github.com",
    repoFullName: "acme/widgets",
    prNumber: 12,
    baseSha,
    headSha,
  });
  const temp = mkdtempSync(join(tmpdir(), "guided-walkthrough-test-"));
  const workspace: Workspace = { dir: join(temp, "work"), repoDir: join(temp, "work", "repo"), diffPath: join(temp, "work", "pr.diff"), metaPath: join(temp, "work", "pr.json") };
  const prepare = vi.fn(async (input: { fetchDiff: () => Promise<string> }) => { await input.fetchDiff(); return workspace; });
  const cleanup = vi.fn(async () => undefined);
  const checkout: CheckoutPort = { prepare, cleanup };
  const cloneSpec = vi.fn(async () => ({ cloneUrl: "https://example.test/repo.git", gitAuthArgs: [], remoteRef: "refs/pull/12/head", secrets: [] }));
  const getChangeDiff = vi.fn(async () => "diff --git a/src/a.ts b/src/a.ts\n");
  const getChange = vi.fn(async () => ({ repoOwner: "acme", repoName: "widgets", repoFullName: "acme/widgets", changeNumber: 12, title: "Add caching", body: "Use a cache.", htmlUrl: "https://example.test/pr/12", author: "dev", baseSha, headSha, baseRef: "main", headRef: "feature", draft: false }));
  const forge = {
    forJob: vi.fn(() => ({ cloneSpec, getChangeDiff, getChange })),
  } as unknown as ForgeRegistry;
  const opencode: OpenCodePort = {
    run: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      text: outputText ?? JSON.stringify({
        intent: { text: "The PR says it adds caching.", uncertainty: "No design doc was present." },
        changeMap: [{ path: "src/a.ts", summary: "Adds the cache.", evidence: "src/a.ts first hunk" }],
        flow: "The request reads cache before the forge.",
        decisions: [{ title: "Exact SHA key", details: "Avoids stale explanations.", evidence: "cache key construction" }],
        tests: "Unit tests cover cache reuse.",
        risks: [{ question: "Does invalidation cover prompt changes?", path: "src/a.ts", line: 8, evidence: "fingerprint input" }],
      }),
      usage: { cost: 0.01 },
    })),
  };
  const service = new GuidedWalkthroughService({ config, store: walkthroughs, forge, opencode, checkout, briefCache });
  return { db, jobs, walkthroughs, config, session: opened.session, service, prepare, cleanup, cloneSpec, getChangeDiff, forge, opencode };
}

async function waitForStatus(store: GuidedWalkthroughStore, id: number, statuses: string[]) {
  await vi.waitFor(() => {
    const row = store.get(id);
    if (!row || !statuses.includes(row.status)) throw new Error(`status is ${row?.status}`);
  }, { timeout: 2000, interval: 10 });
  return store.get(id)!;
}

describe("Guided Review walkthrough cache", () => {
  it("keys cache by exact identity plus model and prompt revision", () => {
    const identity = { provider: "github", instance: "github.com", repoFullName: "acme/widgets", prNumber: 12, baseSha, headSha };
    expect(guidedWalkthroughFingerprint(identity, "m")).toBe(guidedWalkthroughFingerprint({ ...identity }, "m"));
    expect(guidedWalkthroughFingerprint(identity, "m")).not.toBe(guidedWalkthroughFingerprint({ ...identity, headSha: nextHeadSha }, "m"));
    expect(guidedWalkthroughFingerprint(identity, "m")).not.toBe(guidedWalkthroughFingerprint(identity, "other"));
  });

  it("permits only one transition from pending to running and rejects malformed cached payload entries", () => {
    const f = fixture();
    const row = f.walkthroughs.open({ provider: "github", instance: "github.com", repoFullName: "acme/widgets", prNumber: 12, baseSha, headSha }, "m");
    expect(f.walkthroughs.claim(row.id)).toBe(true);
    expect(f.walkthroughs.claim(row.id)).toBe(false);
    const malformed = { ...row, output_json: JSON.stringify({ schema_version: 1, kind: "guided_walkthrough", intent: { text: "i", uncertainty: "u" }, changeMap: [{ path: 3 }], flow: "f", decisions: [], tests: "t", risks: [], generatedAt: "now" }) };
    expect(guidedWalkthroughView(malformed).payload).toBeUndefined();
  });

  it("generates once asynchronously, reuses the same fingerprint, and preserves exact-SHA read-only checkout inputs", async () => {
    const f = fixture();
    const first = f.service.ensure(f.session, 42);
    const again = f.service.ensure(f.session, 42);
    expect(again.id).toBe(first.id);
    const row = await waitForStatus(f.walkthroughs, first.id, ["ready"]);
    const view = guidedWalkthroughView(row);
    expect(view.payload?.intent.text).toContain("adds caching");
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.prepare).toHaveBeenCalledWith(expect.objectContaining({ baseSha, headSha, jobId: first.id, metadata: expect.objectContaining({ title: "Add caching", body: "Use a cache." }) }));
    expect(f.getChangeDiff).toHaveBeenCalledWith(expect.objectContaining({ baseSha, headSha }), expect.any(Number));
    expect(f.opencode.run).toHaveBeenCalledTimes(1);
    expect(f.cleanup).toHaveBeenCalledWith(expect.stringContaining("work"));
  });

  it("marks older head fingerprints stale when a new exact head opens", () => {
    const f = fixture();
    const oldRow = f.walkthroughs.open({ provider: "github", instance: "github.com", repoFullName: "acme/widgets", prNumber: 12, baseSha, headSha }, "m");
    const newRow = f.walkthroughs.open({ provider: "github", instance: "github.com", repoFullName: "acme/widgets", prNumber: 12, baseSha, headSha: nextHeadSha }, "m");
    expect(newRow.id).not.toBe(oldRow.id);
    expect(f.walkthroughs.get(oldRow.id)?.status).toBe("stale");
    expect(f.walkthroughs.get(newRow.id)?.status).toBe("pending");
  });

  it("revives a stale exact-head fingerprint when that head becomes current again", async () => {
    const f = fixture();
    const first = f.walkthroughs.open({ provider: "github", instance: "github.com", repoFullName: "acme/widgets", prNumber: 12, baseSha, headSha }, f.service.model());
    const moved = f.walkthroughs.open({ provider: "github", instance: "github.com", repoFullName: "acme/widgets", prNumber: 12, baseSha, headSha: nextHeadSha }, f.service.model());
    expect(moved.id).not.toBe(first.id);
    expect(f.walkthroughs.get(first.id)?.status).toBe("stale");

    const revived = f.service.ensure(f.session, 42);
    expect(revived.id).toBe(first.id);
    expect(["pending", "running", "ready"]).toContain(revived.status);
    expect(f.walkthroughs.get(moved.id)?.status).toBe("stale");
    const done = await waitForStatus(f.walkthroughs, first.id, ["ready"]);
    expect(done.cancel_requested).toBe(0);
  });

  it("fails closed instead of caching malformed output and supports a deliberate retry", async () => {
    const f = fixture();
    vi.mocked(f.opencode.run).mockImplementationOnce(async () => ({ stdout: "", stderr: "", exitCode: 0, text: "not json", usage: {} }));
    const row = f.service.ensure(f.session, 42);
    const done = await waitForStatus(f.walkthroughs, row.id, ["failed"]);
    expect(done.error).toContain("valid structured JSON");
    expect(f.cleanup).toHaveBeenCalled();

    const retried = f.service.retry(done, 42);
    expect(retried?.status).toBe("pending");
    const ready = await waitForStatus(f.walkthroughs, row.id, ["ready"]);
    expect(ready.request_count).toBe(2);
    expect(f.opencode.run).toHaveBeenCalledTimes(2);
  });

  it("aborts a running generation when the operator cancels it", async () => {
    const f = fixture();
    vi.mocked(f.opencode.run).mockImplementationOnce(({ signal }) => new Promise((_, reject) => {
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const row = f.service.ensure(f.session, 42);
    await waitForStatus(f.walkthroughs, row.id, ["running"]);
    expect(f.service.cancel(f.walkthroughs.get(row.id)!)).toBe(true);
    const done = await waitForStatus(f.walkthroughs, row.id, ["cancelled"]);
    expect(done.error).toContain("aborted");
    expect(f.cleanup).toHaveBeenCalled();
  });

  it("supports cancellation before a pending generation starts", () => {
    const f = fixture();
    const row = f.walkthroughs.open({ provider: "github", instance: "github.com", repoFullName: "acme/widgets", prNumber: 12, baseSha, headSha }, "m");
    expect(f.service.cancel(row)).toBe(true);
    expect(f.walkthroughs.get(row.id)?.status).toBe("cancelled");
    expect(f.service.cancel(f.walkthroughs.get(row.id)!)).toBe(false);
  });

  it("aborts superseded running generations instead of un-staling them on completion", async () => {
    const f = fixture();
    vi.mocked(f.opencode.run).mockImplementationOnce(({ signal }) => new Promise((_, reject) => {
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const oldRow = f.service.ensure(f.session, 42);
    await waitForStatus(f.walkthroughs, oldRow.id, ["running"]);
    const moved = f.service.ensure({ ...f.session, head_sha: nextHeadSha }, 42);
    const stale = await waitForStatus(f.walkthroughs, oldRow.id, ["stale"]);
    expect(stale.cancel_requested).toBe(1);
    const ready = await waitForStatus(f.walkthroughs, moved.id, ["ready"]);
    expect(ready.head_sha).toBe(nextHeadSha);
    const finishedStale = f.walkthroughs.get(oldRow.id)!;
    expect(finishedStale.status).toBe("stale");
    expect(finishedStale.error).toContain("aborted");
  });


  it("enforces the configured generation cost and output bounds", async () => {
    const costly = fixture();
    vi.mocked(costly.opencode.run).mockImplementationOnce(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      text: JSON.stringify({
        intent: { text: "Intent", uncertainty: "Uncertainty" },
        changeMap: [{ path: "src/a.ts", summary: "Summary", evidence: "Evidence" }],
        flow: "Flow",
        decisions: [],
        tests: "Tests",
        risks: [],
      }),
      usage: { cost: 2 },
    }));
    const costRow = costly.service.ensure(costly.session, 42);
    expect((await waitForStatus(costly.walkthroughs, costRow.id, ["failed"])).error).toContain("cost ceiling");

    const large = fixture("x".repeat(80_001));
    const outputRow = large.service.ensure(large.session, 42);
    expect((await waitForStatus(large.walkthroughs, outputRow.id, ["failed"])).error).toContain("output bound");
  });


  it("attaches an exact-SHA cached repo brief as bounded repository context", async () => {
    const briefPayload = JSON.stringify({
      schema_version: 1,
      kind: "repo_brief",
      repo: "acme/widgets",
      sha: headSha,
      generated_at: "now",
      summary: "Repository map",
      sections: [],
    });
    const briefCache = { getRepoBriefCache: vi.fn(() => ({ payload: briefPayload, created_at: "now" })) };
    const f = fixture(undefined, briefCache);
    const row = f.service.ensure(f.session, 42);
    await waitForStatus(f.walkthroughs, row.id, ["ready"]);
    expect(briefCache.getRepoBriefCache).toHaveBeenCalledWith("github", "github.com", "acme/widgets", headSha);
    const input = vi.mocked(f.opencode.run).mock.calls[0]?.[0];
    expect(input?.files?.map((file) => file.split("/").pop())).toEqual(["pr.diff", "pr.json", "repo-brief.json"]);
    expect(input?.prompt).toContain("repo-brief.json");
  });

});
