import { createHash } from "node:crypto";
import type { SqliteDb } from "../db.js";
import { nowIso } from "../util.js";

export const GUIDED_WALKTHROUGH_PROMPT_REVISION = 2;
export const GUIDED_WALKTHROUGH_OUTPUT_CHARS = 80_000;

export type GuidedWalkthroughStatus = "pending" | "running" | "ready" | "failed" | "cancelled" | "stale";

export interface GuidedWalkthroughRow {
  id: number;
  fingerprint: string;
  provider: string;
  provider_instance: string;
  repo_full_name: string;
  pr_number: number;
  base_sha: string;
  head_sha: string;
  prompt_revision: number;
  model: string;
  status: GuidedWalkthroughStatus;
  output_json: string;
  error: string | null;
  cancel_requested: number;
  request_count: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface GuidedWalkthroughIdentity {
  provider: string;
  instance: string;
  repoFullName: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
}

export interface GuidedWalkthroughPayload {
  schema_version: 1;
  kind: "guided_walkthrough";
  intent: { text: string; uncertainty: string };
  changeMap: Array<{ path: string; summary: string; evidence: string }>;
  flow: string;
  decisions: Array<{ title: string; details: string; evidence: string }>;
  tests: string;
  risks: Array<{ question: string; path?: string; line?: number; evidence: string }>;
  generatedAt: string;
}

export function guidedWalkthroughFingerprint(identity: GuidedWalkthroughIdentity, model: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        provider: identity.provider,
        instance: identity.instance,
        repoFullName: identity.repoFullName,
        prNumber: identity.prNumber,
        baseSha: identity.baseSha,
        headSha: identity.headSha,
        promptRevision: GUIDED_WALKTHROUGH_PROMPT_REVISION,
        model: model || "opencode-default",
      }),
    )
    .digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validPayload(parsed: GuidedWalkthroughPayload): boolean {
  return (
    parsed?.schema_version === 1 &&
    parsed.kind === "guided_walkthrough" &&
    isRecord(parsed.intent) &&
    typeof parsed.intent.text === "string" &&
    typeof parsed.intent.uncertainty === "string" &&
    Array.isArray(parsed.changeMap) &&
    parsed.changeMap.every((entry) => isRecord(entry) && typeof entry.path === "string" && typeof entry.summary === "string" && typeof entry.evidence === "string") &&
    typeof parsed.flow === "string" &&
    Array.isArray(parsed.decisions) &&
    parsed.decisions.every((entry) => isRecord(entry) && typeof entry.title === "string" && typeof entry.details === "string" && typeof entry.evidence === "string") &&
    typeof parsed.tests === "string" &&
    Array.isArray(parsed.risks) &&
    parsed.risks.every((entry) => isRecord(entry) && typeof entry.question === "string" && typeof entry.evidence === "string" &&
      (entry.path === undefined || typeof entry.path === "string") &&
      (entry.line === undefined || (typeof entry.line === "number" && Number.isInteger(entry.line) && entry.line > 0))) &&
    typeof parsed.generatedAt === "string"
  );
}

