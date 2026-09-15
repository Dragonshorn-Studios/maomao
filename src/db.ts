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
      aggregator_reasoning_tokens INTEGER,
      aggregator_cache_read_tokens INTEGER,
      aggregator_cache_write_tokens INTEGER,
      aggregator_total_tokens INTEGER,
      aggregator_usage_complete INTEGER,
      aggregator_usage_warning TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      github_account_id INTEGER,
      github_repository_id INTEGER,
      routing_state TEXT NOT NULL DEFAULT 'queued',
      routing_mode TEXT,
      routing_profile TEXT,
      routing_reason TEXT,
      routing_confidence REAL,
      routing_signals TEXT,
      routing_reviewers TEXT,
      routing_source TEXT,
      routing_model TEXT,
      routing_provider TEXT,
      routing_raw TEXT,
      routing_prompt_tokens INTEGER,
      routing_completion_tokens INTEGER,
      routing_cost REAL,
      routing_total_tokens INTEGER,
      routing_usage_complete INTEGER,
      routing_usage_warning TEXT,
      routing_duration_ms INTEGER,
      internal_escalation_state TEXT NOT NULL DEFAULT 'not_requested',
      internal_escalation_reason TEXT,
      internal_escalation_model TEXT,
      internal_escalation_provider TEXT,
      internal_escalation_raw TEXT,
      internal_escalation_normalized TEXT,
      internal_escalation_prompt_tokens INTEGER,
      internal_escalation_completion_tokens INTEGER,
      internal_escalation_cost REAL,
      internal_escalation_total_tokens INTEGER,
      internal_escalation_usage_complete INTEGER,
      internal_escalation_usage_warning TEXT,
      internal_escalation_duration_ms INTEGER,
      internal_escalation_alert_cleared INTEGER,
      external_dispatch_status TEXT NOT NULL DEFAULT 'not_requested',
      external_dispatch_reason TEXT,
      external_dispatch_targets TEXT,
      external_dispatch_error TEXT,
      escalation_id TEXT,
      poison_alert_policy TEXT,
      manual_escalate_requested INTEGER NOT NULL DEFAULT 0,
      UNIQUE (repo_full_name, pr_number, head_sha)
    );

    CREATE TABLE IF NOT EXISTS escalation_dispatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      escalation_id TEXT NOT NULL,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      instance TEXT NOT NULL,
      repo_full_name TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      policy TEXT NOT NULL,
      target_key TEXT NOT NULL,
      target_type TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (provider, instance, repo_full_name, pr_number, head_sha, policy, target_key)
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
      reasoning_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      total_tokens INTEGER,
      usage_complete INTEGER,
      usage_warning TEXT,
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

    CREATE TABLE IF NOT EXISTS findings (
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
      diff_hunk TEXT,
      diff_note TEXT,
      last_job_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (repo_full_name, pr_number, fingerprint)
    );

    CREATE INDEX IF NOT EXISTS idx_findings_pr ON findings(repo_full_name, pr_number, status);
    CREATE INDEX IF NOT EXISTS idx_findings_thread ON findings(github_thread_id);
    CREATE INDEX IF NOT EXISTS idx_findings_comment ON findings(github_comment_id);

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_review_commands (
      comment_id TEXT PRIMARY KEY,
      delivery_id TEXT,
      command TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, "jobs", "review_event", "TEXT");
  ensureColumn(db, "jobs", "review_event_reason", "TEXT");
  ensureColumn(db, "jobs", "aggregator_fallback", "INTEGER");
  ensureColumn(db, "jobs", "github_account_id", "INTEGER");
  ensureColumn(db, "jobs", "github_repository_id", "INTEGER");
  ensureColumn(db, "jobs", "reconciliation_json", "TEXT");
  ensureColumn(db, "jobs", "risk_profile", "TEXT");
  ensureColumn(db, "jobs", "risk_reason", "TEXT");
  ensureColumn(db, "jobs", "aggregator_reasoning_tokens", "INTEGER");
  ensureColumn(db, "jobs", "aggregator_cache_read_tokens", "INTEGER");
  ensureColumn(db, "jobs", "aggregator_cache_write_tokens", "INTEGER");
  ensureColumn(db, "jobs", "aggregator_total_tokens", "INTEGER");
  ensureColumn(db, "jobs", "aggregator_usage_complete", "INTEGER");
  ensureColumn(db, "jobs", "aggregator_usage_warning", "TEXT");
  ensureColumn(db, "reviewer_runs", "reasoning_tokens", "INTEGER");
  ensureColumn(db, "reviewer_runs", "cache_read_tokens", "INTEGER");
  ensureColumn(db, "reviewer_runs", "cache_write_tokens", "INTEGER");
  ensureColumn(db, "reviewer_runs", "total_tokens", "INTEGER");
  ensureColumn(db, "reviewer_runs", "usage_complete", "INTEGER");
  ensureColumn(db, "reviewer_runs", "usage_warning", "TEXT");
  const jobColumns: Array<[string, string]> = [
    ["routing_state", "TEXT NOT NULL DEFAULT 'queued'"],
    ["routing_mode", "TEXT"],
    ["routing_profile", "TEXT"],
    ["routing_reason", "TEXT"],
    ["routing_confidence", "REAL"],
    ["routing_signals", "TEXT"],
    ["routing_reviewers", "TEXT"],
    ["routing_source", "TEXT"],
    ["routing_model", "TEXT"],
    ["routing_provider", "TEXT"],
    ["routing_raw", "TEXT"],
    ["routing_prompt_tokens", "INTEGER"],
    ["routing_completion_tokens", "INTEGER"],
    ["routing_cost", "REAL"],
    ["routing_total_tokens", "INTEGER"],
    ["routing_usage_complete", "INTEGER"],
    ["routing_usage_warning", "TEXT"],
    ["routing_duration_ms", "INTEGER"],
    ["internal_escalation_state", "TEXT NOT NULL DEFAULT 'not_requested'"],
    ["internal_escalation_reason", "TEXT"],
    ["internal_escalation_model", "TEXT"],
    ["internal_escalation_provider", "TEXT"],
    ["internal_escalation_raw", "TEXT"],
    ["internal_escalation_normalized", "TEXT"],
    ["internal_escalation_prompt_tokens", "INTEGER"],
    ["internal_escalation_completion_tokens", "INTEGER"],
    ["internal_escalation_cost", "REAL"],
    ["internal_escalation_total_tokens", "INTEGER"],
    ["internal_escalation_usage_complete", "INTEGER"],
    ["internal_escalation_usage_warning", "TEXT"],
    ["internal_escalation_duration_ms", "INTEGER"],
    ["internal_escalation_alert_cleared", "INTEGER"],
    ["external_dispatch_status", "TEXT NOT NULL DEFAULT 'not_requested'"],
    ["external_dispatch_reason", "TEXT"],
    ["external_dispatch_targets", "TEXT"],
    ["external_dispatch_error", "TEXT"],
    ["escalation_id", "TEXT"],
    ["poison_alert_policy", "TEXT"],
    ["manual_escalate_requested", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [name, ddl] of jobColumns) ensureColumn(db, "jobs", name, ddl);

  const findingColumns: [string, string][] = [
    ["diff_hunk", "TEXT"],
    ["diff_note", "TEXT"],
  ];
  for (const [name, ddl] of findingColumns) ensureColumn(db, "findings", name, ddl);
}
function columnNames(db: SqliteDb, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function ensureColumn(db: SqliteDb, table: string, name: string, ddl: string): void {
  if (!columnNames(db, table).has(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}
