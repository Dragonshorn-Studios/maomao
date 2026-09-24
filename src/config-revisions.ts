import type { SqliteDb } from "./db.js";
import { nowIso } from "./util.js";
import { KNOWN_REVIEWER_ROLES } from "./prompts.js";
import type { Config } from "./config.js";
import type { Severity } from "./schema.js";
import { severitySchema } from "./schema.js";
import { z } from "zod";

/** System caps a draft cannot exceed, regardless of operator input. */
export const PROFILE_MAX_REVIEWERS = 12;
export const PROFILE_MAX_TIMEOUT_MS = 30 * 60 * 1000;
export const PROFILE_MAX_TOTAL_COST_USD = 5;
export const PROFILE_MAX_TOTAL_TOKENS = 2_000_000;

const KNOWN_ROLE_IDS = KNOWN_REVIEWER_ROLES.map((role) => role.id);

export const profileDefinitionSchema = z
  .object({
    /** Stable name; activating a revision retires the previously active revision of that name. */
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,48}$/, "profile name is lowercase letters, digits, and dashes"),
    /** Specialist roles to run, in order. Roles not listed are disabled. */
    reviewers: z
      .array(
        z.object({
          role: z.string().refine((role) => KNOWN_ROLE_IDS.includes(role), `unknown specialist role`),
          model: z.string().regex(/^[\w./:-]+$/, "model must be provider/model").max(120).optional(),
          timeoutMs: z.number().int().positive().max(PROFILE_MAX_TIMEOUT_MS).optional(),
        }),
      )
      .max(PROFILE_MAX_REVIEWERS),
    routerModel: z.string().regex(/^[\w./:-]+$/).max(120).optional(),
    /** Findings below this severity are not published. */
    minPublishableSeverity: severitySchema.default("info"),
    maxTotalCostUsd: z.number().positive().max(PROFILE_MAX_TOTAL_COST_USD).optional(),
    maxTotalTokens: z.number().int().positive().max(PROFILE_MAX_TOTAL_TOKENS).optional(),
    /** What happens when a cost/token ceiling is hit mid-pipeline. */
    onBudgetExceeded: z.enum(["degrade", "fail"]).default("degrade"),
  })
  .strict();

export type ProfileDefinition = z.infer<typeof profileDefinitionSchema>;

export type RevisionStatus = "draft" | "active" | "retired";

export interface ProfileRevisionRow {
  id: number;
  name: string;
  status: RevisionStatus;
  definition: ProfileDefinition;
  definition_json: string;
  note: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  schema_version: number;
  editSeq: number;
}

export const PROFILE_SCHEMA_VERSION = 1;

/** A repo-pattern → profile-name routing rule; the longest matching pattern wins. */
export interface ProfileRouteRow {
  id: number;
  pattern: string;
  profile_name: string;
  created_by: string;
  created_at: string;
}

