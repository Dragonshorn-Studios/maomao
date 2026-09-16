import { nowIso } from "./util.js";
import { KNOWN_REVIEWER_ROLES } from "./prompts.js";
import type { Severity } from "./schema.js";
import { severitySchema } from "./schema.js";
import { z } from "zod";

/** System caps a draft cannot exceed, regardless of operator input. */
export const PROFILE_MAX_REVIEWERS = 12;
export const PROFILE_MAX_TIMEOUT_MS = 30 * 60 * 1000;
export const PROFILE_MAX_RETRIES = 5;
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

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid profile configuration: ${issues.join("; ")}`);
  }
}

export interface ConfigStoreDb {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

/** Audit actions recorded for every lifecycle transition. */
export type ConfigAuditAction =
  | "draft_created"
  | "draft_updated"
  | "validated"
  | "activated"
  | "rolled_back"
  | "retired"
  | "imported"
  | "exported";

/**
 * Versioned review-profile configuration. Revisions are immutable once left draft state;
 * activation is explicit, one active revision per name, and every transition is audited.
 * Credentials never appear here: definitions hold role/model/budget data only.
 */
export class ReviewConfigStore {
  constructor(
    private readonly db: ConfigStoreDb,
    private readonly modelCatalog: string[] = [],
  ) {}

  createDraft(input: {
    name: string;
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
    const result = this.db
      .prepare(
        `INSERT INTO profile_revisions (name, status, definition_json, note, created_by, schema_version, created_at, updated_at)
         VALUES (?, 'draft', ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.name, JSON.stringify(parsed.data), input.note ?? null, input.createdBy, PROFILE_SCHEMA_VERSION, now, now);
    const id = Number((result as { lastInsertRowid: unknown }).lastInsertRowid);
    this.audit("draft_created", input.createdBy, id, `draft of ${input.name}`);
    return { revision: this.getRevision(id)! };
  }

  /**
   * Updates a draft. `expectedUpdatedAt` provides optimistic concurrency: if another operator
   * saved the same draft first, the update is rejected as a conflict.
   */
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
        `UPDATE profile_revisions SET definition_json = ?, note = ?, updated_at = ?, edit_seq = edit_seq + 1
         WHERE id = ? AND status = 'draft' AND edit_seq = ?`,
      )
      .run(JSON.stringify(parsed.data), input.note ?? existing.note, now, input.id, input.expectedEditSeq);
    const changes = (result as { changes?: number }).changes ?? 0;
    if (changes === 0) return { error: "conflict" };
    this.audit("draft_updated", input.updatedBy, input.id, `draft updated`);
    return { revision: this.getRevision(input.id)! };
  }

  /** Activation requires the revision to be a draft and to validate cleanly. */
  activateRevision(id: number, actor: string): { revision: ProfileRevisionRow } | { error: string } {
    const revision = this.getRevision(id);
    if (!revision || revision.status === "active") return { error: "revision not found or already active" };
    if (revision.status === "retired") return { error: "cannot activate a retired revision directly" };
    const issues = validateProfileDefinition(revision.definition);
    if (issues.length > 0) return { error: `cannot activate invalid revision: ${issues.join("; ")}` };
    const now = nowIso();
    this.db
      .prepare(`UPDATE profile_revisions SET status = 'retired', activated_at = ? WHERE name = ? AND status = 'active'`)
      .run(now, revision.name);
    this.db
      .prepare(`UPDATE profile_revisions SET status = 'active', activated_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, id);
    this.audit("activated", actor, id, `${revision.name} activated`);
    return { revision: this.getRevision(id)! };
  }

  /** Rollback re-activates a previous retired revision of the same name rather than editing history. */
  rollbackRevision(id: number, actor: string): { revision: ProfileRevisionRow } | { error: string } {
    const revision = this.getRevision(id);
    if (!revision || revision.status !== "retired") return { error: "only a retired revision can be re-activated" };
    const issues = validateProfileDefinition(revision.definition);
    if (issues.length > 0) return { error: `cannot activate invalid revision: ${issues.join("; ")}` };
    const now = nowIso();
    this.db
      .prepare(`UPDATE profile_revisions SET status = 'retired' WHERE name = ? AND status = 'active'`)
      .run(revision.name);
    this.db
      .prepare(`UPDATE profile_revisions SET status = 'active', updated_at = ? WHERE id = ?`)
      .run(now, id);
    this.audit("rolled_back", actor, id, `${revision.name} re-activated`);
    return { revision: this.getRevision(id)! };
  }

  getRevision(id: number): ProfileRevisionRow | undefined {
    const row = this.db.prepare(`SELECT * FROM profile_revisions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToRevision(row) : undefined;
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
  importConfig(input: { payload: unknown; actor: string }): { imported: number } | { error: string } {
    const payload = input.payload as { schema_version?: unknown; revisions?: unknown };
    if (payload?.schema_version !== PROFILE_SCHEMA_VERSION || !Array.isArray(payload.revisions)) {
      return { error: `unsupported config export (schema_version must be ${PROFILE_SCHEMA_VERSION})` };
    }
    let imported = 0;
    for (const entry of payload.revisions as Array<{ name?: unknown; definition?: unknown; note?: unknown }>) {
      const result = this.createDraft({
        name: typeof entry.name === "string" ? entry.name : "",
        definition: entry.definition,
        note: typeof entry.note === "string" ? `imported: ${entry.note}` : "imported",
        createdBy: input.actor,
      });
      if ("revision" in result) imported += 1;
    }
    this.audit("imported", input.actor, null, `${imported} revision(s) imported as drafts`);
    return { imported };
  }
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
  if (!KNOWN_REVIEWER_ROLES.some((role) => role.id === definition.reviewers[0]?.role)) {
    issues.push("the first reviewer must be a known specialist role");
  }
  for (const reviewer of definition.reviewers) {
    const model = reviewer.model;
    if (model && !/^[a-z][a-z0-9-]*\//.test(model)) {
      issues.push(`model for ${reviewer.role} must include a provider prefix (provider/model)`);
    }
  }
  return issues;
}

function rowToRevision(row: Record<string, unknown>): ProfileRevisionRow {
  let definition: ProfileDefinition;
  try {
    definition = profileDefinitionSchema.parse(JSON.parse(String(row.definition_json)));
  } catch {
    definition = { name: String(row.name), reviewers: [], minPublishableSeverity: "info" as Severity } as ProfileDefinition;
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
