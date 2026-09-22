import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { JobStore } from "./jobs/store.js";

describe("usage schema migration", () => {
  it("keeps existing job and reviewer rows readable after adding usage columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "maomao-db-"));
    const path = join(dir, "legacy.sqlite");
    try {
      const legacy = new Database(path);
      legacy.exec(`
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
        CREATE TABLE reviewer_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          model TEXT,
          provider TEXT,
          state TEXT NOT NULL DEFAULT 'queued',
          attempt INTEGER NOT NULL DEFAULT 0,
          raw_output TEXT,
          normalized_json TEXT,
          validation_error TEXT,
          stdout TEXT,
          stderr TEXT,
          exit_code INTEGER,
          started_at TEXT,
          finished_at TEXT,
          duration_ms INTEGER,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          cost REAL,
          UNIQUE (job_id, role)
        );
        CREATE TABLE job_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          reviewer_run_id INTEGER,
          level TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      legacy
        .prepare(
          `INSERT INTO jobs (
            repo_full_name, repo_owner, repo_name, installation_id, pr_number,
            pr_title, pr_body, pr_html_url, pr_author, base_sha, head_sha, base_ref, head_ref,
            state, aggregator_prompt_tokens, aggregator_completion_tokens, aggregator_cost,
            created_at, updated_at
          ) VALUES ('acme/widgets','acme','widgets',1,1,'t','','','a','b','c','main','f',
            'completed', 9, 2, 0.01, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
      legacy
        .prepare(
          `INSERT INTO reviewer_runs (job_id, role, title, state, prompt_tokens, completion_tokens, cost)
           VALUES (1, 'correctness', 'Correctness', 'done', 4, 1, 0.002)`,
        )
        .run();
      legacy.close();

      const store = new JobStore(openDb(path));
      const job = store.getJob(1);
      expect(job?.aggregator_prompt_tokens).toBe(9);
      expect(job?.aggregator_cost).toBe(0.01);
      expect(job?.aggregator_total_tokens).toBeNull();
      expect(job?.aggregator_usage_complete).toBeNull();
      expect(job?.github_account_id).toBeNull();
      expect(job?.github_repository_id).toBeNull();
      const run = store.listReviewerRuns(1)[0];
      expect(run?.prompt_tokens).toBe(4);
      expect(run?.total_tokens).toBeNull();
      expect(run?.usage_complete).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebuilds the jobs uniqueness to include job_type so a brief coexists with a scan", () => {
    const dir = mkdtempSync(join(tmpdir(), "maomao-db-"));
    const path = join(dir, "scoped-unique.sqlite");
    try {
      // A deployed v2 database: provider-scoped five-column UNIQUE, job_type
      // carried as a plain column (exactly what the pre-brief schema looked like).
      const legacy = new Database(path);
      legacy.exec(`
        CREATE TABLE jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_full_name TEXT NOT NULL,
          repo_owner TEXT NOT NULL,
          repo_name TEXT NOT NULL,
          installation_id INTEGER NOT NULL,
          provider TEXT NOT NULL DEFAULT 'github',
          provider_instance TEXT NOT NULL DEFAULT 'github.com',
          pr_number INTEGER NOT NULL,
          pr_title TEXT NOT NULL DEFAULT '',
          pr_body TEXT NOT NULL DEFAULT '',
          pr_html_url TEXT NOT NULL DEFAULT '',
          pr_author TEXT NOT NULL DEFAULT '',
          forge_connection_id TEXT,
          github_account_id INTEGER,
          github_repository_id INTEGER,
          webhook_delivery_id TEXT,
          webhook_event TEXT,
          profile_revision_id INTEGER,
          base_sha TEXT NOT NULL,
          head_sha TEXT NOT NULL,
          base_ref TEXT NOT NULL DEFAULT '',
          head_ref TEXT NOT NULL DEFAULT '',
          state TEXT NOT NULL DEFAULT 'queued',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          job_type TEXT NOT NULL DEFAULT 'pr_review',
          scan_branch TEXT,
          UNIQUE (provider, provider_instance, repo_full_name, pr_number, head_sha)
        );
        CREATE TABLE reviewer_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          model TEXT,
          state TEXT NOT NULL DEFAULT 'queued',
          attempt INTEGER NOT NULL DEFAULT 0,
          UNIQUE (job_id, role)
        );
        CREATE TABLE job_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          reviewer_run_id INTEGER,
          level TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      legacy
        .prepare(
          `INSERT INTO jobs (repo_full_name, repo_owner, repo_name, installation_id, pr_number,
            base_sha, head_sha, job_type, scan_branch, created_at, updated_at)
           VALUES ('acme/widgets','acme','widgets',42,0,'sha1','sha1','health_scan','main',
            '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
        )
        .run();
      legacy.close();

      const store = new JobStore(openDb(path));
      const schema = new Database(path)
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'`)
        .get() as { sql: string };
      expect(schema.sql).toContain(
        "UNIQUE (provider, provider_instance, repo_full_name, pr_number, head_sha, job_type, dedup_key)",
      );

      // The pre-existing scan row survived the rebuild with its type intact
      // and the shared ('') dedup key, so scan/review dedup is unchanged.
      const preserved = store.listJobs()[0];
      expect(preserved?.job_type).toBe("health_scan");
      expect(preserved?.scan_branch).toBe("main");
      expect(preserved?.dedup_key).toBe("");

      // And a brief on the same repo+SHA is a new job, not a collision.
      const brief = store.enqueue({
        repoFullName: "acme/widgets",
        repoOwner: "acme",
        repoName: "widgets",
        installationId: 42,
        prNumber: 0,
        prTitle: "Repo brief (main)",
        prBody: "",
        prHtmlUrl: "",
        prAuthor: "octocat",
        baseSha: "sha1",
        headSha: "sha1",
        baseRef: "main",
        headRef: "main",
        jobType: "repo_brief",
        reviewers: [{ role: "repo_brief", title: "Repo brief" }],
      });
      expect(brief.created).toBe(true);
      expect(brief.job.id).not.toBe(preserved?.id);

      // And a repeat brief on the same repo+SHA is ALSO its own job: briefs
      // carry a per-request nonce, identical repeats hit repo_brief_cache.
      const repeat = store.enqueue({
        repoFullName: "acme/widgets",
        repoOwner: "acme",
        repoName: "widgets",
        installationId: 42,
        prNumber: 0,
        prTitle: "Repo brief (main)",
        prBody: "",
        prHtmlUrl: "",
        prAuthor: "octocat",
        baseSha: "sha1",
        headSha: "sha1",
        baseRef: "main",
        headRef: "main",
        jobType: "repo_brief",
        reviewers: [{ role: "repo_brief", title: "Repo brief" }],
      });
      expect(repeat.created).toBe(true);
      expect(repeat.job.id).not.toBe(brief.job.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("health-scan issue registry", () => {
  function newStore() {
    return new JobStore(openDb(":memory:"));
  }

  function scanJobInput(headSha: string) {
    return {
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 42,
      githubAccountId: 1001,
      githubRepositoryId: 2002,
      prNumber: 0,
      prTitle: "Repository health scan (main)",
      prBody: "",
      prHtmlUrl: "https://github.com/acme/widgets",
      prAuthor: "octocat",
      baseSha: headSha,
      headSha,
      baseRef: "main",
      headRef: "main",
      jobType: "health_scan" as const,
      scanBranch: "main",
      reviewers: [],
    };
  }

  it("claims fingerprints atomically and only releases pending claims", () => {
    const store = new JobStore(openDb(":memory:"));
    expect(store.claimScanIssue({ jobId: 1, repoFullName: "acme/widgets", fingerprint: "fp1", title: "t" })).toBe(true);
    // A concurrent submit loses the race.
    expect(store.claimScanIssue({ jobId: 2, repoFullName: "acme/widgets", fingerprint: "fp1", title: "t" })).toBe(false);
    // Clearing releases only pending claims; a recorded issue survives.
    store.recordScanIssue({ jobId: 1, repoFullName: "acme/widgets", fingerprint: "fp1", issueNumber: 7, issueUrl: "https://github.com/acme/widgets/issues/7", title: "t" });
    store.clearScanIssue("acme/widgets", "fp1");
    expect(store.getScanIssue("acme/widgets", "fp1")).toMatchObject({ issue_number: 7, issue_url: "https://github.com/acme/widgets/issues/7" });

    expect(store.claimScanIssue({ jobId: 3, repoFullName: "acme/widgets", fingerprint: "fp2", title: "p" })).toBe(true);
    store.clearScanIssue("acme/widgets", "fp2");
    expect(store.hasScanIssue("acme/widgets", "fp2")).toBe(false);
  });

  it("upserts provenance and sweeps only orphaned pending claims", () => {
    const store = new JobStore(openDb(":memory:"));
    store.recordScanIssue({ jobId: 1, repoFullName: "acme/widgets", fingerprint: "fpDone", issueNumber: 3, issueUrl: "u3", title: "d" });
    store.recordScanIssue({ jobId: 1, repoFullName: "acme/widgets", fingerprint: "fpDone", issueNumber: 4, issueUrl: "u4", title: "d2" });
    expect(store.getScanIssue("acme/widgets", "fpDone")?.issue_number).toBe(4);

    store.claimScanIssue({ jobId: 2, repoFullName: "acme/widgets", fingerprint: "fpPending", title: "p" });
    expect(store.clearOrphanedScanIssueClaims()).toBe(1);
    expect(store.hasScanIssue("acme/widgets", "fpPending")).toBe(false);
    expect(store.hasScanIssue("acme/widgets", "fpDone")).toBe(true);
    expect(store.clearOrphanedScanIssueClaims()).toBe(0);
  });

  it("listScanIssues is scoped to the job; getScanIssue is scoped to the repository", () => {
    const store = new JobStore(openDb(":memory:"));
    const first = store.enqueue(scanJobInput("aaaaaaaaaaaaaaaaaaaa"));
    store.recordScanIssue({ jobId: first.job.id, repoFullName: "acme/widgets", fingerprint: "fpA", issueNumber: 5, issueUrl: "u5", title: "a" });
    const second = store.enqueue(scanJobInput("bbbbbbbbbbbbbbbbbbbb"));
    expect(store.listScanIssues(first.job.id)).toHaveLength(1);
    expect(store.listScanIssues(second.job.id)).toEqual([]);
    // The rescan's finding dedups against the repository-scoped registry.
    expect(store.hasScanIssue("acme/widgets", "fpA")).toBe(true);
    expect(store.getScanIssue("acme/widgets", "fpA")?.issue_number).toBe(5);
  });
});

describe("scan job SHA staling", () => {
  it("stales an earlier scan of the same repository when a new head SHA is enqueued", () => {
    const store = new JobStore(openDb(":memory:"));
    const first = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 42,
      prNumber: 0,
      prTitle: "Repository health scan (main)",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "octocat",
      baseSha: "aaaaaaaaaaaaaaaaaaaa",
      headSha: "aaaaaaaaaaaaaaaaaaaa",
      baseRef: "main",
      headRef: "main",
      jobType: "health_scan",
      reviewers: [],
    });
    const second = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 42,
      prNumber: 0,
      prTitle: "Repository health scan (main)",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "octocat",
      baseSha: "bbbbbbbbbbbbbbbbbbbb",
      headSha: "bbbbbbbbbbbbbbbbbbbb",
      baseRef: "main",
      headRef: "main",
      jobType: "health_scan",
      reviewers: [],
    });
    expect(store.getJob(first.job.id)?.state).toBe("stale");
    expect(store.getJob(second.job.id)?.state).toBe("queued");
  });
});

describe("setFindingStatus", () => {
  it("rewrites only the targeted finding row", () => {
    const store = new JobStore(openDb(":memory:"));
    for (const fingerprint of ["fptarget00000001", "fpother000000001"]) {
      store.upsertFinding({
        repoFullName: "acme/widgets",
        prNumber: 7,
        fingerprint,
        status: "resolved",
        reviewedSha: "sha123",
        currentPath: "a.ts",
        summary: "thing",
        lastJobId: 1,
      });
    }
    store.setFindingStatus("acme/widgets", 7, "fptarget00000001", "uncertain", "GitHub resolve failed; will retry next review");
    const targeted = store.getFinding("acme/widgets", 7, "fptarget00000001");
    expect(targeted?.status).toBe("uncertain");
    expect(targeted?.reconciliation_reason).toBe("GitHub resolve failed; will retry next review");
    const untouched = store.getFinding("acme/widgets", 7, "fpother000000001");
    expect(untouched?.status).toBe("resolved");
  });
});
