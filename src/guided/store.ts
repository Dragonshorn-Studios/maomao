import { createHash } from "node:crypto";
import type { SqliteDb } from "../db.js";
import { normalizeScope } from "../forge/types.js";
import { nowIso } from "../util.js";

export const GUIDED_SESSION_LIMITS = {
  summaryChars: 10_000,
  commentChars: 4_000,
  commentsPerSession: 200,
  sessionsPerActor: 200,
  viewedFiles: 500,
  pathChars: 500,
  jsonChars: 4_000,
  retainedDays: 90,
} as const;

export class GuidedInputError extends Error {
  readonly status = 400;
}

export type GuidedVerdict = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
export type GuidedSessionStatus = "active" | "archived";
export type GuidedCommentKind = "inline" | "general";
export type GuidedAnchorStatus = "anchored" | "unplaced";

export interface GuidedActor {
  actorProvider: string;
  actorId: string;
}

export interface GuidedSessionKey extends GuidedActor {
  provider: string;
  instance: string;
  repoFullName: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
}

export interface GuidedReviewSessionRow {
  id: number;
  actor_provider: string;
  actor_id: string;
  provider: string;
  provider_instance: string;
  repo_full_name: string;
  pr_number: number;
  base_sha: string;
  head_sha: string;
  status: GuidedSessionStatus;
  current_path: string | null;
  current_hunk: string | null;
  position_json: string;
  viewed_files_json: string;
  draft_summary: string;
  draft_verdict: GuidedVerdict | null;
  walkthrough_ref: string | null;
  comparison_state_json: string;
  version: number;
  historical_at: string | null;
  last_mutation_id: string | null;
  created_at: string;
  updated_at: string;
  last_opened_at: string;
}

export interface GuidedReviewCommentRow {
  id: number;
  session_id: number;
  client_id: string;
  kind: GuidedCommentKind;
  body: string;
  path: string | null;
  side: "LEFT" | "RIGHT" | null;
  line: number | null;
  hunk_anchor: string | null;
  anchor_status: GuidedAnchorStatus;
  severity: "low" | "medium" | "high" | "critical" | null;
  category: string | null;
  publishable: number;
  source_comment_id: number | null;
  mutation_id: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GuidedSessionView {
  id: number;
  actorProvider: string;
  actorId: string;
  provider: string;
  instance: string;
  repoFullName: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  status: GuidedSessionStatus;
  currentPath: string | null;
  currentHunk: string | null;
  position: unknown;
  viewedFiles: string[];
  draftSummary: string;
  draftVerdict: GuidedVerdict | null;
  walkthroughRef: string | null;
  comparisonState: unknown;
  version: number;
  historicalAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
}

export interface GuidedCommentView {
  id: number;
  sessionId: number;
  clientId: string;
  kind: GuidedCommentKind;
  body: string;
  path: string | null;
  side: "LEFT" | "RIGHT" | null;
  line: number | null;
  hunkAnchor: string | null;
  anchorStatus: GuidedAnchorStatus;
  severity: "low" | "medium" | "high" | "critical" | null;
  category: string | null;
  publishable: boolean;
  sourceCommentId: number | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GuidedSessionPatch {
  status?: GuidedSessionStatus;
  currentPath?: string | null;
  currentHunk?: string | null;
  position?: unknown;
  viewedFiles?: string[];
  draftSummary?: string;
  draftVerdict?: GuidedVerdict | null;
  walkthroughRef?: string | null;
  comparisonState?: unknown;
}

export interface GuidedCommentInput {
  clientId: string;
  kind: GuidedCommentKind;
  body: string;
  path?: string | null;
  side?: "LEFT" | "RIGHT" | null;
  line?: number | null;
  hunkAnchor?: string | null;
  severity?: "low" | "medium" | "high" | "critical" | null;
  category?: string | null;
  publishable?: boolean;
  mutationId?: string;
}

export type GuidedWriteOutcome =
  | { status: "ok"; session: GuidedReviewSessionRow; comment?: GuidedReviewCommentRow; copied?: number }
  | { status: "not_found" }
  | { status: "conflict"; session: GuidedReviewSessionRow }
  | { status: "historical"; session: GuidedReviewSessionRow };

function fail(message: string): never {
  throw new GuidedInputError(message);
}

function stringField(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) fail(`${name} is too long`);
  return trimmed;
}

function optionalString(value: unknown, name: string, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string") fail(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) fail(`${name} is too long`);
  return trimmed === "" ? null : trimmed;
}

function validateActor(input: GuidedActor): GuidedActor {
  const actorProvider = stringField(input.actorProvider, "actorProvider", 40).toLowerCase();
  const actorId = stringField(input.actorId, "actorId", 100);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(actorProvider)) fail("actorProvider is malformed");
  if (!/^[A-Za-z0-9_.-]+$/.test(actorId)) fail("actorId is malformed");
  return { actorProvider, actorId };
}

