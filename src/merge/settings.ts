import type { SqliteDb } from "../db.js";
import type { ForgeMergeMode, ForgeScope } from "../forge/types.js";
import { nowIso } from "../util.js";

export interface MergeModeRule {
  id: number;
  provider: string;
  providerInstance: string;
  repoFullName: string;
  mergeMode: ForgeMergeMode;
  updatedBy: string;
  updatedAt: string;
}

const MODES = new Set<ForgeMergeMode>(["disabled", "manual", "native_auto_merge", "github_native_queue"]);
const DEFAULT_MODE: ForgeMergeMode = "manual";

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

interface RuleRow {
  id: number;
  provider: string;
  provider_instance: string;
  repo_full_name: string;
  merge_mode: ForgeMergeMode;
  updated_by: string;
  updated_at: string;
}

function rowToRule(row: RuleRow): MergeModeRule {
  return {
    id: row.id,
    provider: row.provider,
    providerInstance: row.provider_instance,
    repoFullName: row.repo_full_name,
    mergeMode: row.merge_mode,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

/**
 * Explicit operator merge-mode policy. Blank scope is the global default;
 * otherwise provider+instance+repo must all be present so rules cannot leak
 * across forge connections. This store records intent only — native merge
 * actions must separately revalidate live forge capabilities and authorization.
 */
export class MergeModeSettingsStore {
  constructor(private readonly db: SqliteDb) {}

  list(): MergeModeRule[] {
    const rows = this.db.prepare("SELECT * FROM merge_mode_settings ORDER BY repo_full_name = '', provider, provider_instance, repo_full_name").all() as RuleRow[];
    return rows.map(rowToRule);
  }

  effective(scope: Partial<ForgeScope> & { repoFullName?: string }): ForgeMergeMode {
    const provider = scope.provider ?? "github";
    const instance = scope.instance ?? "github.com";
    const exact = scope.repoFullName
      ? this.db.prepare("SELECT merge_mode FROM merge_mode_settings WHERE provider = ? AND provider_instance = ? AND repo_full_name = ?")
        .get(provider, instance, scope.repoFullName.toLowerCase()) as { merge_mode: ForgeMergeMode } | undefined
      : undefined;
    if (exact) return exact.merge_mode;
    const global = this.db.prepare("SELECT merge_mode FROM merge_mode_settings WHERE provider = '' AND provider_instance = '' AND repo_full_name = ''")
      .get() as { merge_mode: ForgeMergeMode } | undefined;
    return global?.merge_mode ?? DEFAULT_MODE;
  }

  save(input: { provider?: string; providerInstance?: string; repoFullName?: string; mergeMode?: string; actor?: string }): { ok: true } | { ok: false; error: string } {
    const provider = clean(input.provider).toLowerCase();
    const providerInstance = clean(input.providerInstance).toLowerCase();
    const repoFullName = clean(input.repoFullName).toLowerCase();
    const mergeMode = clean(input.mergeMode) as ForgeMergeMode;
    if (!MODES.has(mergeMode)) return { ok: false, error: "Choose a valid merge mode." };
    const globalRule = !provider && !providerInstance && !repoFullName;
    const repoRule = Boolean(provider && providerInstance && repoFullName);
    if (!globalRule && !repoRule) return { ok: false, error: "Either leave scope blank for the global default or complete provider, instance, and repository." };
    if (repoRule && provider !== "github" && provider !== "forgejo") return { ok: false, error: "Merge modes are currently supported only for GitHub and Forgejo scopes." };
    if (mergeMode === "github_native_queue" && provider !== "github") return { ok: false, error: "GitHub native queue requires an explicit GitHub repository scope." };
    if (/\s/.test(provider) || /\s/.test(providerInstance)) return { ok: false, error: "Provider and instance must not contain whitespace." };
    if (repoFullName && !/^[^\s/]+\/[^\s/]+$/.test(repoFullName)) return { ok: false, error: "Repository must use owner/repo form." };
    if (provider.length > 100 || providerInstance.length > 255 || repoFullName.length > 255) return { ok: false, error: "Merge-mode scope is too long." };
    const actor = clean(input.actor) || "operator";
    const previous = this.db.prepare("SELECT merge_mode FROM merge_mode_settings WHERE provider = ? AND provider_instance = ? AND repo_full_name = ?")
      .get(provider, providerInstance, repoFullName) as { merge_mode?: ForgeMergeMode } | undefined;
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO merge_mode_settings (provider, provider_instance, repo_full_name, merge_mode, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, provider_instance, repo_full_name) DO UPDATE SET
           merge_mode = excluded.merge_mode,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      ).run(provider, providerInstance, repoFullName, mergeMode, actor, nowIso());
      this.audit("merge_mode_saved", actor, `${repoFullName || "global default"}@${provider || "all"}:${providerInstance || "all"} ${previous?.merge_mode ?? "unset"} -> ${mergeMode}`);
    })();
    return { ok: true };
  }

  clear(id: number, actor = "operator"): { removed: boolean } {
    const row = this.db.prepare("SELECT * FROM merge_mode_settings WHERE id = ?").get(id) as RuleRow | undefined;
    let removed = false;
    this.db.transaction(() => {
      const result = this.db.prepare("DELETE FROM merge_mode_settings WHERE id = ?").run(id);
      removed = result.changes > 0;
      if (row && removed) {
        this.audit("merge_mode_cleared", actor, `${row.repo_full_name || "global default"}@${row.provider || "all"}:${row.provider_instance || "all"} removed`);
      }
    })();
    return { removed };
  }

  private audit(action: "merge_mode_saved" | "merge_mode_cleared", actor: string, detail: string): void {
    this.db.prepare("INSERT INTO config_audit (action, actor, revision_id, detail, created_at) VALUES (?, ?, NULL, ?, ?)")
      .run(action, actor, detail, nowIso());
  }
}
