import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { openDb } from "../db.js";
import type { GithubPort } from "../github/client.js";
import type { CheckoutPort } from "../checkout.js";
import type { OpenCodePort } from "../opencode/parse.js";
import { createPipeline } from "./pipeline.js";
import { JobStore } from "./store.js";
import { DiffTooLargeError } from "../github/diff-limit.js";

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

  it("persists the OpenCode token breakdown and incomplete usage flag", async () => {
    const config = loadConfig({
      REVIEWER_ROLES: "correctness",
      OPENCODE_REVIEWER_MODEL: "test/model",
      POST_EMPTY_REVIEW: "true",
    });
    const store = new JobStore(openDb(":memory:"));
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
      reviewers: [{ role: "correctness", title: "Correctness" }],
    });
    await createPipeline({
      config,
      store,
      github: {
        getInstallationToken: async () => "token",
        getPullDiff: async () => "diff",
        listReviews: async () => [],
        createCommentReview: async () => ({ id: "1", url: "u" }),
      },
      checkout: await fixtureCheckout(),
      opencode: {
        async run(input) {
          const specialist = input.prompt.includes("Role id:");
          const text = specialist
            ? reviewerJson("correctness")
            : JSON.stringify({ verdict: "comment", summary: "ok", findings: [] });
          return {
            stdout: text,
            stderr: "",
            exitCode: 0,
            text,
            usage: specialist
              ? {
                  promptTokens: 10,
                  completionTokens: 4,
                  reasoningTokens: 2,
                  cacheReadTokens: 6,
                  cacheWriteTokens: 1,
                  totalTokens: 23,
                  cost: 0.01,
                  complete: false,
                  warning: "Usage incomplete: stream ended without a matching step_finish",
                  steps: 1,
                }
              : { promptTokens: 8, completionTokens: 3, totalTokens: 11, cost: 0.02, complete: true },
          };
        },
      },
    }).run(created.job.id);
    const run = store.listReviewerRuns(created.job.id)[0];
    expect(run?.total_tokens).toBe(23);
    expect(run?.reasoning_tokens).toBe(2);
    expect(run?.cache_read_tokens).toBe(6);
    expect(run?.cache_write_tokens).toBe(1);
    expect(run?.usage_complete).toBe(0);
    expect(run?.usage_warning).toMatch(/incomplete/i);
    const job = store.getJob(created.job.id);
    expect(job?.aggregator_total_tokens).toBe(11);
    expect(job?.aggregator_usage_complete).toBe(1);
    expect(job?.state).toBe("completed");
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

  it("rejects unauthorized jobs before minting a token, checking out, or calling OpenCode", async () => {
    const config = loadConfig({
      REVIEWER_ROLES: "correctness",
      ALLOWED_GITHUB_ACCOUNT_IDS: "1001",
      ALLOWED_GITHUB_REPOSITORY_IDS: "2002",
    });
    const store = new JobStore(openDb(":memory:"));
    const created = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 9,
      githubAccountId: 1,
      githubRepositoryId: 2,
      prNumber: 4,
      prTitle: "t",
      prBody: "",
      prHtmlUrl: "https://github.com/acme/widgets/pull/4",
      prAuthor: "octocat",
      baseSha: "base",
      headSha: "abc",
      baseRef: "main",
      headRef: "feat",
      reviewers: [{ role: "correctness", title: "Correctness" }],
    });
    let tokens = 0;
    let diffs = 0;
    let prepared = 0;
    let opencode = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await createPipeline({
      config,
      store,
      github: {
        getInstallationToken: async () => {
          tokens += 1;
          return "token";
        },
        getPullDiff: async () => {
          diffs += 1;
          return "diff";
        },
        listReviews: async () => [],
        createCommentReview: async () => ({ id: "x", url: "u" }),
      },
      checkout: {
        async prepare() {
          prepared += 1;
          throw new Error("should not checkout");
        },
        async cleanup() {},
      },
      opencode: {
        async run() {
          opencode += 1;
          throw new Error("should not run");
        },
      },
    }).run(created.job.id);
    expect(tokens).toBe(0);
    expect(diffs).toBe(0);
    expect(prepared).toBe(0);
    expect(opencode).toBe(0);
    expect(store.getJob(created.job.id)?.state).toBe("failed");
    expect(store.getJob(created.job.id)?.failure_reason).toBe("unauthorized: unauthorized account");
    expect(store.listReviewerRuns(created.job.id).every((run) => run.state === "failed")).toBe(true);
    const log = store.listLogs(created.job.id).map((row) => row.message).join("\n");
    expect(log).toContain("installation_id=9");
    expect(log).toContain("repository_id=2");
    expect(log).toContain("unauthorized account");
    expect(log).not.toContain("acme/widgets");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("acme/widgets");
    warn.mockRestore();
  });

  it("runs OpenCode when stored GitHub ids match the allowlists", async () => {
    const config = loadConfig({
      REVIEWER_ROLES: "correctness",
      OPENCODE_REVIEWER_MODEL: "test/model",
      POST_EMPTY_REVIEW: "true",
      ALLOWED_GITHUB_ACCOUNT_IDS: "1001",
      ALLOWED_GITHUB_REPOSITORY_IDS: "2002",
    });
    const store = new JobStore(openDb(":memory:"));
    const created = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 9,
      githubAccountId: 1001,
      githubRepositoryId: 2002,
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
    let opencode = 0;
    await createPipeline({
      config,
      store,
      github: {
        getInstallationToken: async () => "token",
        getPullDiff: async () => "diff",
        listReviews: async () => [],
        createCommentReview: async () => ({ id: "1", url: "u" }),
      },
      checkout: await fixtureCheckout(),
      opencode: {
        async run(input) {
          opencode += 1;
          const specialist = input.prompt.includes("Role id:");
          const text = specialist
            ? reviewerJson("correctness")
            : JSON.stringify({ verdict: "comment", summary: "ok", findings: [] });
          return { stdout: text, stderr: "", exitCode: 0, text, usage: {} };
        },
      },
    }).run(created.job.id);
    expect(opencode).toBeGreaterThan(0);
    expect(store.getJob(created.job.id)?.state).toBe("completed");
  });

  it("fails closed on legacy NULL GitHub ids once an allowlist is set", async () => {
    const config = loadConfig({
      REVIEWER_ROLES: "correctness",
      ALLOWED_GITHUB_ACCOUNT_IDS: "1001",
    });
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
      reviewers: [{ role: "correctness", title: "Correctness" }],
    });
    let tokens = 0;
    let opencode = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await createPipeline({
      config,
      store,
      github: {
        getInstallationToken: async () => {
          tokens += 1;
          return "token";
        },
        getPullDiff: async () => "diff",
        listReviews: async () => [],
        createCommentReview: async () => ({ id: "x", url: "u" }),
      },
      checkout: {
        async prepare() {
          throw new Error("should not checkout");
        },
        async cleanup() {},
      },
      opencode: {
        async run() {
          opencode += 1;
          throw new Error("should not run");
        },
      },
    }).run(created.job.id);
    expect(created.job.github_account_id).toBeNull();
    expect(tokens).toBe(0);
    expect(opencode).toBe(0);
    expect(store.getJob(created.job.id)?.failure_reason).toBe("unauthorized: missing account id");
    warn.mockRestore();
  });

  it("fails the job when the pull diff exceeds MAX_DIFF_BYTES without calling OpenCode", async () => {
    const config = loadConfig({
      REVIEWER_ROLES: "correctness",
      MAX_DIFF_BYTES: "8",
    });
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
      reviewers: [{ role: "correctness", title: "Correctness" }],
    });
    let prepared = 0;
    let opencode = 0;
    await createPipeline({
      config,
      store,
      github: {
        getInstallationToken: async () => "token",
        getPullDiff: async () => "this diff is definitely larger than eight bytes",
        listReviews: async () => [],
        createCommentReview: async () => ({ id: "x", url: "u" }),
      },
      checkout: {
        async prepare() {
          prepared += 1;
          throw new Error("should not checkout an oversized diff");
        },
        async cleanup() {},
      },
      opencode: {
        async run() {
          opencode += 1;
          throw new Error("should not run");
        },
      },
    }).run(created.job.id);
    expect(prepared).toBe(0);
    expect(opencode).toBe(0);
    expect(store.getJob(created.job.id)?.state).toBe("failed");
    expect(store.getJob(created.job.id)?.failure_reason).toContain("MAX_DIFF_BYTES");
  });

  it("allows a diff whose UTF-8 size equals MAX_DIFF_BYTES", async () => {
    const config = loadConfig({
      REVIEWER_ROLES: "correctness",
      POST_EMPTY_REVIEW: "true",
      MAX_DIFF_BYTES: "4",
    });
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
      reviewers: [{ role: "correctness", title: "Correctness" }],
    });
    let maxBytesSeen: number | undefined;
    let opencode = 0;
    await createPipeline({
      config,
      store,
      github: {
        getInstallationToken: async () => "token",
        getPullDiff: async (_installationId, _owner, _repo, _pullNumber, maxBytes) => {
          maxBytesSeen = maxBytes;
          return "abcd";
        },
        listReviews: async () => [],
        createCommentReview: async () => ({ id: "1", url: "u" }),
      },
      checkout: await fixtureCheckout(),
      opencode: {
        async run(input) {
          opencode += 1;
          const text = input.prompt.includes("Role id:")
            ? reviewerJson("correctness")
            : JSON.stringify({ verdict: "comment", summary: "ok", findings: [] });
          return { stdout: text, stderr: "", exitCode: 0, text, usage: {} };
        },
      },
    }).run(created.job.id);
    expect(maxBytesSeen).toBe(4);
    expect(opencode).toBeGreaterThan(0);
    expect(store.getJob(created.job.id)?.state).toBe("completed");
  });

  it("disables the diff cap when MAX_DIFF_BYTES is 0", async () => {
    const config = loadConfig({
      REVIEWER_ROLES: "correctness",
      POST_EMPTY_REVIEW: "true",
      MAX_DIFF_BYTES: "0",
    });
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
      reviewers: [{ role: "correctness", title: "Correctness" }],
    });
    let prepared = 0;
    await createPipeline({
      config,
      store,
      github: {
        getInstallationToken: async () => "token",
        getPullDiff: async () => "this diff is definitely larger than eight bytes",
        listReviews: async () => [],
        createCommentReview: async () => ({ id: "1", url: "u" }),
      },
      checkout: {
        async prepare(input) {
          prepared += 1;
          return (await fixtureCheckout()).prepare(input);
        },
        async cleanup() {},
      },
      opencode: {
        async run(input) {
          const text = input.prompt.includes("Role id:")
            ? reviewerJson("correctness")
            : JSON.stringify({ verdict: "comment", summary: "ok", findings: [] });
          return { stdout: text, stderr: "", exitCode: 0, text, usage: {} };
        },
      },
    }).run(created.job.id);
    expect(prepared).toBe(1);
    expect(store.getJob(created.job.id)?.state).toBe("completed");
  });

  it("fails the job when getPullDiff aborts an oversized download", async () => {
    const config = loadConfig({
      REVIEWER_ROLES: "correctness",
      MAX_DIFF_BYTES: "8",
    });
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
      reviewers: [{ role: "correctness", title: "Correctness" }],
    });
    let prepared = 0;
    await createPipeline({
      config,
      store,
      github: {
        getInstallationToken: async () => "token",
        getPullDiff: async () => {
          throw new DiffTooLargeError(64, 8);
        },
        listReviews: async () => [],
        createCommentReview: async () => ({ id: "x", url: "u" }),
      },
      checkout: {
        async prepare() {
          prepared += 1;
          throw new Error("should not checkout an oversized diff");
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
    expect(store.getJob(created.job.id)?.failure_reason).toContain("MAX_DIFF_BYTES");
  });

  it("keeps OpenCode stderr when reviewer output is empty", async () => {
    const config = loadConfig({ REVIEWER_ROLES: "correctness", OPENCODE_MAX_RETRIES: "0" });
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
      reviewers: [{ role: "correctness", title: "Correctness" }],
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
      checkout: await fixtureCheckout(),
      opencode: {
        async run() {
          return {
            stdout: "",
            stderr: "You must provide a message or a command\n",
            exitCode: 1,
            text: "",
            usage: {},
          };
        },
      },
    }).run(created.job.id);
    const run = store.listReviewerRuns(created.job.id)[0];
    expect(store.getJob(created.job.id)?.state).toBe("failed");
    expect(run?.validation_error).toContain("Empty reviewer output");
    expect(run?.stderr).toContain("You must provide a message or a command");
    expect(run?.exit_code).toBe(1);
    const logs = store.listLogs(created.job.id).map((row) => row.message).join("\n");
    expect(logs).toContain("You must provide a message or a command");
  });

  it("skips reviewers that already succeeded when a job is retried", async () => {
    const config = loadConfig({
      REVIEWER_ROLES: "correctness,security",
      OPENCODE_REVIEWER_MODEL: "test/model",
      POST_EMPTY_REVIEW: "true",
      OPENCODE_MAX_RETRIES: "0",
      GITHUB_APP_ID: "1",
      GITHUB_WEBHOOK_SECRET: "s",
      GITHUB_APP_PRIVATE_KEY: "k",
    });
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
    const runs = store.listReviewerRuns(created.job.id);
    store.patchReviewer(runs[0].id, {
      state: "done",
      normalized_json: reviewerJson("correctness"),
    });
    const roles: string[] = [];
    await createPipeline({
      config,
      store,
      github: {
        getInstallationToken: async () => "token",
        getPullDiff: async () => "diff",
        listReviews: async () => [],
        createCommentReview: async () => ({ id: "1", url: "u" }),
      },
      checkout: await fixtureCheckout(),
      opencode: {
        async run(input) {
          const roleMatch = input.prompt.match(/Role id: (\w+)/);
          if (roleMatch) roles.push(roleMatch[1]);
          const text = roleMatch
            ? reviewerJson(roleMatch[1])
            : JSON.stringify({ verdict: "comment", summary: "ok", findings: [] });
          return { stdout: text, stderr: "", exitCode: 0, text, usage: {} };
        },
      },
    }).run(created.job.id);
    expect(roles).toEqual(["security"]);
    expect(store.getReviewerRun(runs[0].id)?.state).toBe("done");
    expect(store.getJob(created.job.id)?.state).toBe("completed");
  });
});

