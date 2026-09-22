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

/**
 * Table identity columns for multi-forge storage (issue #18). Every row is
 * scoped to a provider + instance so credentials, deduplication keys, and
 * finding fingerprints can never collide across GitHub / GitLab.com /
 * self-managed GitLab connections. Legacy databases are rebuilt in place by
 * `migrate` with the columns defaulted to the GitHub connection.
 */
const PROVIDER_COLUMNS = "provider TEXT NOT NULL DEFAULT 'github', provider_instance TEXT NOT NULL DEFAULT 'github.com'";

function migrate(db: SqliteDb): void {
  // The rebuild below renames tables. With foreign keys on, SQLite would also
  // rewrite the REFERENCES clauses in escalation_dispatches and orphan them;
  // and even with FK off, modern ALTER TABLE RENAME rewrites references to the
  // renamed name. legacy_alter_table restores the old rename semantics (leave
  // references untouched) so the surviving tables keep pointing at "jobs".
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_full_name TEXT NOT NULL,
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      installation_id INTEGER NOT NULL,
      ${PROVIDER_COLUMNS},
      forge_connection_id TEXT,
      github_account_id INTEGER,
      github_repository_id INTEGER,
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
      job_type TEXT NOT NULL DEFAULT 'pr_review',
      brief_json TEXT,
      dedup_key TEXT NOT NULL DEFAULT '',
      UNIQUE (provider, provider_instance, repo_full_name, pr_number, head_sha, job_type, dedup_key)
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

    CREATE TABLE IF NOT EXISTS findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_full_name TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      ${PROVIDER_COLUMNS},
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
      UNIQUE (provider, provider_instance, repo_full_name, pr_number, fingerprint)
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      ${PROVIDER_COLUMNS},
      delivery_id TEXT NOT NULL,
      event TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (provider, provider_instance, delivery_id)
    );

    CREATE TABLE IF NOT EXISTS merged_pulls (
      repo_full_name TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      ${PROVIDER_COLUMNS},
      merged_at TEXT NOT NULL,
      delivery_id TEXT,
      PRIMARY KEY (provider, provider_instance, repo_full_name, pr_number)
    );

    CREATE TABLE IF NOT EXISTS processed_review_commands (
      ${PROVIDER_COLUMNS},
      comment_id TEXT NOT NULL,
      delivery_id TEXT,
      command TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (provider, provider_instance, comment_id)
    );

    CREATE TABLE IF NOT EXISTS chat_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      created_by TEXT,
      opencode_session_id TEXT,
      workspace_path TEXT,
      state TEXT NOT NULL DEFAULT 'active',
      last_error TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      cost REAL,
      total_tokens INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      cost REAL,
      total_tokens INTEGER,
      duration_ms INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profile_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      definition_json TEXT NOT NULL,
      note TEXT,
      created_by TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      edit_seq INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      activated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chat_conversations_job ON chat_conversations(job_id, id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, id);

    CREATE TABLE IF NOT EXISTS config_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      revision_id INTEGER,
      detail TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      body TEXT NOT NULL,
      note TEXT,
      created_by TEXT NOT NULL,
      edit_seq INTEGER NOT NULL DEFAULT 0,
      validation_issues TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      activated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS scan_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      repo_full_name TEXT NOT NULL,
      ${PROVIDER_COLUMNS},
      fingerprint TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      issue_url TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (provider, provider_instance, repo_full_name, fingerprint)
    );

    CREATE TABLE IF NOT EXISTS eval_fixtures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      pr_meta TEXT NOT NULL DEFAULT '{}',
      diff TEXT NOT NULL,
      expectations_json TEXT,
      saved_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_revision_id INTEGER NOT NULL,
      fixture_id INTEGER NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      findings_json TEXT,
      usage_json TEXT,
      signals_json TEXT,
      duration_ms INTEGER,
      error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS forge_connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      instance_base_url TEXT NOT NULL,
      api_base_url TEXT NOT NULL,
      token_sealed TEXT NOT NULL,
      token_fingerprint TEXT NOT NULL DEFAULT '',
      token_type TEXT NOT NULL DEFAULT 'pat',
      scope_type TEXT NOT NULL DEFAULT 'instance',
      scope_path TEXT NOT NULL DEFAULT '',
      webhook_secret_sealed TEXT NOT NULL,
      webhook_secret_fingerprint TEXT NOT NULL DEFAULT '',
      ca_pem TEXT,
      allow_private_network INTEGER NOT NULL DEFAULT 0,
      allow_insecure_http INTEGER NOT NULL DEFAULT 0,
      allow_approve INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      bot_user_id INTEGER,
      bot_username TEXT,
      token_scopes_json TEXT,
      version_json TEXT,
      last_probed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repo_brief_cache (
      provider TEXT NOT NULL,
      provider_instance TEXT NOT NULL,
      repo_full_name TEXT NOT NULL,
      sha TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (provider, provider_instance, repo_full_name, sha)
    );
  `);

    // Legacy (pre-multi-forge) databases: rebuild the provider-scoped tables so
    // the scoped keys replace the repo-name-only ones. `rebuildTableScoped`
    // skips tables that already carry the provider columns (fresh databases).
    for (const rebuild of SCOPED_REBUILDS) {
      rebuildTableScoped(db, rebuild);
    }

    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
    CREATE INDEX IF NOT EXISTS idx_logs_job ON job_logs(job_id, id);
    CREATE INDEX IF NOT EXISTS idx_runs_job ON reviewer_runs(job_id);

    CREATE INDEX IF NOT EXISTS idx_findings_pr ON findings(repo_full_name, pr_number, status);
    CREATE INDEX IF NOT EXISTS idx_findings_thread ON findings(github_thread_id);
    CREATE INDEX IF NOT EXISTS idx_findings_comment ON findings(github_comment_id);

    CREATE INDEX IF NOT EXISTS idx_profile_revisions_name ON profile_revisions(name, status);
    CREATE INDEX IF NOT EXISTS idx_prompt_revisions_role ON prompt_revisions(role_id, status);
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
    ensureColumn(db, "reviewer_runs", "prompt_revision_id", "INTEGER");
    ensureColumn(db, "jobs", "cancelled_reason", "TEXT");
    ensureColumn(db, "jobs", "cancelled_by", "TEXT");
    ensureColumn(db, "jobs", "forge_connection_id", "TEXT");
    const jobColumns: Array<[string, string]> = [
      ["brief_json", "TEXT"],
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
      ["budget_exceeded_warning", "TEXT"],
      ["poison_alert_policy", "TEXT"],
      ["manual_escalate_requested", "INTEGER NOT NULL DEFAULT 0"],
      ["profile_revision_id", "INTEGER"],
      ["job_type", "TEXT NOT NULL DEFAULT 'pr_review'"],
      ["scan_branch", "TEXT"],
      ["dedup_key", "TEXT NOT NULL DEFAULT ''"],
    ];
    for (const [name, ddl] of jobColumns) ensureColumn(db, "jobs", name, ddl);

    // Scans and repo briefs both live at pr_number 0, so job_type must be
    // part of the dedup key — otherwise a brief would collapse into a
    // health scan (or vice versa) on the same repo+SHA. dedup_key gives
    // repo briefs a per-request nonce: every confirmed brief is its own
    // job, and repeats on the same SHA are served by repo_brief_cache
    // instead of collapsing onto the first job.
    rebuildJobsForScopedJobType(db);

    const findingColumns: [string, string][] = [
      ["diff_hunk", "TEXT"],
      ["diff_note", "TEXT"],
    ];
    for (const [name, ddl] of findingColumns) ensureColumn(db, "findings", name, ddl);
  } finally {
    db.pragma("foreign_keys = ON");
    db.pragma("legacy_alter_table = OFF");
  }
  db.pragma(`user_version = 3`);
}

/**
 * One legacy-table rebuild: the exact constraint fragment from the shipped v1
 * schema and its provider-scoped replacement (which also injects the two
 * identity columns). `appendPk` tables move a column-level PRIMARY KEY to a
 * scoped table constraint, so the replacement adds the PK separately.
 */
interface ScopedRebuild {
  table: string;
  from: string;
  to: string;
  appendPk?: string;
  /** Legacy single-column PK moved into the scoped composite PK; NULLs coalesce to ''. */
  pkColumn?: string;
}

const SCOPED_REBUILDS: ScopedRebuild[] = [
  {
    table: "jobs",
    from: "UNIQUE (repo_full_name, pr_number, head_sha)",
    to: `${PROVIDER_COLUMNS},\n      UNIQUE (provider, provider_instance, repo_full_name, pr_number, head_sha)`,
  },
  {
    table: "findings",
    from: "UNIQUE (repo_full_name, pr_number, fingerprint)",
    to: `${PROVIDER_COLUMNS},\n      UNIQUE (provider, provider_instance, repo_full_name, pr_number, fingerprint)`,
  },
  {
    table: "merged_pulls",
    from: "PRIMARY KEY (repo_full_name, pr_number)",
    to: `${PROVIDER_COLUMNS},\n      PRIMARY KEY (provider, provider_instance, repo_full_name, pr_number)`,
  },
  {
    table: "scan_issues",
    from: "UNIQUE (repo_full_name, fingerprint)",
    to: `${PROVIDER_COLUMNS},\n      UNIQUE (provider, provider_instance, repo_full_name, fingerprint)`,
  },
  {
    table: "webhook_deliveries",
    from: "delivery_id TEXT PRIMARY KEY",
    to: `${PROVIDER_COLUMNS},\n      delivery_id TEXT NOT NULL`,
    appendPk: "PRIMARY KEY (provider, provider_instance, delivery_id)",
    pkColumn: "delivery_id",
  },
  {
    table: "processed_review_commands",
    from: "comment_id TEXT PRIMARY KEY",
    to: `${PROVIDER_COLUMNS},\n      comment_id TEXT NOT NULL`,
    appendPk: "PRIMARY KEY (provider, provider_instance, comment_id)",
    pkColumn: "comment_id",
  },
];

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/**
 * In-place legacy migration of one table: rename → recreate from the stored
 * CREATE statement with the scoped constraint → carry over columns that were
 * added by earlier `ensureColumn` migrations (they are absent from the stored
 * SQL) → copy rows → drop the legacy table. The whole sequence runs in one
 * transaction: any failure rolls the rename back, the legacy table and its
 * rows survive untouched, and the next start retries the migration. Row ids
 * and all data are preserved; indexes die with the rename and are recreated
 * by `migrate` afterwards.
 */
const JOBS_DEDUP_UNIQUE =
  "UNIQUE (provider, provider_instance, repo_full_name, pr_number, head_sha, job_type, dedup_key)";

function rebuildJobsForScopedJobType(db: SqliteDb): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'`)
    .get() as { sql: string } | undefined;
  if (!row?.sql) return;
  if (row.sql.includes(JOBS_DEDUP_UNIQUE)) return;
  // Legacy shapes: the pre-provider UNIQUE ended at `head_sha)`; the v2 shape
  // added `, job_type)`. Both rebuild to the canonical dedup key. An unrelated
  // constraint fails closed rather than guessing.
  const legacyPattern =
    /UNIQUE\s*\(provider,\s*provider_instance,\s*repo_full_name,\s*pr_number,\s*head_sha(\s*,\s*job_type)?\)/;
  if (!legacyPattern.test(row.sql)) {
    throw new Error(
      `Cannot migrate: expected the legacy jobs uniqueness constraint, got: ${row.sql}. Refusing to rebuild the jobs table.`,
    );
  }
  const newSql = row.sql.replace(legacyPattern, JOBS_DEDUP_UNIQUE);
  applyTableRebuild(db, "jobs", newSql);
}

