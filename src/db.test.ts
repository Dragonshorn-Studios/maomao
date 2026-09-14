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
      const run = store.listReviewerRuns(1)[0];
      expect(run?.prompt_tokens).toBe(4);
      expect(run?.total_tokens).toBeNull();
      expect(run?.usage_complete).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