describe("retryFailedReviewers", () => {
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
    headSha: "abc",
    reviewers: [
      { role: "correctness", title: "Correctness" },
      { role: "security", title: "Security" },
    ],
  };

  it("re-queues failed runs and the job, leaving successful runs alone", () => {
    const store = new JobStore(openDb(":memory:"));
    const created = store.enqueue(base);
    const runs = store.listReviewerRuns(created.job.id);
    store.patchReviewer(runs[0].id, { state: "failed", validation_error: "empty", stderr: "File not found" });
    store.patchReviewer(runs[1].id, { state: "done", normalized_json: "{}" });
    store.setJobState(created.job.id, "failed", { failure_reason: "all specialist reviewers failed" });
    const result = store.retryFailedReviewers(created.job.id, runs[0].id);
    expect(result).toEqual({ ok: true, reset: 1 });
    expect(store.getJob(created.job.id)?.state).toBe("queued");
    expect(store.getJob(created.job.id)?.failure_reason).toBeNull();
    expect(store.getReviewerRun(runs[0].id)?.state).toBe("queued");
    expect(store.getReviewerRun(runs[0].id)?.stderr).toBeNull();
    expect(store.getReviewerRun(runs[1].id)?.state).toBe("done");
  });

  it("rejects in-flight and stale jobs", () => {
    const store = new JobStore(openDb(":memory:"));
    const created = store.enqueue(base);
    const run = store.listReviewerRuns(created.job.id)[0];
    store.patchReviewer(run.id, { state: "failed" });
    store.setJobState(created.job.id, "reviewing");
    expect(store.retryFailedReviewers(created.job.id).ok).toBe(false);
    store.setJobState(created.job.id, "failed", { failure_reason: "x" });
    store.setJobState(created.job.id, "stale");
    expect(store.retryFailedReviewers(created.job.id).ok).toBe(false);
  });
});
