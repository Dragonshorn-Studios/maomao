import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { JOBS_PAGE_SIZE_MAX } from "../config.js";
import { JobStore } from "./store.js";

function seedInto(store: JobStore, count: number): void {
  for (let index = 0; index < count; index += 1) {
    store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 1,
      prNumber: index + 1,
      prTitle: `job ${index + 1}`,
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "dev",
      baseSha: "b",
      headSha: `sha-${index + 1}`,
      baseRef: "main",
      headRef: "f",
      reviewers: [],
    });
  }
}

function seededStore(count: number): JobStore {
  const store = new JobStore(openDb(":memory:"));
  seedInto(store, count);
  return store;
}

/** Returns the raw handle alongside the store for tests that delete rows. */
function seededStoreWithDb(count: number): { store: JobStore; db: ReturnType<typeof openDb> } {
  const db = openDb(":memory:");
  const store = new JobStore(db);
  seedInto(store, count);
  return { store, db };
}

describe("listJobsPage", () => {
  it("serves the newest jobs first with the default page size", () => {
    const store = seededStore(30);
    const page = store.listJobsPage({});
    expect(page.jobs).toHaveLength(25);
    expect(page.jobs[0]?.pr_number).toBe(30);
    expect(page.jobs[24]?.pr_number).toBe(6);
    expect(page.hasOlder).toBe(true);
    expect(page.hasNewer).toBe(false);
  });

  it("walks the whole history forward and back without duplicates or gaps", () => {
    const store = seededStore(60);
    const seenForward: number[] = [];
    let cursor: { before?: number } = {};
    let oldestPage = store.listJobsPage({});
    for (;;) {
      const page = store.listJobsPage(cursor);
      oldestPage = page;
      seenForward.push(...page.jobs.map((job) => job.pr_number));
      expect(page.hasNewer).toBe(cursor.before != null);
      if (!page.hasOlder) break;
      cursor = { before: page.jobs[page.jobs.length - 1]!.id };
    }
    expect(seenForward).toHaveLength(60);
    // Strictly descending, no duplicates.
    expect(new Set(seenForward).size).toBe(60);
    expect([...seenForward].sort((a, b) => b - a)).toEqual(seenForward);

    // Walk back up: "Newer jobs" from the oldest page carries after = that
    // page's NEWEST id, and each subsequent page does the same.
    let afterCursor = { after: oldestPage.jobs[0]!.id };
    const seenBack: number[] = [];
    for (;;) {
      const page = store.listJobsPage(afterCursor);
      seenBack.push(...page.jobs.map((job) => job.pr_number));
      if (!page.hasNewer) break;
      afterCursor = { after: page.jobs[0]!.id };
    }
    // The back-walk covers everything except the oldest page, no duplicates,
    // and each page is newest-first.
    expect(new Set(seenBack).size).toBe(seenBack.length);
    expect([...seenBack].sort((a, b) => b - a)).toEqual(seenForward.slice(0, 50));
    expect(seenBack[0]).toBe(35);
  });

  it("does not reshuffle an open cursor window when new jobs arrive", () => {
    const store = seededStore(30);
    const firstPage = store.listJobsPage({});
    const boundary = firstPage.jobs[firstPage.jobs.length - 1]!.id;
    const older = store.listJobsPage({ before: boundary });
    const olderIds = older.jobs.map((job) => job.id);

    // Three new jobs queue while the operator browses the older page.
    seededStoreAppend(store, 3);
    const reopened = store.listJobsPage({ before: boundary });
    expect(reopened.jobs.map((job) => job.id)).toEqual(olderIds);
    expect(reopened.hasNewer).toBe(true);
  });

  it("handles a deleted boundary row, final partial pages, and empty stores", () => {
    const { store, db } = seededStoreWithDb(30);
    const firstPage = store.listJobsPage({});
    const boundary = firstPage.jobs[firstPage.jobs.length - 1]!.id;
    db.prepare(`DELETE FROM jobs WHERE id = ?`).run(boundary);
    const older = store.listJobsPage({ before: boundary });
    expect(older.jobs).toHaveLength(5); // jobs 1..5 remain below the deleted boundary
    expect(older.hasOlder).toBe(false);
    expect(older.hasNewer).toBe(true);

    const partial = seededStore(7);
    const partialPage = partial.listJobsPage({});
    expect(partialPage.jobs).toHaveLength(7);
    expect(partialPage.hasOlder).toBe(false);

    const empty = new JobStore(openDb(":memory:"));
    const emptyPage = empty.listJobsPage({});
    expect(emptyPage.jobs).toEqual([]);
    expect(emptyPage.hasOlder).toBe(false);
    expect(emptyPage.hasNewer).toBe(false);
  });

  it("clamps the page size", () => {
    const store = seededStore(150);
    expect(store.listJobsPage({ limit: 500 }).jobs).toHaveLength(JOBS_PAGE_SIZE_MAX);
    expect(store.listJobsPage({ limit: 0 }).jobs).toHaveLength(1);
  });

  it("treats out-of-range cursors safely", () => {
    const store = seededStore(5);
    // A before cursor beyond the newest id: everything is older, so the newest
    // page is served (the route never shows an empty dead end).
    const beyond = store.listJobsPage({ before: 999_999 });
    expect(beyond.jobs).toHaveLength(5);
    expect(beyond.hasOlder).toBe(false);
    // A before cursor below the oldest id: empty, with a way back.
    const below = store.listJobsPage({ before: 1 });
    expect(below.jobs).toEqual([]);
    expect(below.hasOlder).toBe(false);
    expect(below.hasNewer).toBe(true);
    // An after cursor beyond the newest id: nothing newer.
    const aboveNewest = store.listJobsPage({ after: 999_999 });
    expect(aboveNewest.jobs).toEqual([]);
    expect(aboveNewest.hasNewer).toBe(false);
    expect(aboveNewest.hasOlder).toBe(true);
  });
});

function seededStoreAppend(store: JobStore, count: number): void {
  const existing = store.listJobs(1)[0];
  const start = existing?.pr_number ?? 0;
  for (let index = 0; index < count; index += 1) {
    store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 1,
      prNumber: start + index + 1,
      prTitle: `job ${start + index + 1}`,
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "dev",
      baseSha: "b",
      headSha: `sha-${start + index + 1}`,
      baseRef: "main",
      headRef: "f",
      reviewers: [],
    });
  }
}
