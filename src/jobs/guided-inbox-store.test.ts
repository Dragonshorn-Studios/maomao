import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { JobStore } from "./store.js";

function seedOpenPull(store: JobStore, prNumber: number, repoFullName = "acme/widgets") {
  store.upsertGuidedInboxPull({
    installationId: 9,
    repoFullName,
    prNumber,
    prTitle: `pull ${prNumber}`,
    prHtmlUrl: `https://example.test/${prNumber}`,
    prAuthor: "dev",
    baseSha: "base",
    headSha: `head-${prNumber}`,
    draft: false,
    state: "open",
  });
}

describe("guided inbox pull cache lifecycle", () => {
  it("does not close cache rows touched after the sync snapshot started", () => {
    const store = new JobStore(openDb(":memory:"));
    seedOpenPull(store, 7);
    const past = new Date(Date.now() - 60_000).toISOString();

    store.closeMissingGuidedInboxPulls("acme/widgets", [], past);
    expect(store.listGuidedInboxPulls().map((row) => row.pr_number)).toEqual([7]);

    const future = new Date(Date.now() + 60_000).toISOString();
    store.closeMissingGuidedInboxPulls("acme/widgets", [], future);
    expect(store.listGuidedInboxPulls()).toEqual([]);
  });

  it("sweeps only missing repositories and preserves rows in listed repositories", () => {
    const store = new JobStore(openDb(":memory:"));
    seedOpenPull(store, 7, "acme/widgets");
    seedOpenPull(store, 8, "acme/other");
    const future = new Date(Date.now() + 60_000).toISOString();

    store.closeMissingGuidedInboxRepos(["acme/widgets"], future);
    expect(store.listGuidedInboxPulls().map((row) => `${row.repo_full_name}#${row.pr_number}`)).toEqual(["acme/widgets#7"]);
  });

  it("prunes closed rows after the retention cutoff", () => {
    const store = new JobStore(openDb(":memory:"));
    seedOpenPull(store, 7);
    store.markGuidedInboxPullClosed("acme/widgets", 7);

    store.pruneClosedGuidedInboxPulls(-1_000);
    const cached = (store as unknown as { db: { prepare(sql: string): { get(): { count: number } } } })
      .db.prepare("SELECT COUNT(*) AS count FROM guided_inbox_pulls")
      .get();
    expect(cached.count).toBe(0);
  });
});