const ROUTE_PATTERN_MAX = 200;

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid profile configuration: ${issues.join("; ")}`);
  }
}

/** Audit actions recorded for every lifecycle transition. */
export type ConfigAuditAction =
  | "draft_created"
  | "draft_updated"
  | "draft_discarded"
  | "validated"
  | "activated"
  | "rolled_back"
  | "deactivated"
  | "retired"
  | "route_added"
  | "route_removed"
  | "imported"
  | "exported";

/**
 * Versioned review-profile configuration. Revisions are immutable once left draft state;
 * activation is explicit, one active revision per name, and every transition is audited.
 * Credentials never appear here: definitions hold role/model/budget data only.
 */
export class ReviewConfigStore {
  constructor(
    private readonly db: SqliteDb,
    private readonly modelCatalog: string[] = [],
  ) {}

  createDraft(input: {
    definition: unknown;
    note?: string;
    createdBy: string;
  }): { revision: ProfileRevisionRow } | { error: "invalid"; issues: string[] } {
    const parsed = profileDefinitionSchema.safeParse(input.definition);
    if (!parsed.success) {
      return { error: "invalid", issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
    }
    const catalogIssues = validateModelCatalog(parsed.data, this.modelCatalog);
    if (catalogIssues.length > 0) return { error: "invalid", issues: catalogIssues };
    const now = nowIso();
    // The row name comes from the definition itself, so consumers keying on "default"
    // can never diverge from what the operator configured.
    const result = this.db
      .prepare(
        `INSERT INTO profile_revisions (name, status, definition_json, note, created_by, schema_version, created_at, updated_at)
         VALUES (?, 'draft', ?, ?, ?, ?, ?, ?)`,
      )
      .run(parsed.data.name, JSON.stringify(parsed.data), input.note ?? null, input.createdBy, PROFILE_SCHEMA_VERSION, now, now);
    const id = Number((result as { lastInsertRowid: unknown }).lastInsertRowid);
    this.audit("draft_created", input.createdBy, id, `draft of ${parsed.data.name}`);
    return { revision: this.getRevision(id)! };
  }

  /**
   * Updates a draft. `expectedEditSeq` provides optimistic concurrency: if another operator
   * saved the same draft first, the update is rejected as a conflict.
   */
  updateDraft(input: {
    id: number;
    definition: unknown;
    note?: string;
    expectedEditSeq: number;
    updatedBy: string;
  }): { revision: ProfileRevisionRow } | { error: "invalid"; issues: string[] } | { error: "conflict" } | { error: "not_found" } {
    const existing = this.getRevision(input.id);
    if (!existing || existing.status !== "draft") return { error: "not_found" };
    const parsed = profileDefinitionSchema.safeParse(input.definition);
    if (!parsed.success) {
      return { error: "invalid", issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
    }
    const catalogIssues = validateModelCatalog(parsed.data, this.modelCatalog);
    if (catalogIssues.length > 0) return { error: "invalid", issues: catalogIssues };
    const now = nowIso();
    const result = this.db
      .prepare(
        `UPDATE profile_revisions SET name = ?, definition_json = ?, note = ?, updated_at = ?, edit_seq = edit_seq + 1
         WHERE id = ? AND status = 'draft' AND edit_seq = ?`,
      )
      .run(parsed.data.name, JSON.stringify(parsed.data), input.note ?? existing.note, now, input.id, input.expectedEditSeq);
    const changes = (result as { changes?: number }).changes ?? 0;
    if (changes === 0) return { error: "conflict" };
    this.audit("draft_updated", input.updatedBy, input.id, `draft updated`);
    return { revision: this.getRevision(input.id)! };
  }

  /** Activation requires the revision to be a draft and to validate cleanly (catalog included). */
  activateRevision(id: number, actor: string): { revision: ProfileRevisionRow } | { error: string } {
    const revision = this.getRevision(id);
    if (!revision || revision.status === "active") return { error: "revision not found or already active" };
    if (revision.status === "retired") return { error: "cannot activate a retired revision directly; roll back instead" };
    const issues = [...validateProfileDefinition(revision.definition), ...validateModelCatalog(revision.definition, this.modelCatalog)];
    if (issues.length > 0) return { error: `cannot activate invalid revision: ${issues.join("; ")}` };
    const now = nowIso();
    const superseded = this.getActiveRevision(revision.name);
    this.db.transaction(() => {
      if (superseded) {
        this.db
          .prepare(`UPDATE profile_revisions SET status = 'retired', activated_at = ? WHERE id = ?`)
          .run(now, superseded.id);
      }
      this.db
        .prepare(`UPDATE profile_revisions SET status = 'active', activated_at = ?, updated_at = ? WHERE id = ?`)
        .run(now, now, id);
      if (superseded) this.audit("retired", actor, superseded.id, `${superseded.name} superseded by #${id}`);
    })();
    this.audit("activated", actor, id, `${revision.name} activated`);
    return { revision: this.getRevision(id)! };
  }

  /**
   * Turns the active revision off without activating another: the profile
   * stops driving jobs and its revision moves to retired (rollback can
   * re-activate it). For the profile named 'default', env configuration
   * applies while nothing is active.
   */
  deactivateRevision(id: number, actor: string): { revision: ProfileRevisionRow } | { error: string } {
    const revision = this.getRevision(id);
    if (!revision || revision.status !== "active") return { error: "only an active revision can be deactivated" };
    const now = nowIso();
    this.db
      .prepare(`UPDATE profile_revisions SET status = 'retired', updated_at = ? WHERE id = ?`)
      .run(now, id);
    this.audit("deactivated", actor, id, `${revision.name} deactivated`);
    return { revision: this.getRevision(id)! };
  }

  /** Deletes an unsaved-to-production draft; audited with the draft's name. */
  discardDraft(id: number, actor: string): { ok: true } | { error: string } {
    const revision = this.getRevision(id);
    if (!revision || revision.status !== "draft") return { error: "only a draft can be discarded" };
    this.db.prepare(`DELETE FROM profile_revisions WHERE id = ?`).run(id);
    this.audit("draft_discarded", actor, id, `draft ${revision.name} discarded`);
    return { ok: true };
  }

  /** Rollback re-activates a previous retired revision of the same name rather than editing history. */
  rollbackRevision(id: number, actor: string): { revision: ProfileRevisionRow } | { error: string } {
    const revision = this.getRevision(id);
    if (!revision || revision.status !== "retired") return { error: "only a retired revision can be re-activated" };
    const issues = [...validateProfileDefinition(revision.definition), ...validateModelCatalog(revision.definition, this.modelCatalog)];
    if (issues.length > 0) return { error: `cannot activate invalid revision: ${issues.join("; ")}` };
    const now = nowIso();
    const superseded = this.getActiveRevision(revision.name);
    this.db.transaction(() => {
      if (superseded) {
        this.db
          .prepare(`UPDATE profile_revisions SET status = 'retired' WHERE id = ?`)
          .run(superseded.id);
      }
      this.db
        .prepare(`UPDATE profile_revisions SET status = 'active', activated_at = ?, updated_at = ? WHERE id = ?`)
        .run(now, now, id);
      if (superseded) this.audit("retired", actor, superseded.id, `${superseded.name} superseded by rollback to #${id}`);
    })();
    this.audit("rolled_back", actor, id, `${revision.name} re-activated`);
    return { revision: this.getRevision(id)! };
  }

  getRevision(id: number): ProfileRevisionRow | undefined {
    const row = this.db.prepare(`SELECT * FROM profile_revisions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToRevision(row) : undefined;
  }

  /**
   * Resolves which active revision a repo's jobs run with: the longest
   * matching route pattern wins (a pattern ending in `*` is a prefix match,
   * anything else is exact); a routed name with no active revision, and any
   * repo with no matching rule, falls back to the active `default`.
   */
  resolveProfileForRepo(repoFullName: string): ProfileRevisionRow | undefined {
    const routes = this.listProfileRoutes()
      .filter((route) => matchesRoutePattern(route.pattern, repoFullName))
      .sort((a, b) => b.pattern.length - a.pattern.length);
    for (const route of routes) {
      const revision = this.getActiveRevision(route.profile_name);
      if (revision) return revision;
      console.warn(
        `config: route '${route.pattern}' points at profile '${route.profile_name}' with no active revision — falling back`,
      );
    }
    return this.getActiveRevision("default");
  }

  /** Routes targeting a profile name — used to show where a profile is in effect. */
  routesForProfile(name: string): ProfileRouteRow[] {
    return this.listProfileRoutes().filter((route) => route.profile_name === name);
  }

  listProfileRoutes(): ProfileRouteRow[] {
    const rows = this.db.prepare(`SELECT * FROM profile_routes ORDER BY LENGTH(pattern) DESC, id ASC`).all() as Record<
      string,
      unknown
    >[];
    return rows.map((row) => ({
      id: Number(row.id),
      pattern: String(row.pattern),
      profile_name: String(row.profile_name),
      created_by: String(row.created_by),
      created_at: String(row.created_at),
    }));
  }

  addProfileRoute(input: { pattern: string; profileName: string; createdBy: string }): { route: ProfileRouteRow } | { error: string } {
    const pattern = input.pattern.trim();
    const profileName = input.profileName.trim();
    if (!pattern || pattern.length > ROUTE_PATTERN_MAX || /\s/.test(pattern)) {
      return { error: "Repo pattern must be non-empty, without spaces (e.g. acme/widgets or acme/*)." };
    }
    if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(profileName)) {
      return { error: "Route must target a valid profile name." };
    }
    if (this.db.prepare(`SELECT id FROM profile_routes WHERE pattern = ?`).get(pattern)) {
      return { error: `A route for '${pattern}' already exists.` };
    }
    let result: unknown;
    try {
      result = this.db
        .prepare(`INSERT INTO profile_routes (pattern, profile_name, created_by, created_at) VALUES (?, ?, ?, ?)`)
        .run(pattern, profileName, input.createdBy, nowIso());
    } catch {
      return { error: `A route for '${pattern}' already exists.` };
    }
    const id = Number((result as { lastInsertRowid: unknown }).lastInsertRowid);
    this.audit("route_added", input.createdBy, null, `${pattern} → ${profileName}`);
    return { route: this.listProfileRoutes().find((route) => route.id === id)! };
  }

  deleteProfileRoute(id: number, actor: string): { ok: true } | { error: string } {
    const existing = this.db.prepare(`SELECT * FROM profile_routes WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!existing) return { error: "Route not found." };
    this.db.prepare(`DELETE FROM profile_routes WHERE id = ?`).run(id);
    this.audit("route_removed", actor, null, `${String(existing.pattern)} → ${String(existing.profile_name)} removed`);
    return { ok: true };
  }

  getActiveRevision(name: string): ProfileRevisionRow | undefined {
    const row = this.db.prepare(`SELECT * FROM profile_revisions WHERE name = ? AND status = 'active'`).get(name) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToRevision(row) : undefined;
  }

  listRevisions(): ProfileRevisionRow[] {
    const rows = this.db.prepare(`SELECT * FROM profile_revisions ORDER BY id DESC`).all() as Record<string, unknown>[];
    return rows.map(rowToRevision);
  }

  listAudit(limit = 100): Array<{ id: number; action: string; actor: string; revision_id: number | null; detail: string | null; created_at: string }> {
    return this.db
      .prepare(`SELECT id, action, actor, revision_id, detail, created_at FROM config_audit ORDER BY id DESC LIMIT ?`)
      .all(limit) as Array<{ id: number; action: string; actor: string; revision_id: number | null; detail: string | null; created_at: string }>;
  }

  audit(action: ConfigAuditAction, actor: string, revisionId: number | null, detail: string | null): void {
    this.db
      .prepare(`INSERT INTO config_audit (action, actor, revision_id, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(action, actor, revisionId, detail, nowIso());
  }

  /** Credential-free export: definitions only, with a schema version for forward compatibility. */
  exportConfig(): { schema_version: number; exported_at: string; revisions: Array<{ name: string; status: string; definition: ProfileDefinition; note: string | null }> } {
    this.audit("exported", "system", null, "config exported");
    return {
      schema_version: PROFILE_SCHEMA_VERSION,
      exported_at: nowIso(),
      revisions: this.listRevisions().map((revision) => ({
        name: revision.name,
        status: revision.status,
        definition: revision.definition,
        note: revision.note,
      })),
    };
  }

  /** Imports revisions as drafts regardless of the source status; activation stays explicit. */
  importConfig(input: { payload: unknown; actor: string }): { imported: number; skipped: number } | { error: string } {
    const payload = input.payload as { schema_version?: unknown; revisions?: unknown };
    if (payload?.schema_version !== PROFILE_SCHEMA_VERSION || !Array.isArray(payload.revisions)) {
      return { error: `unsupported config export (schema_version must be ${PROFILE_SCHEMA_VERSION})` };
    }
    let imported = 0;
    let skipped = 0;
    for (const entry of payload.revisions as Array<{ definition?: unknown; note?: unknown }>) {
      const result = this.createDraft({
        definition: entry.definition,
        note: typeof entry.note === "string" ? `imported: ${entry.note}` : "imported",
        createdBy: input.actor,
      });
      if ("revision" in result) imported += 1;
      else skipped += 1;
    }
    this.audit("imported", input.actor, null, `${imported} imported as drafts, ${skipped} skipped`);
    return { imported, skipped };
  }
}

/**
 * The env-derived configuration expressed as a profile definition — the
 * seeded v0. Activating it unchanged is a behavior no-op: every field mirrors
 * the value the pipeline would compute without a profile.
 */
export function envProfileDefinition(config: Config): ProfileDefinition {
  const reviewers = config.reviewers.map((role) => {
    const model = role.model || config.opencode.reviewerModel || undefined;
    return model ? { role: role.id, model } : { role: role.id };
  });
  const routerModel = config.routing.model || config.opencode.reviewerModel || undefined;
  return {
    name: "default",
    reviewers,
    ...(routerModel ? { routerModel } : {}),
    minPublishableSeverity: "info",
    onBudgetExceeded: "degrade",
  };
}

/**
 * First-boot seed: creates the premade `default` draft (v0) so operators edit a
 * prefilled baseline rather than a blank form. Idempotent — skips when any
 * revision named `default` already exists. Recorded in the audit trail as a
 * `system` action by createDraft.
 */
export function seedDefaultProfileRevision(store: ReviewConfigStore, config: Config): boolean {
  if (store.listRevisions().some((revision) => revision.name === "default")) return false;
  const result = store.createDraft({
    definition: envProfileDefinition(config),
    note: "Seeded from the environment configuration (v0). Edit it, then activate — activating it unchanged matches the env behavior exactly.",
    createdBy: "system",
  });
  if ("error" in result) {
    console.warn(`config: could not seed the default profile revision: ${result.issues.join("; ")}`);
    return false;
  }
  return true;
}

/** Model names must come from the operator-approved catalog when one is configured. */
export function validateModelCatalog(definition: ProfileDefinition, catalog: string[]): string[] {
  if (catalog.length === 0) return [];
  const issues: string[] = [];
  const allowed = new Set(catalog);
  for (const reviewer of definition.reviewers) {
    if (reviewer.model && !allowed.has(reviewer.model)) {
      issues.push(`model ${reviewer.model} for ${reviewer.role} is not in the approved catalog`);
    }
  }
  if (definition.routerModel && !allowed.has(definition.routerModel)) {
    issues.push(`router model ${definition.routerModel} is not in the approved catalog`);
  }
  return issues;
}

/** Extra semantic validation beyond the zod shape (e.g. duplicate roles, unknown models). */
export function validateProfileDefinition(definition: ProfileDefinition): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const reviewer of definition.reviewers) {
    if (seen.has(reviewer.role)) issues.push(`duplicate specialist role: ${reviewer.role}`);
    seen.add(reviewer.role);
  }
  if (definition.reviewers.length === 0) {
    issues.push("at least one specialist role is required");
  }
  for (const reviewer of definition.reviewers) {
    const model = reviewer.model;
    if (model && !/^[a-z][a-z0-9-]*\//.test(model)) {
      issues.push(`model for ${reviewer.role} must include a provider prefix (provider/model)`);
    }
  }
  return issues;
}

/** `acme/*` is a prefix match; anything else must equal the repo name exactly. */
export function matchesRoutePattern(pattern: string, repoFullName: string): boolean {
  if (pattern.endsWith("*")) return repoFullName.startsWith(pattern.slice(0, -1));
  return repoFullName === pattern;
}

function rowToRevision(row: Record<string, unknown>): ProfileRevisionRow {
  const schemaVersion = Number(row.schema_version ?? PROFILE_SCHEMA_VERSION);
  let definition: ProfileDefinition;
  try {
    if (schemaVersion !== PROFILE_SCHEMA_VERSION) {
      console.warn(
        `config: revision #${row.id} has schema_version ${schemaVersion}; expected ${PROFILE_SCHEMA_VERSION} — re-validate before activating`,
      );
    }
    definition = profileDefinitionSchema.parse(JSON.parse(String(row.definition_json)));
  } catch (error) {
    console.warn(
      `config: revision #${row.id} has an unreadable definition; treating as empty`,
      error instanceof Error ? error.message : error,
    );
    definition = profileDefinitionSchema.parse({
      name: String(row.name),
      reviewers: [],
      minPublishableSeverity: "info" as Severity,
    });
  }
  return {
    id: Number(row.id),
    name: String(row.name),
    status: String(row.status) as RevisionStatus,
    definition,
    definition_json: String(row.definition_json),
    note: (row.note as string | null) ?? null,
    created_by: String(row.created_by),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    activated_at: (row.activated_at as string | null) ?? null,
    schema_version: Number(row.schema_version ?? PROFILE_SCHEMA_VERSION),
    editSeq: Number(row.edit_seq ?? 0),
  };
}
