import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { openDb } from "../db.js";
import type { GithubPort } from "../github/client.js";
import type { CheckoutPort } from "../checkout.js";
import type { OpenCodePort } from "../opencode/parse.js";
import { createPipeline } from "./pipeline.js";
import { JobStore } from "./store.js";

async function fixtureCheckout(): Promise<CheckoutPort> {
  return {
    async prepare(input) {
      const dir = await mkdtemp(join(tmpdir(), "maomao-ws-"));
      const repoDir = join(dir, "repo");
      await mkdir(repoDir, { recursive: true });
      await writeFile(join(repoDir, "example.ts"), "export const n = 1;\n");
      const diffPath = join(dir, "pr.diff");
      const metaPath = join(dir, "pr.json");
      await writeFile(diffPath, await input.fetchDiff());
      await writeFile(metaPath, JSON.stringify(input.metadata));
      return { dir, repoDir, diffPath, metaPath };
    },
    async cleanup() {},
  };
}

function reviewerJson(role: string, summary = "bug") {
  return JSON.stringify({
    schema_version: 1,
    reviewer: role,
    verdict: "findings",
    findings: [
      {
        severity: "high",
        confidence: 0.9,
        category: role,
        file: "example.ts",
        line: 1,
        summary,
        reason: "because the diff says so",
      },
    ],
  });
}

describe("JobStore enqueue", () => {
  it("is unique per repo + PR + SHA and stales older SHAs", () => {
    const store = new JobStore(openDb(":memory:"));
    const base = {
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 1,
      prNumber: 3,
      prTitle: "t",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "a",
      baseSha: "b",
      baseRef: "main",
      headRef: "f",
      reviewers: [{ role: "correctness", title: "Correctness" }],
    };
    const first = store.enqueue({ ...base, headSha: "aaa" });
    const dup = store.enqueue({ ...base, headSha: "aaa" });
    const next = store.enqueue({ ...base, headSha: "bbb" });
    expect(first.created).toBe(true);
    expect(dup.created).toBe(false);
    expect(next.created).toBe(true);
    expect(store.getJob(first.job.id)?.state).toBe("stale");
    expect(store.listReviewerRuns(first.job.id)).toHaveLength(1);
  });
});

