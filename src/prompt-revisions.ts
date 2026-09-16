import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteDb } from "./db.js";
import { nowIso } from "./util.js";
import { parseReviewerResult } from "./schema.js";
import { promptBodyFromRolePrompt, REVIEWER_GUARDRAILS } from "./prompts.js";
import type { OpenCodePort, OpenCodeRunResult } from "./opencode/parse.js";
import type { ProfileRevisionRow } from "./config-revisions.js";

export type PromptRevisionStatus = "draft" | "active" | "retired";

export interface PromptRevisionRow {
  id: number;
  role_id: string;
  status: PromptRevisionStatus;
  /** Editable instructions only. Security guardrails are composed at runtime and never stored here. */
  body: string;
  note: string | null;
  created_by: string;
  edit_seq: number;
  validation_issues: string | null;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
}

export interface EvalFixtureRow {
  id: number;
  name: string;
  pr_meta: string;
  diff: string;
  expectations_json: string | null;
  saved_by: string;
  created_at: string;
}

export interface PromptEvaluationRow {
  id: number;
  prompt_revision_id: number;
  fixture_id: number;
  model: string;
  status: "completed" | "failed";
  findings_json: string | null;
  usage_json: string | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
}

export const EVAL_MAX_DIFF_CHARS = 50_000;
export const EVAL_MAX_BUDGET_USD = 5;
const PROMPT_BODY_MAX_CHARS = 20_000;

/** Composes the runtime prompt: non-editable guardrails first, operator body second. */
export function composeReviewerPrompt(body: string): string {
  return `${REVIEWER_GUARDRAILS}\n\n${body}`;
}

export { promptBodyFromRolePrompt };

export class PromptRevisionStore {
  constructor(private readonly db: SqliteDb) {}