function validateSha(value: unknown, name: string): string {
  const sha = stringField(value, name, 64).toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(sha)) fail(`${name} must be a hexadecimal SHA`);
  return sha;
}

function validateRepoFullName(value: unknown): string {
  const repo = stringField(value, "repoFullName", 200);
  if (!/^[^\s/]+\/[^\s/]+$/.test(repo)) fail("repoFullName must be owner/repository");
  return repo;
}

function validatePrNumber(value: unknown): number {
  const prNumber = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(prNumber) || (prNumber as number) <= 0 || (prNumber as number) > 1_000_000) {
    fail("prNumber must be a positive integer");
  }
  return prNumber as number;
}

function validatePath(value: unknown, name = "path"): string {
  const path = stringField(value, name, GUIDED_SESSION_LIMITS.pathChars);
  if (
    path.includes("\\") ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    /[\u0000-\u001f]/.test(path)
  ) {
    fail(`${name} must be a safe repository-relative path`);
  }
  return path;
}

function validateClientId(value: unknown): string {
  const clientId = stringField(value, "clientId", 80);
  if (!/^[A-Za-z0-9_-]+$/.test(clientId)) fail("clientId may contain only letters, numbers, underscore and hyphen");
  return clientId;
}

function validateMutationId(value: unknown): string | null {
  const mutationId = optionalString(value, "mutationId", 100);
  if (mutationId && !/^[A-Za-z0-9_.:-]+$/.test(mutationId)) fail("mutationId is malformed");
  return mutationId;
}

function validateVerdict(value: unknown): GuidedVerdict | null {
  if (value == null || value === "") return null;
  if (value === "COMMENT" || value === "APPROVE" || value === "REQUEST_CHANGES") return value;
  fail("draftVerdict must be COMMENT, APPROVE or REQUEST_CHANGES");
}

function validateJsonValue(value: unknown, name: string): unknown {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  const encoded = JSON.stringify(value);
  if (encoded.length > GUIDED_SESSION_LIMITS.jsonChars) fail(`${name} is too large`);
  return value;
}

function validateViewedFiles(value: unknown): string[] {
  if (!Array.isArray(value)) fail("viewedFiles must be an array");
  if (value.length > GUIDED_SESSION_LIMITS.viewedFiles) fail("viewedFiles exceeds the retention limit");
  return [...new Set(value.map((entry) => validatePath(entry, "viewedFiles entry")))];
}

function validateSessionKey(input: GuidedSessionKey): GuidedSessionKey {
  const actor = validateActor(input);
  if (typeof input.provider !== "string" || input.provider.trim() === "") fail("provider is required");
  if (typeof input.instance !== "string" || input.instance.trim() === "") fail("instance is required");
  const scope = normalizeScope({ provider: input.provider, instance: input.instance });
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(scope.provider)) fail("provider is malformed");
  if (!/^[a-z0-9.-]{1,255}$/.test(scope.instance) || scope.instance.includes("..")) fail("instance is malformed");
  return {
    ...actor,
    provider: scope.provider,
    instance: scope.instance,
    repoFullName: validateRepoFullName(input.repoFullName),
    prNumber: validatePrNumber(input.prNumber),
    baseSha: validateSha(input.baseSha, "baseSha"),
    headSha: validateSha(input.headSha, "headSha"),
  };
}

