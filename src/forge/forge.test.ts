import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { JobStore } from "../jobs/store.js";
import type { SqliteDb } from "../db.js";
import { ForgeRegistry } from "./registry.js";
import { GitHubProvider } from "./github-provider.js";
import type { ForgeRepoTarget } from "./types.js";
import type { GithubPort } from "../github/client.js";

const TARGET: ForgeRepoTarget = {
  provider: "github",
  instance: "github.com",
  repoOwner: "acme",
  repoName: "widgets",
  repoFullName: "acme/widgets",
  changeNumber: 7,
};

function fakeGithub(overrides: Partial<GithubPort> = {}): GithubPort {
  return {
    getInstallationToken: async () => "tok-abc123",
    getPullDiff: async () => "diff",
    listReviews: async () => [],
    createCommentReview: async (input) => ({
      id: String(input.pullNumber),
      url: "https://example.test/review",
      postedComments: input.comments,
    }),
    listReviewThreads: async () => [],
    resolveReviewThread: async () => {},
    unresolveReviewThread: async () => {},
    getCollaboratorPermission: async () => "write",
    ...overrides,
  };
}

function scopedTarget(overrides: Partial<ForgeRepoTarget> = {}): ForgeRepoTarget {
  return { ...TARGET, ...overrides };
}

describe("GitHubProvider", () => {
  it("builds GitHub clone material with Basic auth and the PR head refspec", async () => {
    const provider = new GitHubProvider(fakeGithub(), 42, "maomao");
    const spec = await provider.cloneSpec(scopedTarget());
    expect(spec.cloneUrl).toBe("https://github.com/acme/widgets.git");
    expect(spec.headRefspec).toBe("+refs/pull/7/head:refs/maomao/pr");
    expect(spec.gitAuthArgs.join(" ")).toContain("AUTHORIZATION: basic");
    expect(spec.secrets.some((secret) => secret.includes("tok-abc123"))).toBe(true);
  });

  it("omits auth for installation id 0 (unauthenticated public scans)", async () => {
    const getToken = async () => {
      throw new Error("should not mint a token for installation 0");
    };
    const provider = new GitHubProvider(fakeGithub(), 0, "maomao", getToken);
    const spec = await provider.cloneSpec(scopedTarget());
    expect(spec.gitAuthArgs).toEqual([]);
    expect(spec.secrets).toEqual([]);
  });

  it("redacts installation ids and keeps target numbers project-local", async () => {
    const provider = new GitHubProvider(fakeGithub(), 42, "maomao");
    expect(provider.provider).toBe("github");
    expect(provider.instance).toBe("github.com");
  });

  it("publishes with the verdict and returns what the forge accepted", async () => {
    const posted: Array<{ event?: string; comments: unknown[] }> = [];
    const client = fakeGithub({
      createCommentReview: async (input) => {
        posted.push({ event: input.event, comments: input.comments });
        return { id: "9", url: "https://example.test/r", postedComments: input.comments.slice(0, 1) };
      },
    });
    const provider = new GitHubProvider(client, 42, "maomao");
    const result = await provider.publishReview({
      target: scopedTarget(),
      commitId: "sha1",
      body: "summary",
      comments: [{ path: "a.ts", body: "finding", line: 3, side: "RIGHT" }],
      verdict: "COMMENT",
    });
    expect(result.id).toBe("9");
    expect(result.postedComments).toHaveLength(1);
    expect(posted[0]?.event).toBe("COMMENT");
  });

  it("maps review summaries to neutral string ids", async () => {
    const client = fakeGithub({
      listReviews: async () => [{ id: 12, body: "<!-- maomao-review sha -->", htmlUrl: "https://x" }],
    });
    const provider = new GitHubProvider(client, 42, "maomao");
    const summaries = await provider.listSummaries(scopedTarget());
    expect(summaries).toEqual([
      { id: "12", body: "<!-- maomao-review sha -->", htmlUrl: "https://x", commitId: undefined, userLogin: undefined },
    ]);
  });

  it("recognizes the app bot identity for loop prevention", () => {
    const provider = new GitHubProvider(fakeGithub(), 42, "maomao");
    expect(provider.isBotLogin("maomao[bot]")).toBe(true);
    expect(provider.isBotLogin("maomao")).toBe(true);
    expect(provider.isBotLogin("octocat")).toBe(false);
    expect(provider.isBotLogin(undefined)).toBe(false);
  });

  it("merges conversation and inline comments with per-source caps", async () => {
    const issue = Array.from({ length: 50 }, (_, index) => ({
      id: index + 1,
      body: `issue ${index}`,
      userLogin: "octocat",
    }));
    const review = Array.from({ length: 50 }, (_, index) => ({
      id: 1000 + index,
      body: `review ${index}`,
      userLogin: "octocat",
    }));
    const client = fakeGithub({
      listIssueComments: async () => issue,
      listPullReviewComments: async () => review,
    });
    const provider = new GitHubProvider(client, 42, "maomao");
    const comments = await provider.listConversationComments(scopedTarget());
    // Historical behavior preserved: last 40 of each source, conversation first.
    expect(comments).toHaveLength(80);
    expect(comments[0]?.source).toBe("conversation");
    expect(comments[0]?.id).toBe("11");
    expect(comments.at(-1)?.source).toBe("inline");
    expect(comments.at(-1)?.inReplyToId).toBeUndefined();
  });

  it("requires a client with pull metadata for getChange", async () => {
    const provider = new GitHubProvider(fakeGithub(), 42, "maomao");
    await expect(provider.getChange(scopedTarget())).rejects.toThrow(/cannot resolve pull request metadata/);
    const withPull = fakeGithub({
      getPull: async () => ({
        installationId: 42,
        accountId: 5,
        repositoryId: 6,
        repoOwner: "acme",
        repoName: "widgets",
        repoFullName: "acme/widgets",
        prNumber: 7,
        prTitle: "t",
        prBody: "",
        prHtmlUrl: "https://github.com/acme/widgets/pull/7",
        prAuthor: "octocat",
        baseSha: "b",
        headSha: "h",
        baseRef: "main",
        headRef: "feature",
        draft: false,
      }),
    } as Partial<GithubPort>);
    const change = await new GitHubProvider(withPull, 42, "maomao").getChange(scopedTarget());
    expect(change).toMatchObject({ changeNumber: 7, headSha: "h", repositoryId: 6, accountId: 5 });
  });
});