describe("pipeline", () => {
  it("runs reviewers, aggregates, and posts a COMMENT review for the job SHA", async () => {
    const config = loadConfig({
      REVIEWER_ROLES: "correctness,security",
      OPENCODE_REVIEWER_MODEL: "test/model",
      OPENCODE_TIMEOUT_MS: "5000",
      POST_EMPTY_REVIEW: "true",
      GITHUB_APP_ID: "1",
      GITHUB_WEBHOOK_SECRET: "s",
      GITHUB_APP_PRIVATE_KEY: "k",
    });
    const store = new JobStore(openDb(":memory:"));
    const posted: { event?: string; commitId: string; body: string }[] = [];
    const github: GithubPort = {
      getInstallationToken: async () => "token",
      getPullDiff: async () => "diff --git a/example.ts b/example.ts\n",
      listReviews: async () => [],
      createCommentReview: async (input) => {
        posted.push({ commitId: input.commitId, body: input.body });
        expect(input.body).toContain("maomao-review");
        return { id: "99", url: "https://example.test/reviews/99" };
      },
    };
    const opencode: OpenCodePort = {
      async run(input) {
        const roleMatch = input.prompt.match(/Role id: (\w+)/);
        const text = roleMatch
          ? reviewerJson(roleMatch[1])
          : JSON.stringify({
              schema_version: 1,
              verdict: "comment",
              summary: "Please fix the high finding.",
              findings: [
                {
                  severity: "high",
                  confidence: 0.8,
                  category: "correctness",
                  file: "example.ts",
                  line: 1,
                  summary: "bug",
                  body: "details",
                },
              ],
            });
        return { stdout: text, stderr: "", exitCode: 0, text, usage: { promptTokens: 3, completionTokens: 2 } };
      },
    };
    const created = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 9,
      prNumber: 4,
      prTitle: "Change example",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "dev",
      baseSha: "base",
      headSha: "cafebabe",
      baseRef: "main",
      headRef: "feat",
      reviewers: config.reviewers.map((role) => ({ role: role.id, title: role.title })),
    });
    const pipeline = createPipeline({
      config,
      store,
      github,
      checkout: await fixtureCheckout(),
      opencode,
    });
    await pipeline.run(created.job.id);
    const job = store.getJob(created.job.id);
    expect(job?.state).toBe("completed");
    expect(job?.github_review_id).toBe("99");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.commitId).toBe("cafebabe");
    const runs = store.listReviewerRuns(created.job.id);
    expect(runs.every((run) => run.state === "done")).toBe(true);
    expect(JSON.parse(job?.aggregator_normalized ?? "{}").verdict).toBe("comment");
  });

  it("does not publish after a job is marked stale", async () => {
    const config = loadConfig({
      REVIEWER_ROLES: "correctness",
      OPENCODE_REVIEWER_MODEL: "test/model",
    });
    const store = new JobStore(openDb(":memory:"));
    let reviews = 0;
    const github: GithubPort = {
      getInstallationToken: async () => "token",
      getPullDiff: async () => "diff",
      listReviews: async () => [],
      createCommentReview: async () => {
        reviews += 1;
        return { id: "1", url: "u" };
      },
    };
    const opencode: OpenCodePort = {
      async run() {
        store.enqueue({
          repoFullName: "acme/widgets",
          repoOwner: "acme",
          repoName: "widgets",
          installationId: 9,
          prNumber: 4,
          prTitle: "later",
          prBody: "",
          prHtmlUrl: "",
          prAuthor: "dev",
          baseSha: "base",
          headSha: "newsha",
          baseRef: "main",
          headRef: "feat",
          reviewers: [{ role: "correctness", title: "Correctness" }],
        });
        return {
          stdout: reviewerJson("correctness"),
          stderr: "",
          exitCode: 0,
          text: reviewerJson("correctness"),
          usage: {},
        };
      },
    };
    const created = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 9,
      prNumber: 4,
      prTitle: "old",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "dev",
      baseSha: "base",
      headSha: "oldsha",
      baseRef: "main",
      headRef: "feat",
      reviewers: [{ role: "correctness", title: "Correctness" }],
    });
    const pipeline = createPipeline({
      config,
      store,
      github,
      checkout: await fixtureCheckout(),
      opencode,
    });
    await pipeline.run(created.job.id);
    expect(store.getJob(created.job.id)?.state).toBe("stale");
    expect(reviews).toBe(0);
  });

  it("does not post a second review when a marker already exists", async () => {
    const config = loadConfig({ REVIEWER_ROLES: "correctness", POST_EMPTY_REVIEW: "true" });
    const store = new JobStore(openDb(":memory:"));
    let creates = 0;
    const github: GithubPort = {
      getInstallationToken: async () => "token",
      getPullDiff: async () => "diff",
      listReviews: async () => [{ id: 5, body: "<!-- maomao-review sha=abc -->", htmlUrl: "https://r" }],
      createCommentReview: async () => {
        creates += 1;
        return { id: "x", url: "u" };
      },
    };
    const opencode: OpenCodePort = {
      async run(input) {
        const text = input.prompt.includes("aggregator")
          ? JSON.stringify({ verdict: "clean", summary: "ok", findings: [] })
          : JSON.stringify({ reviewer: "correctness", verdict: "clean", findings: [] });
        return { stdout: text, stderr: "", exitCode: 0, text, usage: {} };
      },
    };
    const created = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 9,
      prNumber: 4,
      prTitle: "t",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "dev",
      baseSha: "base",
      headSha: "abc",
      baseRef: "main",
      headRef: "feat",
      reviewers: [{ role: "correctness", title: "Correctness" }],
    });
    await createPipeline({
      config,
      store,
      github,
      checkout: await fixtureCheckout(),
      opencode,
    }).run(created.job.id);
    expect(creates).toBe(0);
    expect(store.getJob(created.job.id)?.github_review_id).toBe("5");
  });

  it("marks leftover reviewers failed when checkout throws", async () => {
    const config = loadConfig({ REVIEWER_ROLES: "correctness,security" });
    const store = new JobStore(openDb(":memory:"));
    const created = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 9,
      prNumber: 4,
      prTitle: "t",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "dev",
      baseSha: "base",
      headSha: "abc",
      baseRef: "main",
      headRef: "feat",
      reviewers: [
        { role: "correctness", title: "Correctness" },
        { role: "security", title: "Security" },
      ],
    });
    await createPipeline({
      config,
      store,
      github: {
        getInstallationToken: async () => "token",
        getPullDiff: async () => "diff",
        listReviews: async () => [],
        createCommentReview: async () => ({ id: "x", url: "u" }),
      },
      checkout: {
        async prepare() {
          throw new Error("boom");
        },
        async cleanup() {},
      },
      opencode: {
        async run() {
          throw new Error("should not run");
        },
      },
    }).run(created.job.id);
    expect(store.getJob(created.job.id)?.state).toBe("failed");
    expect(store.listReviewerRuns(created.job.id).every((run) => run.state === "failed")).toBe(true);
  });

  it("fails the job when the installation token cannot be minted", async () => {
    const config = loadConfig({ REVIEWER_ROLES: "correctness" });
    const store = new JobStore(openDb(":memory:"));
    let prepared = 0;
    const created = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 9,
      prNumber: 4,
      prTitle: "t",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "dev",
      baseSha: "base",
      headSha: "abc",
      baseRef: "main",
      headRef: "feat",
      reviewers: [{ role: "correctness", title: "Correctness" }],
    });
    await createPipeline({
      config,
      store,
      github: {
        getInstallationToken: async () => {
          throw new Error("could not mint installation token");
        },
        getPullDiff: async () => "diff",
        listReviews: async () => [],
        createCommentReview: async () => ({ id: "x", url: "u" }),
      },
      checkout: {
        async prepare() {
          prepared += 1;
          throw new Error("should not checkout without a token");
        },
        async cleanup() {},
      },
      opencode: {
        async run() {
          throw new Error("should not run");
        },
      },
    }).run(created.job.id);
    expect(prepared).toBe(0);
    expect(store.getJob(created.job.id)?.state).toBe("failed");
    expect(store.getJob(created.job.id)?.failure_reason).toContain("installation token");
  });
});