function applyTableRebuild(db: SqliteDb, table: string, newSql: string): void {
  const legacyColumns = columnNames(db, table);
  const legacyName = `${table}__legacy_pre_scope`;
  db.transaction(() => {
    db.exec(`ALTER TABLE ${table} RENAME TO ${legacyName}`);
    db.exec(newSql);
    // Columns ensured after the stored CREATE text was written exist only in
    // table_info; re-add them before copying so no data is lost.
    const recreated = columnNames(db, table);
    const legacyInfo = db.prepare(`PRAGMA table_info(${legacyName})`).all() as ColumnInfo[];
    for (const info of legacyInfo) {
      if (recreated.has(info.name)) continue;
      const ddl = `${info.type}${info.notnull ? " NOT NULL" : ""}${info.dflt_value != null ? ` DEFAULT ${info.dflt_value}` : ""}`;
      db.exec(`ALTER TABLE ${table} ADD COLUMN "${info.name}" ${ddl}`);
    }
    const columnList = [...legacyColumns].map((name) => `"${name}"`).join(", ");
    db.exec(`INSERT INTO ${table} (${columnList}) SELECT ${columnList} FROM ${legacyName}`);
    db.exec(`DROP TABLE ${legacyName}`);
  })();
}

function rebuildTableScoped(db: SqliteDb, rebuild: ScopedRebuild): void {
  // Already scoped (fresh v2 database, or rebuilt in an earlier pass).
  if (columnNames(db, rebuild.table).has("provider")) return;
  const legacyName = `${rebuild.table}__maomao_migrate`;
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(rebuild.table) as { sql: string } | undefined;
  // Table not present at all: the base CREATE above already made it at v2.
  if (!row?.sql) return;
  const pattern = new RegExp(
    rebuild.from
      .replace(/[()]/g, (match) => `\\${match}`)
      // Whitespace runs become \\s* and commas consume any trailing whitespace,
      // so an externally reformatted legacy schema — "UNIQUE(a,b)", missing
      // newlines, doubled spaces — still matches the shipped formatting.
      // Content stays load-bearing: a constraint over different columns
      // refuses to match and the migration fails closed.
      .replace(/,\s*/g, ",\\s*")
      .replace(/\s+/g, "\\s*"),
  );
  if (!pattern.test(row.sql)) {
    throw new Error(
      `Cannot migrate ${rebuild.table}: expected the legacy constraint \`${rebuild.from}\` in the stored schema; refusing to rebuild.`,
    );
  }
  let newSql = row.sql.replace(pattern, rebuild.to);
  if (rebuild.appendPk) {
    const closeIndex = newSql.lastIndexOf(")");
    if (closeIndex < 0) throw new Error(`Cannot migrate ${rebuild.table}: malformed stored schema`);
    const before = newSql.slice(0, closeIndex).trimEnd();
    newSql = `${before},\n      ${rebuild.appendPk}\n    ${newSql.slice(closeIndex)}`;
  }

  const legacyColumns = columnNames(db, rebuild.table);
  db.transaction(() => {
    db.exec(`ALTER TABLE ${rebuild.table} RENAME TO ${legacyName}`);
    db.exec(newSql);
    // Columns ensured after v1 shipped exist only in table_info, not in the
    // stored CREATE text; re-add them before copying so no data is lost.
    const recreated = columnNames(db, rebuild.table);
    const legacyInfo = db.prepare(`PRAGMA table_info(${legacyName})`).all() as ColumnInfo[];
    for (const info of legacyInfo) {
      if (recreated.has(info.name)) continue;
      const ddl = `${info.type}${info.notnull ? " NOT NULL" : ""}${info.dflt_value != null ? ` DEFAULT ${info.dflt_value}` : ""}`;
      db.exec(`ALTER TABLE ${rebuild.table} ADD COLUMN "${info.name}" ${ddl}`);
    }
    // The old single-column PKs tolerated NULL (SQLite quirk); the new scoped
    // PKs do not. Legacy NULL keys belong to rows no dedup claim ever wrote.
    const select = [...legacyColumns].map(
      (name) => (rebuild.pkColumn === name ? `COALESCE("${name}", '') AS "${name}"` : `"${name}"`),
    );
    const columnList = [...legacyColumns].map((name) => `"${name}"`).join(", ");
    db.exec(
      `INSERT INTO ${rebuild.table} (${columnList}) SELECT ${select.join(", ")} FROM ${legacyName}`,
    );
    db.exec(`DROP TABLE ${legacyName}`);
  })();
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
