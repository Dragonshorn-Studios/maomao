import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SqliteDb = Database.Database;

export function openDb(path: string): SqliteDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path) || ".", { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
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

    CREATE TABLE IF NOT EXISTS reviewer_runs (
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

    CREATE TABLE IF NOT EXISTS job_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      reviewer_run_id INTEGER,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
    CREATE INDEX IF NOT EXISTS idx_logs_job ON job_logs(job_id, id);
    CREATE INDEX IF NOT EXISTS idx_runs_job ON reviewer_runs(job_id);
  `);
}