describe("ForgeRegistry", () => {
  it("binds the GitHub connection for github-scoped jobs", async () => {
    const registry = new ForgeRegistry(fakeGithub(), "maomao");
    const forge = registry.forJob({
      provider: "github",
      provider_instance: "github.com",
      installation_id: 9,
    });
    expect(forge).toBeInstanceOf(GitHubProvider);
    expect((forge as GitHubProvider).installationId).toBe(9);
  });

  it("defaults null scope to the env-configured GitHub connection", () => {
    const registry = new ForgeRegistry(fakeGithub(), "maomao");
    const forge = registry.forJob({ provider: null, provider_instance: null, installation_id: 1 });
    expect(forge).toBeInstanceOf(GitHubProvider);
  });

  it("fails closed for connections no registry can resolve yet (pre-GitLab slices)", () => {
    const registry = new ForgeRegistry(fakeGithub(), "maomao");
    expect(() =>
      registry.forJob({
        provider: "gitlab",
        provider_instance: "gitlab.corp.internal",
        installation_id: 0,
      }),
    ).toThrow(/no forge connection configured for gitlab:gitlab.corp.internal/);
  });
});

/** Shapes one pre-multi-forge database: the shipped v1 constraint set plus rows. */
function legacySchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_full_name TEXT NOT NULL,
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      installation_id INTEGER NOT NULL,
      pr_number INTEGER NOT NULL,
      pr_title TEXT NOT NULL DEFAULT '',
      pr_body TEXT NOT NULL DEFAULT '',
      pr_html_url TEXT NOT NULL DEFAULT '',
      pr_author TEXT NOT NULL DEFAULT '',
      base_sha TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      base_ref TEXT NOT NULL DEFAULT '',
      head_ref TEXT NOT NULL DEFAULT '',
      webhook_delivery_id TEXT,
      webhook_event TEXT,
      state TEXT NOT NULL DEFAULT 'queued',
      failure_reason TEXT,
      workspace_path TEXT,
      github_review_id TEXT,
      github_review_url TEXT,
      aggregator_raw TEXT,
      aggregator_normalized TEXT,
      aggregator_model TEXT,
      aggregator_provider TEXT,
      aggregator_state TEXT NOT NULL DEFAULT 'queued',
      aggregator_started_at TEXT,
      aggregator_finished_at TEXT,
      aggregator_duration_ms INTEGER,
      aggregator_prompt_tokens INTEGER,
      aggregator_completion_tokens INTEGER,
      aggregator_cost REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      UNIQUE (repo_full_name, pr_number, head_sha)
    );
    CREATE TABLE findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_full_name TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      reviewed_sha TEXT NOT NULL,
      current_sha TEXT,
      github_thread_id TEXT,
      github_comment_id TEXT,
      original_path TEXT,
      original_line INTEGER,
      current_path TEXT,
      current_line INTEGER,
      category TEXT,
      summary TEXT NOT NULL DEFAULT '',
      body TEXT,
      severity TEXT,
      confidence REAL,
      dismissed_by TEXT,
      dismissed_at TEXT,
      dismiss_command TEXT,
      reopened_by TEXT,
      reopened_at TEXT,
      reopen_command TEXT,
      reconciliation_confidence REAL,
      reconciliation_reason TEXT,
      last_job_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (repo_full_name, pr_number, fingerprint)
    );
    CREATE INDEX idx_findings_thread ON findings(github_thread_id);
    CREATE INDEX idx_findings_comment ON findings(github_comment_id);
    CREATE TABLE webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE merged_pulls (
      repo_full_name TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      merged_at TEXT NOT NULL,
      delivery_id TEXT,
      PRIMARY KEY (repo_full_name, pr_number)
    );
  `);
  db.prepare(
    `INSERT INTO jobs (repo_full_name, repo_owner, repo_name, installation_id, pr_number, base_sha, head_sha, state, created_at, updated_at)
     VALUES ('acme/widgets', 'acme', 'widgets', 1, 3, 'b', 'c', 'completed', '2026-01-01', '2026-01-01')`,
  ).run();
  db.prepare(
    `INSERT INTO findings (repo_full_name, pr_number, fingerprint, status, reviewed_sha, summary, created_at, updated_at)
     VALUES ('acme/widgets', 3, 'fp123', 'open', 'sha', 's', '2026-01-01', '2026-01-01')`,
  ).run();
  db.prepare(
    `INSERT INTO webhook_deliveries (delivery_id, event, result, created_at)
     VALUES ('delivery-1', 'pull_request', 'pr_merged_cancel', '2026-01-01')`,
  ).run();
  db.prepare(
    `INSERT INTO merged_pulls (repo_full_name, pr_number, merged_at, delivery_id)
     VALUES ('acme/widgets', 3, '2026-01-01', 'delivery-1')`,
  ).run();
}

describe("provider-scoped storage migration", () => {
  it("rebuilt legacy tables carry provider identity, scoped keys, and all data", () => {
    const dir = mkdtempSync(join(tmpdir(), "maomao-forge-mig-"));
    const path = join(dir, "legacy.sqlite");
    try {
      const legacy = new Database(path);
      legacy.pragma("journal_mode = WAL");
      legacySchema(legacy);
      legacy.close();

      const db = openDb(path);
      const store = new JobStore(db);
      // Preserved rows are attributed to the GitHub connection they came from.
      const job = store.findLatestJobForPull("acme/widgets", 3);
      expect(job).toMatchObject({ provider: "github", provider_instance: "github.com", state: "completed" });
      const finding = store.listFindings("acme/widgets", 3)[0];
      expect(finding).toMatchObject({ fingerprint: "fp123", provider: "github", provider_instance: "github.com" });
      expect(store.hasWebhookDelivery("delivery-1")).toBe(true);
      expect(store.hasMergedPull("acme/widgets", 3)).toBe(true);

      // Foreign keys survived the rebuild: the legacy job can still take
      // child rows (job_logs references jobs(id)) and integrity is clean.
      db.prepare(
        `INSERT INTO job_logs (job_id, level, message, created_at) VALUES (1, 'info', 'post-migration', '2026-01-02')`,
      ).run();
      expect(db.pragma("foreign_key_check")).toEqual([]);

      // The scoped keys replaced the repo-name-only ones: the same repository,
      // PR, and SHA can now exist on another instance without collision.
      const otherInstance = store.enqueue({
        repoFullName: "acme/widgets",
        repoOwner: "acme",
        repoName: "widgets",
        installationId: 1,
        provider: "gitlab",
        providerInstance: "gitlab.corp.internal",
        prNumber: 3,
        prTitle: "same name elsewhere",
        prBody: "",
        prHtmlUrl: "",
        prAuthor: "",
        baseSha: "b2",
        headSha: "c2",
        baseRef: "main",
        headRef: "feature",
        reviewers: [],
      });
      expect(otherInstance.created).toBe(true);

      // GitHub dedup still applies within its own scope.
      const duplicateGithub = store.enqueue({
        repoFullName: "acme/widgets",
        repoOwner: "acme",
        repoName: "widgets",
        installationId: 1,
        prNumber: 3,
        prTitle: "dup",
        prBody: "",
        prHtmlUrl: "",
        prAuthor: "",
        baseSha: "b",
        headSha: "c",
        baseRef: "main",
        headRef: "feature",
        reviewers: [],
      });
      expect(duplicateGithub.created).toBe(false);
      expect(duplicateGithub.skippedReason).toContain("already");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cross-connection storage isolation", () => {
  function newStore(): JobStore {
    return new JobStore(openDb(":memory:"));
  }

  function jobInput(overrides: Record<string, unknown> = {}) {
    return {
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 1,
      prNumber: 5,
      prTitle: "t",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "a",
      baseSha: "b",
      headSha: "h",
      baseRef: "main",
      headRef: "feature",
      reviewers: [],
      ...overrides,
    };
  }

  it("keeps jobs, findings, merge markers, and deliveries separate per instance", () => {
    const store = newStore();
    const githubJob = store.enqueue(jobInput({ headSha: "sha-github" })).job;
    const gitlabJob = store.enqueue(
      jobInput({ headSha: "sha-gitlab", provider: "gitlab", providerInstance: "gitlab.com" }),
    ).job;
    expect(store.enqueue(jobInput({ headSha: "sha-github" })).created).toBe(false);
    expect(
      store.enqueue(jobInput({ headSha: "sha-gitlab", provider: "gitlab", providerInstance: "gitlab.com" }))
        .created,
    ).toBe(false);

    expect(githubJob.provider).toBe("github");
    expect(gitlabJob.provider_instance).toBe("gitlab.com");

    // Findings with the same fingerprint never cross instances.
    store.upsertFinding({
      repoFullName: "acme/widgets",
      prNumber: 5,
      fingerprint: "fpfedcba98765432",
      status: "open",
      reviewedSha: "sha-github",
      summary: "github copy",
    });
    store.upsertFinding({
      repoFullName: "acme/widgets",
      prNumber: 5,
      fingerprint: "fpfedcba98765432",
      status: "dismissed",
      reviewedSha: "sha-gitlab",
      summary: "gitlab copy",
      scope: { provider: "gitlab", instance: "gitlab.com" },
    });
    expect(store.listFindings("acme/widgets", 5)[0]?.status).toBe("open");
    expect(store.listFindings("acme/widgets", 5, { provider: "gitlab", instance: "gitlab.com" })[0]?.status).toBe(
      "dismissed",
    );
    expect(store.getFinding("acme/widgets", 5, "fpfedcba98765432")?.summary).toBe("github copy");

    // Merged markers and webhook deliveries are scoped the same way.
    store.markPullMerged("acme/widgets", 5, "d-github");
    expect(store.hasMergedPull("acme/widgets", 5)).toBe(true);
    expect(store.hasMergedPull("acme/widgets", 5, { provider: "gitlab", instance: "gitlab.com" })).toBe(false);

    expect(store.claimWebhookDelivery("delivery-9", "merge_request", "open")).toBe(true);
    expect(store.hasWebhookDelivery("delivery-9", { provider: "gitlab", instance: "gitlab.com" })).toBe(false);
    expect(
      store.claimWebhookDelivery("delivery-9", "merge_request", "open", {
        provider: "gitlab",
        instance: "gitlab.com",
      }),
    ).toBe(true);

    // Cancellation on one instance leaves the other running.
    store.cancelJobs({ repoFullName: "acme/widgets", prNumber: 5 }, "manual_cancel", null);
    expect(store.getJob(gitlabJob.id)?.state).toBe("queued");
  });

  it("cancels jobs only within the requested scope when given explicitly", () => {
    const store = newStore();
    const gitlabJob = store.enqueue(
      jobInput({ headSha: "sha", provider: "gitlab", providerInstance: "gitlab.corp.internal" }),
    ).job;
    const cancelled = store.cancelJobs(
      {
        repoFullName: "acme/widgets",
        prNumber: 5,
        scope: { provider: "gitlab", instance: "gitlab.corp.internal" },
      },
      "manual_cancel",
      null,
    );
    expect(cancelled).toEqual([gitlabJob.id]);
    expect(store.getJob(gitlabJob.id)?.state).toBe("cancelled");
  });
});
