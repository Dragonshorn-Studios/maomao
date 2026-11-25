import type { SqliteDb } from "../db.js";
import type { TrustedChecksConfig } from "../config.js";
import { nowIso } from "../util.js";
import type { TrustedCheckName } from "./trusted.js";

export interface TrustedCheckSettings extends TrustedChecksConfig {
  enabledChecks: TrustedCheckName[];
}

export type TrustedCheckSettingsSource = "environment" | "stored" | "none";

export interface TrustedCheckSettingsStatus extends TrustedCheckSettings {
  source: TrustedCheckSettingsSource;
  hasStored: boolean;
}

interface SettingsRow {
  repo_url: string;
  local_path: string;
  revision: string;
  secrets_enabled: number;
  security_enabled: number;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function checksFromRow(row: SettingsRow): TrustedCheckName[] {
  return [
    ...(row.secrets_enabled ? ["secrets" as const] : []),
    ...(row.security_enabled ? ["security" as const] : []),
  ];
}

function complete(config: TrustedChecksConfig): boolean {
  return Boolean((config.repoUrl || config.localPath) && config.revision);
}

/**
 * Operator-managed trusted-check pinning. A complete environment configuration
 * remains authoritative; otherwise the singleton SQLite row supplies the source,
 * pinned revision, and enabled deterministic checks. No scanner secret is stored
 * here — the settings select trusted code, they do not authenticate it.
 */
export class TrustedCheckSettingsStore {
  constructor(
    private readonly db: SqliteDb,
    private readonly envConfig: TrustedChecksConfig,
  ) {}

  stored(): TrustedCheckSettings | undefined {
    const row = this.db.prepare("SELECT * FROM trusted_check_settings WHERE id = 1").get() as SettingsRow | undefined;
    if (!row) return undefined;
    return {
      repoUrl: row.repo_url,
      localPath: row.local_path,
      revision: row.revision,
      allowUnsafeLocal: this.envConfig.allowUnsafeLocal,
      enabledChecks: checksFromRow(row),
    };
  }

  effective(): TrustedCheckSettings {
    if (complete(this.envConfig)) {
      return { ...this.envConfig, enabledChecks: ["secrets", "security"] };
    }
    const stored = this.stored();
    if (stored) return stored;
    return { ...this.envConfig, enabledChecks: ["secrets", "security"] };
  }

  status(): TrustedCheckSettingsStatus {
    const effective = this.effective();
    return {
      ...effective,
      source: complete(this.envConfig) ? "environment" : complete(effective) ? "stored" : "none",
      hasStored: Boolean(this.stored()),
    };
  }

  save(input: { repoUrl?: string; localPath?: string; revision?: string; enabledChecks?: TrustedCheckName[] }): { ok: true } | { ok: false; error: string } {
    if (complete(this.envConfig)) return { ok: false, error: "Trusted checks are configured by environment variables; stored UI settings would be ignored." };
    const repoUrl = clean(input.repoUrl);
    const localPath = clean(input.localPath);
    const revision = clean(input.revision).toLowerCase();
    if (repoUrl && localPath) return { ok: false, error: "Set either a repository URL or a local path, not both." };
    if (!repoUrl && !localPath) return { ok: false, error: "A trusted-check repository URL or local path is required." };
    if (!/^[0-9a-f]{40}$/.test(revision)) return { ok: false, error: "Pinned revision must be a full 40-character commit SHA." };
    if (repoUrl.startsWith("-") || localPath.startsWith("-")) return { ok: false, error: "Trusted-check source must not begin with a dash." };
    try {
      const parsed = new URL(repoUrl);
      if (parsed.username || parsed.password) return { ok: false, error: "Do not embed credentials in the trusted-check repository URL." };
    } catch {
      // SCP-like SSH syntax (git@host:org/repo.git) is valid input for git but not URL-parseable.
    }
    if (repoUrl.length > 1000 || localPath.length > 1000) return { ok: false, error: "Trusted-check source is too long." };
    const enabled = new Set(input.enabledChecks ?? []);
    this.db.prepare(
      `INSERT INTO trusted_check_settings (id, repo_url, local_path, revision, secrets_enabled, security_enabled, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         repo_url = excluded.repo_url,
         local_path = excluded.local_path,
         revision = excluded.revision,
         secrets_enabled = excluded.secrets_enabled,
         security_enabled = excluded.security_enabled,
         updated_at = excluded.updated_at`,
    ).run(repoUrl, localPath, revision, enabled.has("secrets") ? 1 : 0, enabled.has("security") ? 1 : 0, nowIso());
    return { ok: true };
  }

  clear(): { removed: boolean } {
    if (complete(this.envConfig)) return { removed: false };
    const result = this.db.prepare("DELETE FROM trusted_check_settings WHERE id = 1").run();
    return { removed: result.changes > 0 };
  }
}
