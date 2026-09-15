import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { openDb } from "../db.js";
import type { GithubPort } from "../github/client.js";
import type { CheckoutPort } from "../checkout.js";
import type { OpenCodePort } from "../opencode/parse.js";
import { findingMarker, fingerprintFinding } from "../findings/identity.js";
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

function githubPort(overrides: Partial<GithubPort> = {}): GithubPort {
  return {
    getInstallationToken: async () => "token",
    getPullDiff: async () => "diff --git a/example.ts b/example.ts\n",
    listReviews: async () => [],
    createCommentReview: async () => ({ id: "99", url: "https://example.test/reviews/99" }),
    listReviewThreads: async () => [],
    resolveReviewThread: async () => {},
    unresolveReviewThread: async () => {},
    getCollaboratorPermission: async () => "none",
    ...overrides,
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
    const posted: { event?: string; commitId: string; body: string; comments?: { body: string }[] }[] = [];
    const github = githubPort({
      createCommentReview: async (input) => {
        posted.push({ commitId: input.commitId, body: input.body, comments: input.comments });
        expect(input.body).toContain("maomao-review");
        expect(input.comments.some((comment) => comment.body.includes("maomao-finding"))).toBe(true);
        return { id: "99", url: "https://example.test/reviews/99" };
      },
    });
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
      github: githubPort({
        createCommentReview: async () => ({ id: "1", url: "u" }),
      }),
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
    const github = githubPort({
      createCommentReview: async () => {
        reviews += 1;
        return { id: "1", url: "u" };
      },
    });
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
    const github = githubPort({
      listReviews: async () => [{ id: 5, body: "<!-- maomao-review sha=abc -->", htmlUrl: "https://r" }],
      createCommentReview: async () => {
        creates += 1;
        return { id: "x", url: "u" };
      },
    });
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
      github: githubPort({
        createCommentReview: async () => ({ id: "x", url: "u" }),
      }),
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
      github: githubPort({
        getInstallationToken: async () => {
          throw new Error("could not mint installation token");
        },
        createCommentReview: async () => ({ id: "x", url: "u" }),
      }),
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
      github: githubPort({
        createCommentReview: async () => ({ id: "x", url: "u" }),
      }),
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
      github: githubPort({
        createCommentReview: async () => ({ id: "1", url: "u" }),
      }),
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

function enqueueJob(store: JobStore, config: ReturnType<typeof loadConfig>, headSha = "cafebabe") {
  return store.enqueue({
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
    headSha,
    baseRef: "main",
    headRef: "feat",
    reviewers: config.reviewers.map((role) => ({ role: role.id, title: role.title })),
  });
}

function threadFor(fingerprint: string, summary = "bug") {
  return {
    id: `thread-${fingerprint}`,
    isResolved: false,
    path: "example.ts",
    line: 1,
    comments: [
      {
        id: "n1",
        databaseId: 11,
        body: `${findingMarker(fingerprint, "oldsha")}\n**high**: ${summary}`,
        path: "example.ts",
        line: 1,
        authorLogin: "maomao[bot]",
      },
    ],
  };
}

describe("finding reconciliation", () => {
  const finding = {
    severity: "high" as const,
    confidence: 0.9,
    category: "correctness",
    file: "example.ts",
    line: 1,
    summary: "bug",
  };

  it("resolves a fixed finding only after verification and a successful publish", async () => {
    const fingerprint = fingerprintFinding(finding);
    const config = loadConfig({
      REVIEWER_ROLES: "correctness",
      OPENCODE_REVIEWER_MODEL: "test/model",
      POST_EMPTY_REVIEW: "true",
    });
    const store = new JobStore(openDb(":memory:"));
    const created = enqueueJob(store, config);
    const resolved: string[] = [];
    await createPipeline({
      config,
      store,
      github: githubPort({
        listReviewThreads: async () => [threadFor(fingerprint)],
        resolveReviewThread: async (_id, threadId) => {
          resolved.push(threadId);
        },
        createCommentReview: async () => ({ id: "9", url: "u" }),
      }),
      checkout: await fixtureCheckout(),
      opencode: {
        async run(input) {
          if (input.prompt.includes("finding verifier")) {
            return {
              stdout: "",
              stderr: "",
              exitCode: 0,
              text: JSON.stringify({
                classifications: [
                  { fingerprint, status: "resolved", confidence: 0.95, reason: "the bug is gone" },
                ],
              }),
              usage: {},
            };
          }
          if (input.prompt.includes("Role id:")) {
            expect(store.getJob(created.job.id)?.risk_profile).toBe("diagnosis");
            return {
              stdout: "",
              stderr: "",
              exitCode: 0,
              text: reviewerJson("correctness"),
              usage: {},
            };
          }
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            text: JSON.stringify({ verdict: "clean", summary: "fixed", findings: [] }),
            usage: {},
          };
        },
      },
    }).run(created.job.id);
    expect(store.getJob(created.job.id)?.state).toBe("completed");
    expect(resolved).toEqual([`thread-${fingerprint}`]);
    expect(store.getFinding("acme/widgets", 4, fingerprint)?.status).toBe("resolved");
    const logs = store.listLogs(created.job.id).map((row) => row.message);
    const reconcileAt = logs.findIndex((line) => line.includes("Reconciling"));
    const riskAt = logs.findIndex((line) => line.includes("Risk route:"));
    const reviewAt = logs.findIndex((line) => line.includes("Reviewer correctness"));
    expect(reconcileAt).toBeGreaterThanOrEqual(0);
    expect(riskAt).toBeGreaterThan(reconcileAt);
    expect(reviewAt).toBeGreaterThan(riskAt);
    expect(logs.join("\n")).toContain("resolved/dismissed excluded");
  });

  it("keeps still-valid and uncertain threads open", async () => {
    const fingerprint = fingerprintFinding(finding);
    const config = loadConfig({ REVIEWER_ROLES: "correctness", OPENCODE_REVIEWER_MODEL: "test/model" });
    const store = new JobStore(openDb(":memory:"));
    const created = enqueueJob(store, config, "newsha");
    const resolved: string[] = [];
    await createPipeline({
      config,
      store,
      github: githubPort({
        listReviewThreads: async () => [threadFor(fingerprint)],
        resolveReviewThread: async (_id, threadId) => {
          resolved.push(threadId);
        },
      }),
      checkout: await fixtureCheckout(),
      opencode: {
        async run(input) {
          if (input.prompt.includes("finding verifier")) {
            return {
              stdout: "",
              stderr: "",
              exitCode: 0,
              text: JSON.stringify({
                classifications: [
                  { fingerprint, status: "still_valid", confidence: 0.9, reason: "still present" },
                ],
              }),
              usage: {},
            };
          }
          if (input.prompt.includes("Role id:")) {
            return { stdout: "", stderr: "", exitCode: 0, text: reviewerJson("correctness"), usage: {} };
          }
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            text: JSON.stringify({
              verdict: "comment",
              summary: "still broken",
              findings: [finding],
            }),
            usage: {},
          };
        },
      },
    }).run(created.job.id);
    expect(store.getJob(created.job.id)?.state).toBe("completed");
    expect(resolved).toEqual([]);
    expect(store.getFinding("acme/widgets", 4, fingerprint)?.status).toBe("still_valid");
  });

  it("preserves a moved finding at the new location without duplicate open threads", async () => {
    const fingerprint = fingerprintFinding(finding);
    const config = loadConfig({ REVIEWER_ROLES: "correctness", OPENCODE_REVIEWER_MODEL: "test/model" });
    const store = new JobStore(openDb(":memory:"));
    const created = enqueueJob(store, config, "movedsha");
    const resolved: string[] = [];
    const posted: { path: string; line: number }[] = [];
    await createPipeline({
      config,
      store,
      github: githubPort({
        listReviewThreads: async () => [threadFor(fingerprint)],
        resolveReviewThread: async (_id, threadId) => {
          resolved.push(threadId);
        },
        createCommentReview: async (input) => {
          posted.push(...input.comments.map((comment) => ({ path: comment.path, line: comment.line })));
          return { id: "2", url: "u" };
        },
      }),
      checkout: await fixtureCheckout(),
      opencode: {
        async run(input) {
          if (input.prompt.includes("finding verifier")) {
            return {
              stdout: "",
              stderr: "",
              exitCode: 0,
              text: JSON.stringify({
                classifications: [
                  {
                    fingerprint,
                    status: "moved",
                    confidence: 0.92,
                    reason: "relocated",
                    file: "example.ts",
                    line: 8,
                  },
                ],
              }),
              usage: {},
            };
          }
          if (input.prompt.includes("Role id:")) {
            return { stdout: "", stderr: "", exitCode: 0, text: reviewerJson("correctness"), usage: {} };
          }
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            text: JSON.stringify({ verdict: "comment", summary: "moved", findings: [] }),
            usage: {},
          };
        },
      },
    }).run(created.job.id);
    expect(posted).toEqual([{ path: "example.ts", line: 8 }]);
    expect(resolved).toEqual([`thread-${fingerprint}`]);
  });

  it("does not re-verify a stored resolved finding when no thread is open", async () => {
    const fingerprint = fingerprintFinding(finding);
    const config = loadConfig({
      REVIEWER_ROLES: "correctness",
      OPENCODE_REVIEWER_MODEL: "test/model",
      POST_EMPTY_REVIEW: "true",
    });
    const store = new JobStore(openDb(":memory:"));
    const created = enqueueJob(store, config, "nextsha");
    store.upsertFinding({
      repoFullName: created.job.repo_full_name,
      prNumber: created.job.pr_number,
      fingerprint,
      status: "resolved",
      reviewedSha: "oldsha",
      summary: finding.summary,
      githubThreadId: `thread-${fingerprint}`,
    });
    let verified = false;
    await createPipeline({
      config,
      store,
      github: githubPort({
        listReviewThreads: async () => [],
        resolveReviewThread: async () => {
          throw new Error("should not resolve a settled finding");
        },
      }),
      checkout: await fixtureCheckout(),
      opencode: {
        async run(input) {
          if (input.prompt.includes("finding verifier")) {
            verified = true;
            throw new Error("verifier should not run for settled resolved findings");
          }
          if (input.prompt.includes("Role id:")) {
            return { stdout: "", stderr: "", exitCode: 0, text: reviewerJson("correctness"), usage: {} };
          }
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            text: JSON.stringify({ verdict: "clean", summary: "still gone", findings: [] }),
            usage: {},
          };
        },
      },
    }).run(created.job.id);
    expect(verified).toBe(false);
    expect(store.getJob(created.job.id)?.state).toBe("completed");
    expect(store.getFinding("acme/widgets", 4, fingerprint)?.status).toBe("resolved");
  });

  it("does not resolve a moved thread when the replacement comment is capped out", async () => {
    const fingerprint = fingerprintFinding(finding);
    const config = loadConfig({
      REVIEWER_ROLES: "correctness",
      OPENCODE_REVIEWER_MODEL: "test/model",
      MAX_INLINE_COMMENTS: "0",
    });
    const store = new JobStore(openDb(":memory:"));
    const created = enqueueJob(store, config, "capsha");
    const resolved: string[] = [];
    const posted: { path: string; line: number }[] = [];
    await createPipeline({
      config,
      store,
      github: githubPort({
        listReviewThreads: async () => [threadFor(fingerprint)],
        resolveReviewThread: async (_id, threadId) => {
          resolved.push(threadId);
        },
        createCommentReview: async (input) => {
          posted.push(...input.comments.map((comment) => ({ path: comment.path, line: comment.line })));
          return { id: "2", url: "u" };
        },
      }),
      checkout: await fixtureCheckout(),
      opencode: {
        async run(input) {
          if (input.prompt.includes("finding verifier")) {
            return {
              stdout: "",
              stderr: "",
              exitCode: 0,
              text: JSON.stringify({
                classifications: [
                  {
                    fingerprint,
                    status: "moved",
                    confidence: 0.92,
                    reason: "relocated",
                    file: "example.ts",
                    line: 8,
                  },
                ],
              }),
              usage: {},
            };
          }
          if (input.prompt.includes("Role id:")) {
            return { stdout: "", stderr: "", exitCode: 0, text: reviewerJson("correctness"), usage: {} };
          }
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            text: JSON.stringify({ verdict: "comment", summary: "moved", findings: [] }),
            usage: {},
          };
        },
      },
    }).run(created.job.id);
    expect(posted).toEqual([]);
    expect(resolved).toEqual([]);
    expect(store.getJob(created.job.id)?.state).toBe("completed");
  });

  it("does not close threads when the job fails or becomes stale", async () => {
    const fingerprint = fingerprintFinding(finding);
    const config = loadConfig({
      REVIEWER_ROLES: "correctness",
      OPENCODE_REVIEWER_MODEL: "test/model",
      OPENCODE_MAX_RETRIES: "0",
    });
    const store = new JobStore(openDb(":memory:"));
    const failed = enqueueJob(store, config, "failsha");
    const resolved: string[] = [];
    const github = githubPort({
      listReviewThreads: async () => [threadFor(fingerprint)],
      resolveReviewThread: async (_id, threadId) => {
        resolved.push(threadId);
      },
    });
    await createPipeline({
      config,
      store,
      github,
      checkout: await fixtureCheckout(),
      opencode: {
        async run(input) {
          if (input.prompt.includes("finding verifier")) {
            return {
              stdout: "",
              stderr: "",
              exitCode: 0,
              text: JSON.stringify({
                classifications: [{ fingerprint, status: "resolved", confidence: 0.99, reason: "gone" }],
              }),
              usage: {},
            };
          }
          throw new Error("reviewer exploded");
        },
      },
    }).run(failed.job.id);
    expect(store.getJob(failed.job.id)?.state).toBe("failed");
    expect(resolved).toEqual([]);

    const staleJob = enqueueJob(store, config, "stalesha");
    await createPipeline({
      config,
      store,
      github,
      checkout: await fixtureCheckout(),
      opencode: {
        async run(input) {
          if (input.prompt.includes("finding verifier")) {
            store.enqueue({
              repoFullName: "acme/widgets",
              repoOwner: "acme",
              repoName: "widgets",
              installationId: 9,
              prNumber: 4,
              prTitle: "newer",
              prBody: "",
              prHtmlUrl: "",
              prAuthor: "dev",
              baseSha: "base",
              headSha: "newer",
              baseRef: "main",
              headRef: "feat",
              reviewers: [{ role: "correctness", title: "Correctness" }],
            });
            return {
              stdout: "",
              stderr: "",
              exitCode: 0,
              text: JSON.stringify({
                classifications: [{ fingerprint, status: "resolved", confidence: 0.99, reason: "gone" }],
              }),
              usage: {},
            };
          }
          return { stdout: "", stderr: "", exitCode: 0, text: reviewerJson("correctness"), usage: {} };
        },
      },
    }).run(staleJob.job.id);
    expect(store.getJob(staleJob.job.id)?.state).toBe("stale");
    expect(resolved).toEqual([]);
  });

  it("does not re-report a dismissed fingerprint and excludes it from risk routing", async () => {
    const fingerprint = fingerprintFinding(finding);
    const config = loadConfig({ REVIEWER_ROLES: "correctness", OPENCODE_REVIEWER_MODEL: "test/model" });
    const store = new JobStore(openDb(":memory:"));
    store.dismissFinding({
      repoFullName: "acme/widgets",
      prNumber: 4,
      fingerprint,
      actor: "octocat",
      command: "bury",
      reviewedSha: "oldsha",
      summary: "bug",
    });
    const created = enqueueJob(store, config, "nextsha");
    const postedBodies: string[] = [];
    let verifierCalls = 0;
    await createPipeline({
      config,
      store,
      github: githubPort({
        listReviewThreads: async () => [threadFor(fingerprint)],
        createCommentReview: async (input) => {
          postedBodies.push(...input.comments.map((comment) => comment.body));
          return { id: "3", url: "u" };
        },
      }),
      checkout: await fixtureCheckout(),
      opencode: {
        async run(input) {
          if (input.prompt.includes("finding verifier")) {
            verifierCalls += 1;
            throw new Error("should not verify dismissed findings");
          }
          if (input.prompt.includes("Role id:")) {
            return { stdout: "", stderr: "", exitCode: 0, text: reviewerJson("correctness"), usage: {} };
          }
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            text: JSON.stringify({ verdict: "comment", summary: "again", findings: [finding] }),
            usage: {},
          };
        },
      },
    }).run(created.job.id);
    expect(verifierCalls).toBe(0);
    expect(postedBodies.some((body) => body.includes(fingerprint))).toBe(false);
    expect(store.getJob(created.job.id)?.risk_reason).toContain("poison-alert");
    const snapshot = JSON.parse(store.getJob(created.job.id)?.reconciliation_json ?? "{}") as {
      items: { fingerprint: string; status: string }[];
    };
    expect(snapshot.items[0]?.status).toBe("dismissed");
    expect(store.getFinding("acme/widgets", 4, fingerprint)?.status).toBe("dismissed");
  });

  it("treats verifier failure as uncertain rather than resolved", async () => {
    const fingerprint = fingerprintFinding(finding);
    const config = loadConfig({ REVIEWER_ROLES: "correctness", OPENCODE_REVIEWER_MODEL: "test/model" });
    const store = new JobStore(openDb(":memory:"));
    const created = enqueueJob(store, config, "uncsha");
    const resolved: string[] = [];
    await createPipeline({
      config,
      store,
      github: githubPort({
        listReviewThreads: async () => [threadFor(fingerprint)],
        resolveReviewThread: async (_id, threadId) => {
          resolved.push(threadId);
        },
      }),
      checkout: await fixtureCheckout(),
      opencode: {
        async run(input) {
          if (input.prompt.includes("finding verifier")) throw new Error("verifier down");
          if (input.prompt.includes("Role id:")) {
            return { stdout: "", stderr: "", exitCode: 0, text: reviewerJson("correctness"), usage: {} };
          }
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            text: JSON.stringify({ verdict: "clean", summary: "ok", findings: [] }),
            usage: {},
          };
        },
      },
    }).run(created.job.id);
    expect(resolved).toEqual([]);
    expect(store.getFinding("acme/widgets", 4, fingerprint)?.status).toBe("uncertain");
  });
});