function parseObject(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export function guidedSessionView(row: GuidedReviewSessionRow): GuidedSessionView {
  return {
    id: row.id,
    actorProvider: row.actor_provider,
    actorId: row.actor_id,
    provider: row.provider,
    instance: row.provider_instance,
    repoFullName: row.repo_full_name,
    prNumber: row.pr_number,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    status: row.status,
    currentPath: row.current_path,
    currentHunk: row.current_hunk,
    position: parseObject(row.position_json),
    viewedFiles: parseStringArray(row.viewed_files_json),
    draftSummary: row.draft_summary,
    draftVerdict: row.draft_verdict,
    walkthroughRef: row.walkthrough_ref,
    comparisonState: parseObject(row.comparison_state_json),
    version: row.version,
    historicalAt: row.historical_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
  };
}

export function guidedCommentView(row: GuidedReviewCommentRow): GuidedCommentView {
  return {
    id: row.id,
    sessionId: row.session_id,
    clientId: row.client_id,
    kind: row.kind,
    body: row.body,
    path: row.path,
    side: row.side,
    line: row.line,
    hunkAnchor: row.hunk_anchor,
    anchorStatus: row.anchor_status,
    severity: row.severity,
    category: row.category,
    publishable: row.publishable === 1,
    sourceCommentId: row.source_comment_id,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateCommentInput(input: GuidedCommentInput): GuidedCommentInput {
  const kind = input.kind;
  if (kind !== "inline" && kind !== "general") fail("kind must be inline or general");
  const body = stringField(input.body, "body", GUIDED_SESSION_LIMITS.commentChars);
  const clientId = validateClientId(input.clientId);
  const path = input.path == null ? null : validatePath(input.path);
  const side = input.side == null ? null : input.side;
  if (side != null && side !== "LEFT" && side !== "RIGHT") fail("side must be LEFT or RIGHT");
  const line = input.line == null ? null : input.line;
  if (line != null && (!Number.isInteger(line) || line <= 0 || line > 1_000_000)) fail("line must be a positive integer");
  const hunkAnchor = optionalString(input.hunkAnchor, "hunkAnchor", 200);
  const severity = input.severity == null ? null : input.severity;
  if (severity != null && !["low", "medium", "high", "critical"].includes(severity)) fail("severity is invalid");
  const category = optionalString(input.category, "category", 80);
  if (kind === "inline") {
    if (!path) fail("inline comments require a path");
    if (line == null && !hunkAnchor) fail("inline comments require a line or hunk anchor");
    if (line != null && !side) fail("line-anchored inline comments require a side");
  } else if (path || side || line != null || hunkAnchor) {
    fail("general comments cannot carry inline coordinates");
  }
  return {
    ...input,
    clientId,
    kind,
    body,
    path,
    side,
    line,
    hunkAnchor,
    severity,
    category,
    publishable: input.publishable === true,
    mutationId: validateMutationId(input.mutationId) ?? undefined,
  };
}

export class GuidedReviewStore {
  constructor(private readonly db: SqliteDb) {}

  open(input: GuidedSessionKey): {
    session: GuidedReviewSessionRow;
    comments: GuidedReviewCommentRow[];
    staleFrom?: GuidedReviewSessionRow;
  } {
    const key = validateSessionKey(input);
    return this.db.transaction(() => {
      const existing = this.byKey(key);
      const now = nowIso();
      if (existing) {
        const previous = this.latestOtherSession(key, existing.id);
        this.db.prepare(`UPDATE guided_review_sessions SET historical_at = NULL, last_opened_at = ? WHERE id = ?`).run(now, existing.id);
        this.markOtherSessionsHistorical(key, existing.id, now);
        const session = this.byId(existing.id) ?? existing;
        return { session, comments: this.listComments(session.id), ...(previous && !previous.historical_at ? { staleFrom: previous } : {}) };
      }

      const previous = this.db
        .prepare(
          `SELECT * FROM guided_review_sessions
           WHERE actor_provider = ? AND actor_id = ?
             AND provider = ? AND provider_instance = ?
             AND repo_full_name = ? AND pr_number = ?
             AND (base_sha <> ? OR head_sha <> ?)
           ORDER BY updated_at DESC, id DESC LIMIT 1`,
        )
        .get(
          key.actorProvider,
          key.actorId,
          key.provider,
          key.instance,
          key.repoFullName,
          key.prNumber,
          key.baseSha,
          key.headSha,
        ) as GuidedReviewSessionRow | undefined;
      const session = this.insertSession(key);
      if (previous) this.markOtherSessionsHistorical(key, session.id, now);
      this.pruneHistorical(key);
      return { session, comments: [], staleFrom: previous };
    })();
  }

  getOwned(id: number, actor: GuidedActor): GuidedReviewSessionRow | undefined {
    const validActor = validateActor(actor);
    return this.db
      .prepare(`SELECT * FROM guided_review_sessions WHERE id = ? AND actor_provider = ? AND actor_id = ?`)
      .get(id, validActor.actorProvider, validActor.actorId) as GuidedReviewSessionRow | undefined;
  }

  /** Exact SHA-keyed lookup without the creation side effect of `open`. */
  findExact(actor: GuidedActor, key: GuidedSessionKey): GuidedReviewSessionRow | undefined {
    const validActor = validateActor(actor);
    return this.db.prepare(`SELECT * FROM guided_review_sessions
      WHERE actor_provider = ? AND actor_id = ? AND provider = ? AND provider_instance = ?
        AND repo_full_name = ? AND pr_number = ? AND base_sha = ? AND head_sha = ?`)
      .get(validActor.actorProvider, validActor.actorId, key.provider, key.instance, key.repoFullName, key.prNumber, key.baseSha, key.headSha) as GuidedReviewSessionRow | undefined;
  }

  /** Newest draft for this actor/forge/pull regardless of SHA, used for inbox state. */
  latestForPull(actor: GuidedActor, provider: string, providerInstance: string, repoFullName: string, prNumber: number): GuidedReviewSessionRow | undefined {
    const validActor = validateActor(actor);
    return this.db.prepare(`SELECT * FROM guided_review_sessions
      WHERE actor_provider = ? AND actor_id = ? AND provider = ? AND provider_instance = ? AND repo_full_name = ? AND pr_number = ?
      ORDER BY updated_at DESC, id DESC LIMIT 1`)
      .get(validActor.actorProvider, validActor.actorId, provider, providerInstance, repoFullName, prNumber) as GuidedReviewSessionRow | undefined;
  }

  /** Count non-deleted draft comments for one session. */
  activeCommentCount(sessionId: number): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM guided_review_comments WHERE session_id = ? AND deleted_at IS NULL`).get(sessionId) as { count: number };
    return row.count;
  }

  listComments(sessionId: number, includeDeleted = false): GuidedReviewCommentRow[] {
    return this.db
      .prepare(
        `SELECT * FROM guided_review_comments
         WHERE session_id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}
         ORDER BY id ASC`,
      )
      .all(sessionId) as GuidedReviewCommentRow[];
  }

  updateSession(id: number, actor: GuidedActor, version: number, patch: GuidedSessionPatch, mutationId?: string): GuidedWriteOutcome {
    const validActor = validateActor(actor);
    if (!Number.isInteger(version) || version <= 0) fail("version must be a positive integer");
    const cleanMutationId = validateMutationId(mutationId);
    return this.db.transaction(() => {
      const row = this.getOwned(id, validActor);
      if (!row) return { status: "not_found" } satisfies GuidedWriteOutcome;
      if (cleanMutationId && row.last_mutation_id === cleanMutationId) {
        return { status: "ok", session: row } satisfies GuidedWriteOutcome;
      }
      if (row.historical_at) return { status: "historical", session: row } satisfies GuidedWriteOutcome;
      if (row.version !== version) return { status: "conflict", session: row } satisfies GuidedWriteOutcome;

      const sets: string[] = [];
      const values: unknown[] = [];
      if (patch.status !== undefined) {
        if (patch.status !== "active" && patch.status !== "archived") fail("status must be active or archived");
        sets.push("status = ?");
        values.push(patch.status);
      }
      if (patch.currentPath !== undefined) {
        sets.push("current_path = ?");
        values.push(patch.currentPath == null ? null : validatePath(patch.currentPath, "currentPath"));
      }
      if (patch.currentHunk !== undefined) {
        sets.push("current_hunk = ?");
        values.push(optionalString(patch.currentHunk, "currentHunk", 200));
      }
      if (patch.position !== undefined) {
        sets.push("position_json = ?");
        values.push(JSON.stringify(validateJsonValue(patch.position, "position")));
      }
      if (patch.viewedFiles !== undefined) {
        sets.push("viewed_files_json = ?");
        values.push(JSON.stringify(validateViewedFiles(patch.viewedFiles)));
      }
      if (patch.draftSummary !== undefined) {
        if (typeof patch.draftSummary !== "string") fail("draftSummary must be a string");
        if (patch.draftSummary.length > GUIDED_SESSION_LIMITS.summaryChars) fail("draftSummary is too long");
        sets.push("draft_summary = ?");
        values.push(patch.draftSummary);
      }
      if (patch.draftVerdict !== undefined) {
        sets.push("draft_verdict = ?");
        values.push(validateVerdict(patch.draftVerdict));
      }
      if (patch.walkthroughRef !== undefined) {
        sets.push("walkthrough_ref = ?");
        values.push(optionalString(patch.walkthroughRef, "walkthroughRef", 200));
      }
      if (patch.comparisonState !== undefined) {
        sets.push("comparison_state_json = ?");
        values.push(JSON.stringify(validateJsonValue(patch.comparisonState, "comparisonState")));
      }
      if (sets.length === 0) fail("session patch is empty");
      const now = nowIso();
      sets.push("version = version + 1", "updated_at = ?", "last_mutation_id = ?");
      values.push(now, cleanMutationId);
      this.db
        .prepare(`UPDATE guided_review_sessions SET ${sets.join(", ")} WHERE id = ?`)
        .run(...values, id);
      const session = this.byId(id);
      if (!session) throw new Error("guided review session disappeared during update");
      return { status: "ok", session } satisfies GuidedWriteOutcome;
    })();
  }

  upsertComment(id: number, actor: GuidedActor, version: number, input: GuidedCommentInput): GuidedWriteOutcome {
    const validActor = validateActor(actor);
    if (!Number.isInteger(version) || version <= 0) fail("version must be a positive integer");
    const clean = validateCommentInput(input);
    return this.db.transaction(() => {
      const row = this.getOwned(id, validActor);
      if (!row) return { status: "not_found" } satisfies GuidedWriteOutcome;
      const existing = this.commentByClientId(id, clean.clientId);
      if (existing && clean.mutationId && existing.mutation_id === clean.mutationId) {
        return { status: "ok", session: row, comment: existing } satisfies GuidedWriteOutcome;
      }
      if (row.historical_at) return { status: "historical", session: row } satisfies GuidedWriteOutcome;
      if (row.version !== version) return { status: "conflict", session: row } satisfies GuidedWriteOutcome;
      const activeCount = this.db
        .prepare(`SELECT COUNT(*) AS count FROM guided_review_comments WHERE session_id = ? AND deleted_at IS NULL`)
        .get(id) as { count: number };
      if ((!existing || existing.deleted_at) && activeCount.count >= GUIDED_SESSION_LIMITS.commentsPerSession) {
        fail(`a guided review session may retain at most ${GUIDED_SESSION_LIMITS.commentsPerSession} comments`);
      }
      const now = nowIso();
      if (existing) {
        this.db
          .prepare(
            `UPDATE guided_review_comments
             SET kind = ?, body = ?, path = ?, side = ?, line = ?, hunk_anchor = ?, anchor_status = 'anchored',
                 severity = ?, category = ?, publishable = ?, mutation_id = ?, deleted_at = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            clean.kind,
            clean.body,
            clean.path,
            clean.side,
            clean.line,
            clean.hunkAnchor,
            clean.severity,
            clean.category,
            clean.publishable ? 1 : 0,
            clean.mutationId ?? null,
            now,
            existing.id,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO guided_review_comments
             (session_id, client_id, kind, body, path, side, line, hunk_anchor, anchor_status, severity, category,
              publishable, mutation_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'anchored', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            clean.clientId,
            clean.kind,
            clean.body,
            clean.path,
            clean.side,
            clean.line,
            clean.hunkAnchor,
            clean.severity,
            clean.category,
            clean.publishable ? 1 : 0,
            clean.mutationId ?? null,
            now,
            now,
          );
      }
      this.bumpSession(id, now);
      const session = this.byId(id);
      const comment = this.commentByClientId(id, clean.clientId);
      if (!session || !comment) throw new Error("guided review comment write did not persist");
      return { status: "ok", session, comment } satisfies GuidedWriteOutcome;
    })();
  }

  deleteComment(id: number, actor: GuidedActor, version: number, clientId: string, mutationId?: string): GuidedWriteOutcome {
    const validActor = validateActor(actor);
    if (!Number.isInteger(version) || version <= 0) fail("version must be a positive integer");
    const cleanClientId = validateClientId(clientId);
    const cleanMutationId = validateMutationId(mutationId);
    return this.db.transaction(() => {
      const row = this.getOwned(id, validActor);
      if (!row) return { status: "not_found" } satisfies GuidedWriteOutcome;
      const existing = this.commentByClientId(id, cleanClientId);
      if (!existing || existing.deleted_at) {
        return { status: "ok", session: row, comment: existing } satisfies GuidedWriteOutcome;
      }
      if (cleanMutationId && existing.mutation_id === cleanMutationId) {
        return { status: "ok", session: row, comment: existing } satisfies GuidedWriteOutcome;
      }
      if (row.historical_at) return { status: "historical", session: row } satisfies GuidedWriteOutcome;
      if (row.version !== version) return { status: "conflict", session: row } satisfies GuidedWriteOutcome;
      const now = nowIso();
      this.db
        .prepare(`UPDATE guided_review_comments SET deleted_at = ?, mutation_id = ?, updated_at = ? WHERE id = ?`)
        .run(now, cleanMutationId, now, existing.id);
      this.bumpSession(id, now);
      const session = this.byId(id);
      const comment = this.commentByClientId(id, cleanClientId);
      if (!session) throw new Error("guided review session disappeared during delete");
      return { status: "ok", session, comment } satisfies GuidedWriteOutcome;
    })();
  }

  copyToSha(
    sourceId: number,
    actor: GuidedActor,
    targetBaseSha: string,
    targetHeadSha: string,
  ): GuidedWriteOutcome {
    const validActor = validateActor(actor);
    const baseSha = validateSha(targetBaseSha, "targetBaseSha");
    const headSha = validateSha(targetHeadSha, "targetHeadSha");
    return this.db.transaction(() => {
      const source = this.getOwned(sourceId, validActor);
      if (!source) return { status: "not_found" } satisfies GuidedWriteOutcome;
      if (source.base_sha === baseSha && source.head_sha === headSha) {
        fail("copy target must use a different base or head SHA");
      }
      const key = validateSessionKey({
        ...validActor,
        provider: source.provider,
        instance: source.provider_instance,
        repoFullName: source.repo_full_name,
        prNumber: source.pr_number,
        baseSha,
        headSha,
      });
      const now = nowIso();
      const target = this.byKey(key) ?? this.insertSession(key);
      this.db.prepare(`UPDATE guided_review_sessions SET historical_at = NULL WHERE id = ?`).run(target.id);
      this.markOtherSessionsHistorical(key, target.id, now);

      let copied = 0;
      for (const comment of this.listComments(source.id)) {
        const copyClientId = `copy-${createHash("sha256")
          .update(`${source.id}:${comment.client_id}`)
          .digest("base64url")
          .slice(0, 48)}`;
        const result = this.db
          .prepare(
            `INSERT OR IGNORE INTO guided_review_comments
             (session_id, client_id, kind, body, path, side, line, hunk_anchor, anchor_status, severity, category,
              publishable, source_comment_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            target.id,
            copyClientId,
            comment.kind,
            comment.body,
            comment.path,
            comment.side,
            comment.line,
            comment.hunk_anchor,
            comment.kind === "inline" ? "unplaced" : "anchored",
            comment.severity,
            comment.category,
            0,
            comment.id,
            now,
            now,
          );
        copied += result.changes;
      }
      if (copied > 0) this.bumpSession(target.id, now);
      this.pruneHistorical(key);
      const session = this.byId(target.id);
      if (!session) throw new Error("guided review copy target disappeared");
      return { status: "ok", session, copied } satisfies GuidedWriteOutcome;
    })();
  }

  private latestOtherSession(key: GuidedSessionKey, excludeId: number): GuidedReviewSessionRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM guided_review_sessions
         WHERE actor_provider = ? AND actor_id = ?
           AND provider = ? AND provider_instance = ?
           AND repo_full_name = ? AND pr_number = ?
           AND id <> ?
         ORDER BY updated_at DESC, id DESC LIMIT 1`,
      )
      .get(key.actorProvider, key.actorId, key.provider, key.instance, key.repoFullName, key.prNumber, excludeId) as GuidedReviewSessionRow | undefined;
  }

  private markOtherSessionsHistorical(key: GuidedSessionKey, keepId: number, now: string): void {
    this.db
      .prepare(
        `UPDATE guided_review_sessions SET historical_at = COALESCE(historical_at, ?)
         WHERE actor_provider = ? AND actor_id = ?
           AND provider = ? AND provider_instance = ?
           AND repo_full_name = ? AND pr_number = ?
           AND id <> ? AND historical_at IS NULL`,
      )
      .run(now, key.actorProvider, key.actorId, key.provider, key.instance, key.repoFullName, key.prNumber, keepId);
  }

  private insertSession(key: GuidedSessionKey): GuidedReviewSessionRow {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO guided_review_sessions
         (actor_provider, actor_id, provider, provider_instance, repo_full_name, pr_number, base_sha, head_sha,
          status, position_json, viewed_files_json, draft_summary, comparison_state_json, version, created_at, updated_at, last_opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', '{}', '[]', '', '{}', 1, ?, ?, ?)`,
      )
      .run(
        key.actorProvider,
        key.actorId,
        key.provider,
        key.instance,
        key.repoFullName,
        key.prNumber,
        key.baseSha,
        key.headSha,
        now,
        now,
        now,
      );
    const row = this.db
      .prepare(`SELECT * FROM guided_review_sessions WHERE id = last_insert_rowid()`)
      .get() as GuidedReviewSessionRow | undefined;
    if (!row) throw new Error("failed to create guided review session");
    return row;
  }

  private byId(id: number): GuidedReviewSessionRow | undefined {
    return this.db.prepare(`SELECT * FROM guided_review_sessions WHERE id = ?`).get(id) as
      | GuidedReviewSessionRow
      | undefined;
  }

  private byKey(key: GuidedSessionKey): GuidedReviewSessionRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM guided_review_sessions
         WHERE actor_provider = ? AND actor_id = ? AND provider = ? AND provider_instance = ?
           AND repo_full_name = ? AND pr_number = ? AND base_sha = ? AND head_sha = ?`,
      )
      .get(
        key.actorProvider,
        key.actorId,
        key.provider,
        key.instance,
        key.repoFullName,
        key.prNumber,
        key.baseSha,
        key.headSha,
      ) as GuidedReviewSessionRow | undefined;
  }

  private commentByClientId(sessionId: number, clientId: string): GuidedReviewCommentRow | undefined {
    return this.db
      .prepare(`SELECT * FROM guided_review_comments WHERE session_id = ? AND client_id = ?`)
      .get(sessionId, clientId) as GuidedReviewCommentRow | undefined;
  }

  private bumpSession(id: number, now: string): void {
    this.db
      .prepare(`UPDATE guided_review_sessions SET version = version + 1, updated_at = ? WHERE id = ?`)
      .run(now, id);
  }

  private pruneHistorical(key: GuidedSessionKey): void {
    const cutoff = new Date(Date.now() - GUIDED_SESSION_LIMITS.retainedDays * 24 * 60 * 60 * 1000).toISOString();
    this.db
      .prepare(
        `DELETE FROM guided_review_sessions
         WHERE actor_provider = ? AND actor_id = ? AND provider = ? AND provider_instance = ?
           AND historical_at IS NOT NULL AND historical_at < ?`,
      )
      .run(key.actorProvider, key.actorId, key.provider, key.instance, cutoff);

    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM guided_review_sessions WHERE actor_provider = ? AND actor_id = ?`)
      .get(key.actorProvider, key.actorId) as { count: number };
    const overflow = countRow.count - GUIDED_SESSION_LIMITS.sessionsPerActor;
    if (overflow <= 0) return;
    // Bounded retention first drops the oldest already-superseded drafts. If
    // the actor genuinely has more active/current drafts than the cap, fail
    // the new open explicitly rather than deleting live work silently.
    this.db
      .prepare(
        `DELETE FROM guided_review_sessions
         WHERE id IN (
           SELECT id FROM guided_review_sessions
           WHERE actor_provider = ? AND actor_id = ? AND historical_at IS NOT NULL
           ORDER BY historical_at ASC, id ASC LIMIT ?
         )`,
      )
      .run(key.actorProvider, key.actorId, overflow);
    const afterHistorical = this.db
      .prepare(`SELECT COUNT(*) AS count FROM guided_review_sessions WHERE actor_provider = ? AND actor_id = ?`)
      .get(key.actorProvider, key.actorId) as { count: number };
    const archivedOverflow = afterHistorical.count - GUIDED_SESSION_LIMITS.sessionsPerActor;
    if (archivedOverflow > 0) {
      this.db
        .prepare(
          `DELETE FROM guided_review_sessions
           WHERE id IN (
             SELECT id FROM guided_review_sessions
             WHERE actor_provider = ? AND actor_id = ? AND status = 'archived'
             ORDER BY updated_at ASC, id ASC LIMIT ?
           )`,
        )
        .run(key.actorProvider, key.actorId, archivedOverflow);
    }
    const remaining = this.db
      .prepare(`SELECT COUNT(*) AS count FROM guided_review_sessions WHERE actor_provider = ? AND actor_id = ?`)
      .get(key.actorProvider, key.actorId) as { count: number };
    if (remaining.count > GUIDED_SESSION_LIMITS.sessionsPerActor) {
      fail(`guided review session retention limit reached (${GUIDED_SESSION_LIMITS.sessionsPerActor}); archive old drafts before opening more`);
    }
  }
}