  createDraft(input: {
    roleId: string;
    body: string;
    note?: string;
    createdBy: string;
  }): { revision: PromptRevisionRow } | { error: "invalid"; issues: string[] } {
    const issues: string[] = [];
    const body = input.body?.trim() ?? "";
    if (!body) issues.push("prompt body must not be empty");
    if (body.length > PROMPT_BODY_MAX_CHARS) issues.push(`prompt body exceeds ${PROMPT_BODY_MAX_CHARS} characters`);
    if (issues.length > 0) return { error: "invalid", issues };
    const now = nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO prompt_revisions (role_id, status, body, note, created_by, edit_seq, validation_issues, created_at, updated_at)
         VALUES (?, 'draft', ?, ?, ?, 0, NULL, ?, ?)`,
      )
      .run(input.roleId, body, input.note ?? null, input.createdBy, now, now);
    const id = Number((result as { lastInsertRowid: unknown }).lastInsertRowid);
    this.audit("draft_created", input.createdBy, id, `prompt draft for ${input.roleId}`);
    return { revision: this.getPromptRevision(id)! };
  }

  updatePromptDraft(input: {
    id: number;
    body: string;
    expectedEditSeq: number;
    updatedBy: string;
  }): { revision: PromptRevisionRow } | { error: "invalid"; issues: string[] } | { error: "conflict" } | { error: "not_found" } {
    const existing = this.getPromptRevision(input.id);
    if (!existing || existing.status !== "draft") return { error: "not_found" };
    const issues: string[] = [];
    const body = input.body?.trim() ?? "";
    if (!body) issues.push("prompt body must not be empty");
    if (body.length > PROMPT_BODY_MAX_CHARS) issues.push(`prompt body exceeds ${PROMPT_BODY_MAX_CHARS} characters`);
    if (issues.length > 0) return { error: "invalid", issues };
    const now = nowIso();
    const result = this.db
      .prepare(
        `UPDATE prompt_revisions SET body = ?, updated_at = ?, edit_seq = edit_seq + 1
         WHERE id = ? AND status = 'draft' AND edit_seq = ?`,
      )
      .run(body, now, input.id, input.expectedEditSeq);
    if (((result as { changes?: number }).changes ?? 0) === 0) return { error: "conflict" };
    this.audit("draft_updated", input.updatedBy, input.id, "prompt draft updated");
    return { revision: this.getPromptRevision(input.id)! };
  }

  activatePromptRevision(id: number, actor: string): { revision: PromptRevisionRow } | { error: string } {
    const revision = this.getPromptRevision(id);
    if (!revision || revision.status === "active") return { error: "revision not found or already active" };
    if (revision.status === "retired") return { error: "cannot activate a retired revision directly; roll back instead" };
    const now = nowIso();
    const superseded = this.db
      .prepare(`SELECT * FROM prompt_revisions WHERE role_id = ? AND status = 'active'`)
      .get(revision.role_id) as Record<string, unknown> | undefined;
    this.db.transaction(() => {
      if (superseded) {
        this.db.prepare(`UPDATE prompt_revisions SET status = 'retired' WHERE id = ?`).run(Number(superseded.id));
        this.audit("retired", actor, Number(superseded.id), `${revision.role_id} superseded by #${id}`);
      }
      this.db
        .prepare(`UPDATE prompt_revisions SET status = 'active', activated_at = ?, updated_at = ? WHERE id = ?`)
        .run(now, now, id);
    })();
    this.audit("activated", actor, id, `${revision.role_id} prompt activated`);
    return { revision: this.getPromptRevision(id)! };
  }

  rollbackPromptRevision(id: number, actor: string): { revision: PromptRevisionRow } | { error: string } {
    const revision = this.getPromptRevision(id);
    if (!revision || revision.status !== "retired") return { error: "only a retired revision can be re-activated" };
    const now = nowIso();
    const superseded = this.db
      .prepare(`SELECT * FROM prompt_revisions WHERE role_id = ? AND status = 'active'`)
      .get(revision.role_id) as Record<string, unknown> | undefined;
    this.db.transaction(() => {
      if (superseded) {
        this.db.prepare(`UPDATE prompt_revisions SET status = 'retired' WHERE id = ?`).run(Number(superseded.id));
        this.audit("retired", actor, Number(superseded.id), `${revision.role_id} superseded by rollback to #${id}`);
      }
      this.db
        .prepare(`UPDATE prompt_revisions SET status = 'active', activated_at = ?, updated_at = ? WHERE id = ?`)
        .run(now, now, id);
    })();
    this.audit("rolled_back", actor, id, `${revision.role_id} prompt re-activated`);
    return { revision: this.getPromptRevision(id)! };
  }

  getPromptRevision(id: number): PromptRevisionRow | undefined {
    const row = this.db.prepare(`SELECT * FROM prompt_revisions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToPromptRevision(row) : undefined;
  }

  getActivePrompt(roleId: string): PromptRevisionRow | undefined {
    const row = this.db.prepare(`SELECT * FROM prompt_revisions WHERE role_id = ? AND status = 'active'`).get(roleId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToPromptRevision(row) : undefined;
  }

  listPromptRevisions(): PromptRevisionRow[] {
    const rows = this.db.prepare(`SELECT * FROM prompt_revisions ORDER BY id DESC`).all() as Record<string, unknown>[];
    return rows.map(rowToPromptRevision);
  }

  // ---- Fixtures ----

  /** Fixtures are always operator-saved: `acknowledged` proves provenance was confirmed. */
  saveFixture(input: {
    name: string;
    prMeta: Record<string, unknown>;
    diff: string;
    expectations?: Array<{ severity: string; category?: string; pathContains?: string }>;
    savedBy: string;
    acknowledged: boolean;
  }): { fixture: EvalFixtureRow } | { error: "invalid"; issues: string[] } {
    const issues: string[] = [];
    if (!input.acknowledged) issues.push("provenance/sensitivity acknowledgement is required");
    if (!input.name?.trim()) issues.push("fixture name is required");
    if (!input.diff?.trim()) issues.push("fixture diff is required");
    if (input.diff.length > EVAL_MAX_DIFF_CHARS) issues.push(`fixture diff exceeds ${EVAL_MAX_DIFF_CHARS} characters`);
    if (issues.length > 0) return { error: "invalid", issues };
    const result = this.db
      .prepare(`INSERT INTO eval_fixtures (name, pr_meta, diff, expectations_json, saved_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        input.name.trim(),
        JSON.stringify(input.prMeta ?? {}),
        input.diff,
        input.expectations ? JSON.stringify(input.expectations) : null,
        input.savedBy,
        nowIso(),
      );
    const id = Number((result as { lastInsertRowid: unknown }).lastInsertRowid);
    return { fixture: this.getFixture(id)! };
  }

  getFixture(id: number): EvalFixtureRow | undefined {
    const row = this.db.prepare(`SELECT * FROM eval_fixtures WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToFixture(row) : undefined;
  }

  listFixtures(): EvalFixtureRow[] {
    const rows = this.db.prepare(`SELECT * FROM eval_fixtures ORDER BY id DESC`).all() as Record<string, unknown>[];
    return rows.map(rowToFixture);
  }

  // ---- Evaluation ----

  listEvaluations(promptRevisionId?: number): PromptEvaluationRow[] {
    const rows = promptRevisionId
      ? (this.db
          .prepare(`SELECT * FROM prompt_evaluations WHERE prompt_revision_id = ? ORDER BY id DESC`)
          .all(promptRevisionId) as Record<string, unknown>[])
      : (this.db.prepare(`SELECT * FROM prompt_evaluations ORDER BY id DESC`).all() as Record<string, unknown>[]);
    return rows.map(rowToEvaluation);
  }

  getEvaluation(id: number): PromptEvaluationRow | undefined {
    const row = this.db.prepare(`SELECT * FROM prompt_evaluations WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToEvaluation(row) : undefined;
  }

  /** Offline, read-only evaluation: runs a draft prompt against a saved fixture. Never touches GitHub. */
  async evaluatePrompt(input: {
    promptRevisionId: number;
    fixtureId: number;
    model: string;
    maxCostUsd?: number;
    opencode: OpenCodePort;
    extraArgs?: string[];
  }): Promise<{ evaluation: PromptEvaluationRow } | { error: string }> {
    if (input.maxCostUsd != null && input.maxCostUsd > EVAL_MAX_BUDGET_USD) {
      return { error: `evaluation budget exceeds the ${EVAL_MAX_BUDGET_USD} USD cap` };
    }
    const revision = this.getPromptRevision(input.promptRevisionId);
    if (!revision) return { error: "prompt revision not found" };
    const fixture = this.getFixture(input.fixtureId);
    if (!fixture) return { error: "fixture not found" };

    const workspace = await mkdtemp(join(tmpdir(), "maomao-eval-"));
    await writeFile(join(workspace, "pr.diff"), fixture.diff, "utf8");
    const prMeta = JSON.parse(fixture.pr_meta) as { repo?: string; prNumber?: number; title?: string; author?: string };
    const prompt = `${composeReviewerPrompt(revision.body)}

Repository: ${prMeta.repo ?? "fixture/unknown"}
PR: #${prMeta.prNumber ?? 0} ${prMeta.title ?? "(fixture)"}
Author: ${prMeta.author ?? "fixture"}
Base SHA: fixture
Head SHA: fixture

The unified diff of the fixture is available as pr.diff in the working directory.`;

    const started = Date.now();
    let result: OpenCodeRunResult;
    try {
      result = await input.opencode.run({
        cwd: workspace,
        model: input.model,
        prompt,
        timeoutMs: 10 * 60 * 1000,
        extraArgs: input.extraArgs ?? [],
        bin: "opencode",
        title: `maomao-prompt-eval-${revision.id}`,
      });
    } catch (error) {
      return this.recordFailure(input, error instanceof Error ? error.message : String(error), started);
    }
    const usage = result.usage ?? { cost: 0, totalTokens: 0, complete: false };
    const cost = usage.cost ?? 0;
    if (input.maxCostUsd != null && cost > input.maxCostUsd) {
      return this.recordFailure(input, `evaluation exceeded budget cap (${cost} > ${input.maxCostUsd})`, started);
    }
    let parsed: ReturnType<typeof parseReviewerResult>;
    try {
      parsed = parseReviewerResult(result.text || result.stdout);
    } catch (error) {
      return this.recordFailure(
        input,
        `evaluation output failed schema validation: ${error instanceof Error ? error.message : String(error)}`,
        started,
      );
    }
    const now = nowIso();
    const insert = this.db
      .prepare(
        `INSERT INTO prompt_evaluations (prompt_revision_id, fixture_id, model, status, findings_json, usage_json, duration_ms, error, created_at)
         VALUES (?, ?, ?, 'completed', ?, ?, ?, NULL, ?)`,
      )
      .run(
        input.promptRevisionId,
        input.fixtureId,
        input.model,
        JSON.stringify(parsed.findings ?? []),
        JSON.stringify({ cost, totalTokens: usage.totalTokens ?? 0, complete: usage.complete ?? false }),
        Date.now() - started,
        now,
      );
    const evaluation = this.getEvaluation(Number((insert as { lastInsertRowid: unknown }).lastInsertRowid))!;
    this.audit("evaluated", "system", input.promptRevisionId, `evaluation #${evaluation.id} vs fixture #${input.fixtureId}`);
    return { evaluation };
  }

  private recordFailure(
    input: { promptRevisionId: number; fixtureId: number; model: string },
    message: string,
    started: number,
  ): { evaluation: PromptEvaluationRow } {
    const now = nowIso();
    const insert = this.db
      .prepare(
        `INSERT INTO prompt_evaluations (prompt_revision_id, fixture_id, model, status, findings_json, usage_json, duration_ms, error, created_at)
         VALUES (?, ?, ?, 'failed', NULL, NULL, ?, ?, ?)`,
      )
      .run(input.promptRevisionId, input.fixtureId, input.model, Date.now() - started, message, now);
    const evaluation = this.getEvaluation(Number((insert as { lastInsertRowid: unknown }).lastInsertRowid))!;
    return { evaluation };
  }

  audit(action: string, actor: string, revisionId: number | null, detail: string | null): void {
    this.db
      .prepare(`INSERT INTO config_audit (action, actor, revision_id, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(action, actor, revisionId, detail, nowIso());
  }
}

/** Bounded comparison signals between an evaluation's findings and the fixture's expectations. */
export function evaluationSignals(
  findings: Array<{ severity?: string; category?: string; file?: string }>,
  expectations: Array<{ severity: string; category?: string; pathContains?: string }>,
): {
  matched: number;
  missed: number;
  unexpected: number;
} {
  const used = new Set<number>();
  let matched = 0;
  for (const expectation of expectations) {
    const index = findings.findIndex((finding, i) => {
      if (used.has(i)) return false;
      const severityOk = (finding.severity ?? "info") === expectation.severity;
      const categoryOk = !expectation.category || finding.category === expectation.category;
      const pathOk = !expectation.pathContains || (finding.file ?? "").includes(expectation.pathContains);
      return severityOk && categoryOk && pathOk;
    });
    if (index >= 0) {
      used.add(index);
      matched += 1;
    }
  }
  return { matched, missed: expectations.length - matched, unexpected: Math.max(0, findings.length - used.size) };
}

function rowToPromptRevision(row: Record<string, unknown>): PromptRevisionRow {
  return {
    id: Number(row.id),
    role_id: String(row.role_id),
    status: String(row.status) as PromptRevisionStatus,
    body: String(row.body),
    note: (row.note as string | null) ?? null,
    created_by: String(row.created_by),
    edit_seq: Number(row.edit_seq ?? 0),
    validation_issues: (row.validation_issues as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    activated_at: (row.activated_at as string | null) ?? null,
  };
}

function rowToFixture(row: Record<string, unknown>): EvalFixtureRow {
  return {
    id: Number(row.id),
    name: String(row.name),
    pr_meta: String(row.pr_meta),
    diff: String(row.diff),
    expectations_json: (row.expectations_json as string | null) ?? null,
    saved_by: String(row.saved_by),
    created_at: String(row.created_at),
  };
}

function rowToEvaluation(row: Record<string, unknown>): PromptEvaluationRow {
  return {
    id: Number(row.id),
    prompt_revision_id: Number(row.prompt_revision_id),
    fixture_id: Number(row.fixture_id),
    model: String(row.model),
    status: String(row.status) as "completed" | "failed",
    findings_json: (row.findings_json as string | null) ?? null,
    usage_json: (row.usage_json as string | null) ?? null,
    duration_ms: (row.duration_ms as number | null) ?? null,
    error: (row.error as string | null) ?? null,
    created_at: String(row.created_at),
  };
}

export type { ProfileRevisionRow };
