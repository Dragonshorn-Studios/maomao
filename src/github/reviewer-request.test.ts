import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { JobStore } from "../jobs/store.js";
import { loadConfig } from "../config.js";
import { maomaoBotLogins } from "./client.js";
import { registerQueuedReviewer } from "./reviewer-request.js";

interface RequestedCall {
  installationId: number;
  owner: string;
  repo: string;
  pullNumber: number;
  reviewers: string[];
}

function badgeGithub(overrides: { slug?: string; failWith?: Error; omitRequest?: boolean } = {}) {
  const requested: RequestedCall[] = [];
  const slugCalls: number[] = [];
  const github = {
    getAppSlug: async () => {
      slugCalls.push(1);
      return overrides.slug ?? "";
    },
    ...(overrides.omitRequest
      ? {}
      : {
          requestReviewers: async (input: {
            installationId: number;
            owner: string;
            repo: string;
            pullNumber: number;
            reviewers: string[];
          }) => {
            if (overrides.failWith) throw overrides.failWith;
            requested.push({ ...input, reviewers: [...input.reviewers] });
          },
        }),
  };
  return { github, requested, slugCalls };
}

function enqueuedJob(store: JobStore) {
  return store.enqueue({
    repoFullName: "acme/widgets",
    repoOwner: "acme",
    repoName: "widgets",
    installationId: 42,
    prNumber: 7,
    prTitle: "Add frob",
    prBody: "",
    prHtmlUrl: "https://github.com/acme/widgets/pull/7",
    prAuthor: "octocat",
    baseSha: "base111",
    headSha: "head222",
    baseRef: "main",
    headRef: "feature",
    reviewers: [],
  }).job;
}

function configWith(env: Record<string, string> = {}) {
  return loadConfig({
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "k",
    ...env,
  });
}

describe("registerQueuedReviewer", () => {
  it("does nothing unless the flag is on", async () => {
    const store = new JobStore(openDb(":memory:"));
    const job = enqueuedJob(store);
    const { github, requested } = badgeGithub();
    await registerQueuedReviewer({ github, config: configWith(), store, job });
    expect(requested).toEqual([]);
    expect(store.listLogs(job.id)).toHaveLength(0);
  });

  it("requests the bot login from the env slug and logs the registration", async () => {
    const store = new JobStore(openDb(":memory:"));
    const job = enqueuedJob(store);
    const { github, requested, slugCalls } = badgeGithub({ slug: "fetched-slug" });
    await registerQueuedReviewer({
      github,
      config: configWith({ GITHUB_REQUEST_REVIEWER_ON_ENQUEUE: "true", GITHUB_APP_SLUG: "maomao" }),
      store,
      job,
    });
    expect(requested).toEqual([
      { installationId: 42, owner: "acme", repo: "widgets", pullNumber: 7, reviewers: ["maomao[bot]"] },
    ]);
    // The env slug wins — no App API lookup.
    expect(slugCalls).toHaveLength(0);
    expect(store.listLogs(job.id).at(-1)?.message).toContain("maomao[bot]");
  });

  it("falls back to the fetched app slug when the env slug is unset", async () => {
    const store = new JobStore(openDb(":memory:"));
    const job = enqueuedJob(store);
    const { github, requested, slugCalls } = badgeGithub({ slug: "fetched-slug" });
    await registerQueuedReviewer({
      github,
      config: configWith({ GITHUB_REQUEST_REVIEWER_ON_ENQUEUE: "true" }),
      store,
      job,
    });
    expect(slugCalls).toHaveLength(1);
    expect(requested[0]?.reviewers).toEqual(["fetched-slug[bot]"]);
  });

  it("warns on the job log and never throws when GitHub refuses the request", async () => {
    const store = new JobStore(openDb(":memory:"));
    const job = enqueuedJob(store);
    const { github } = badgeGithub({ failWith: new Error("422 Validation Failed") });
    await expect(
      registerQueuedReviewer({
        github,
        config: configWith({ GITHUB_REQUEST_REVIEWER_ON_ENQUEUE: "true", GITHUB_APP_SLUG: "maomao" }),
        store,
        job,
      }),
    ).resolves.toBeUndefined();
    const last = store.listLogs(job.id).at(-1);
    expect(last?.level).toBe("warn");
    expect(last?.message).toContain("422 Validation Failed");
  });

  it("skips silently when the port cannot request reviewers (demo/test clients)", async () => {
    const store = new JobStore(openDb(":memory:"));
    const job = enqueuedJob(store);
    const { github } = badgeGithub({ omitRequest: true });
    await registerQueuedReviewer({
      github,
      config: configWith({ GITHUB_REQUEST_REVIEWER_ON_ENQUEUE: "true", GITHUB_APP_SLUG: "maomao" }),
      store,
      job,
    });
    expect(store.listLogs(job.id)).toHaveLength(0);
  });

  it("skips non-github jobs", async () => {
    const store = new JobStore(openDb(":memory:"));
    const { github, requested } = badgeGithub();
    await registerQueuedReviewer({
      github,
      config: configWith({ GITHUB_REQUEST_REVIEWER_ON_ENQUEUE: "true", GITHUB_APP_SLUG: "maomao" }),
      store,
      job: { id: 999, provider: "gitlab", installation_id: 0, repo_owner: "a", repo_name: "b", pr_number: 1 },
    });
    expect(requested).toEqual([]);
  });
});

describe("maomaoBotLogins", () => {
  it("builds the bot login with and without the suffix", () => {
    expect(maomaoBotLogins("maomao")).toEqual(["maomao[bot]", "maomao"]);
    expect(maomaoBotLogins("maomao[bot]")).toEqual(["maomao[bot]", "maomao"]);
  });
});