function parsePayload(raw: string): GuidedWalkthroughPayload | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as GuidedWalkthroughPayload;
    return validPayload(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export interface GuidedWalkthroughView {
  fingerprint: string;
  status: GuidedWalkthroughStatus;
  payload: GuidedWalkthroughPayload | undefined;
  error: string | null;
  cancelRequested: boolean;
  requestCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function guidedWalkthroughView(row: GuidedWalkthroughRow): GuidedWalkthroughView {
  return {
    fingerprint: row.fingerprint,
    status: row.status,
    payload: parsePayload(row.output_json),
    error: row.error,
    cancelRequested: row.cancel_requested === 1,
    requestCount: row.request_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export class GuidedWalkthroughStore {
  constructor(private readonly db: SqliteDb) {}

  get(id: number): GuidedWalkthroughRow | undefined {
    return this.db.prepare("SELECT * FROM guided_walkthroughs WHERE id = ?").get(id) as GuidedWalkthroughRow | undefined;
  }

  getByFingerprint(fingerprint: string): GuidedWalkthroughRow | undefined {
    return this.db.prepare("SELECT * FROM guided_walkthroughs WHERE fingerprint = ?").get(fingerprint) as GuidedWalkthroughRow | undefined;
  }

  open(identity: GuidedWalkthroughIdentity, model: string): GuidedWalkthroughRow {
    const fingerprint = guidedWalkthroughFingerprint(identity, model);
    const existing = this.getByFingerprint(fingerprint);
    if (existing) {
      if (existing.status === "stale") {
        const revivedStatus = parsePayload(existing.output_json) ? "ready" : "pending";
        this.db
          .prepare(
            `UPDATE guided_walkthroughs SET status = ?, error = NULL, cancel_requested = 0,
               started_at = CASE WHEN ? = 'pending' THEN NULL ELSE started_at END,
               finished_at = CASE WHEN ? = 'pending' THEN NULL ELSE finished_at END,
               updated_at = ?
             WHERE id = ?`,
          )
          .run(revivedStatus, revivedStatus, revivedStatus, nowIso(), existing.id);
      }
      this.markStaleForPull(identity, fingerprint);
      return this.getByFingerprint(fingerprint) ?? existing;
    }
    const now = nowIso();
    const inserted = this.db
      .prepare(
        `INSERT INTO guided_walkthroughs (
          fingerprint, provider, provider_instance, repo_full_name, pr_number, base_sha, head_sha,
          prompt_revision, model, status, output_json, error, cancel_requested, request_count,
          created_at, updated_at, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', NULL, 0, 1, ?, ?, NULL, NULL)
        ON CONFLICT(fingerprint) DO NOTHING`,
      )
      .run(
        fingerprint,
        identity.provider,
        identity.instance,
        identity.repoFullName,
        identity.prNumber,
        identity.baseSha,
        identity.headSha,
        GUIDED_WALKTHROUGH_PROMPT_REVISION,
        model || "opencode-default",
        now,
        now,
      );
    this.markStaleForPull(identity, fingerprint);
    return this.getByFingerprint(fingerprint) ?? this.get(Number(inserted.lastInsertRowid))!;
  }

  markStaleForPull(identity: Pick<GuidedWalkthroughIdentity, "provider" | "instance" | "repoFullName" | "prNumber" | "headSha">, exceptFingerprint: string): void {
    this.db
      .prepare(
        `UPDATE guided_walkthroughs SET status = 'stale', cancel_requested = CASE WHEN status IN ('pending','running') THEN 1 ELSE cancel_requested END, updated_at = ?
         WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND pr_number = ?
           AND head_sha != ? AND fingerprint != ? AND status IN ('pending','running','ready','failed','cancelled')`,
      )
      .run(nowIso(), identity.provider, identity.instance, identity.repoFullName, identity.prNumber, identity.headSha, exceptFingerprint);
  }

  claim(id: number): boolean {
    const changed = this.db
      .prepare("UPDATE guided_walkthroughs SET status = 'running', started_at = ?, updated_at = ?, error = NULL WHERE id = ? AND status = 'pending'")
      .run(nowIso(), nowIso(), id);
    return changed.changes > 0;
  }

  cancelRequested(id: number): boolean {
    return this.get(id)?.cancel_requested === 1;
  }

  markReady(id: number, output: GuidedWalkthroughPayload): boolean {
    const encoded = JSON.stringify(output);
    const changed = this.db
      .prepare("UPDATE guided_walkthroughs SET status = 'ready', output_json = ?, error = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND cancel_requested = 0")
      .run(encoded, nowIso(), nowIso(), id);
    return changed.changes > 0;
  }

  markFailed(id: number, error: string, cancelled = false): void {
    this.db
      .prepare("UPDATE guided_walkthroughs SET status = CASE WHEN status = 'stale' THEN 'stale' ELSE ? END, error = ?, finished_at = ?, updated_at = ? WHERE id = ?")
      .run(cancelled ? "cancelled" : "failed", error.slice(0, 1000), nowIso(), nowIso(), id);
  }

  requestRetry(id: number): boolean {
    const changed = this.db
      .prepare(
        `UPDATE guided_walkthroughs SET status = 'pending', error = NULL, cancel_requested = 0,
           request_count = request_count + 1, started_at = NULL, finished_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('failed','cancelled')`,
      )
      .run(nowIso(), id);
    return changed.changes > 0;
  }

  requestCancel(id: number): boolean {
    const row = this.get(id);
    if (!row || !["pending", "running"].includes(row.status)) return false;
    this.db
      .prepare("UPDATE guided_walkthroughs SET cancel_requested = 1, status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END, updated_at = ? WHERE id = ?")
      .run(nowIso(), id);
    return true;
  }

  listStaleCancellations(identity: Pick<GuidedWalkthroughIdentity, "provider" | "instance" | "repoFullName" | "prNumber">, exceptFingerprint: string): GuidedWalkthroughRow[] {
    return this.db
      .prepare(
        `SELECT * FROM guided_walkthroughs
         WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND pr_number = ?
           AND fingerprint != ? AND status = 'stale' AND cancel_requested = 1`,
      )
      .all(identity.provider, identity.instance, identity.repoFullName, identity.prNumber, exceptFingerprint) as GuidedWalkthroughRow[];
  }

  recoverInterrupted(): number {
    const changed = this.db
      .prepare("UPDATE guided_walkthroughs SET status = 'failed', error = 'process restarted while generation was running', finished_at = ?, updated_at = ? WHERE status IN ('pending','running')")
      .run(nowIso(), nowIso());
    return changed.changes;
  }
}
