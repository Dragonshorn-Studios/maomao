import type { SqliteDb } from "../db.js";
import { nowIso } from "../util.js";
import type { GuidedActor } from "./store.js";

export type GuidedAttentionAction = "review_myself" | "delegate_to_maomao";
export const GUIDED_ATTENTION_REASON_TAGS = ["risk-review", "author-context", "time-sensitive", "policy", "other"] as const;
export type GuidedAttentionReasonTag = (typeof GUIDED_ATTENTION_REASON_TAGS)[number];

export interface GuidedAttentionDecisionRow {
  id: number;
  provider: string;
  provider_instance: string;
  repo_full_name: string;
  pr_number: number;
  head_sha: string;
  actor_provider: string;
  actor_id: string;
  action: GuidedAttentionAction;
  reason_tag: string;
  reason_detail: string | null;
  created_at: string;
}

export interface GuidedAttentionKey {
  provider: string;
  instance: string;
  repoFullName: string;
  prNumber: number;
  headSha: string;
}

function validKey(key: GuidedAttentionKey): boolean {
  return Boolean(key.provider && key.instance && /^[^\s/]+\/[^\s/]+$/.test(key.repoFullName) && Number.isInteger(key.prNumber) && key.prNumber > 0 && /^[0-9a-f]{7,64}$/i.test(key.headSha));
}

export class GuidedAttentionStore {
  constructor(private readonly db: SqliteDb) {}

  decisionFor(key: GuidedAttentionKey): GuidedAttentionDecisionRow | undefined {
    if (!validKey(key)) return undefined;
    return this.db.prepare(`SELECT * FROM guided_attention_decisions
      WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND pr_number = ? AND head_sha = ?`)
      .get(key.provider, key.instance, key.repoFullName, key.prNumber, key.headSha.toLowerCase()) as GuidedAttentionDecisionRow | undefined;
  }

  recordDecision(actor: GuidedActor, key: GuidedAttentionKey, action: GuidedAttentionAction, reasonTag: string, reasonDetail?: string | null): { status: "ok" | "conflict"; row: GuidedAttentionDecisionRow } {
    if (!validKey(key)) throw new Error("guided attention key is malformed");
    if (!GUIDED_ATTENTION_REASON_TAGS.includes(reasonTag as GuidedAttentionReasonTag)) throw new Error("guided attention reason tag is malformed");
    if (action !== "review_myself" && action !== "delegate_to_maomao") throw new Error("guided attention action is malformed");
    const detail = reasonDetail?.trim().slice(0, 300) || null;
    const existing = this.decisionFor(key);
    if (existing) {
      const same = existing.actor_provider === actor.actorProvider && existing.actor_id === actor.actorId && existing.action === action && existing.reason_tag === reasonTag && (existing.reason_detail ?? null) === detail;
      return { status: same ? "ok" : "conflict", row: existing };
    }
    try {
      this.db.prepare(`INSERT INTO guided_attention_decisions
        (provider, provider_instance, repo_full_name, pr_number, head_sha, actor_provider, actor_id, action, reason_tag, reason_detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(key.provider, key.instance, key.repoFullName, key.prNumber, key.headSha.toLowerCase(), actor.actorProvider, actor.actorId, action, reasonTag, detail, nowIso());
    } catch (error) {
      const raced = this.decisionFor(key);
      if (raced) return { status: raced.actor_provider === actor.actorProvider && raced.actor_id === actor.actorId && raced.action === action && raced.reason_tag === reasonTag && (raced.reason_detail ?? null) === detail ? "ok" : "conflict", row: raced };
      throw error;
    }
    const row = this.decisionFor(key);
    if (!row) throw new Error("guided attention decision did not persist");
    return { status: "ok", row };
  }


  /** Completed exact-head review jobs whose attention decision still needs a terminal, successfully published readiness gate. */
  completedJobsMissingDecidedReadiness(): number[] {
    return (this.db.prepare(`SELECT j.id
      FROM guided_attention_decisions d
      JOIN jobs j ON j.provider = d.provider AND j.provider_instance = d.provider_instance
        AND j.repo_full_name = d.repo_full_name AND j.pr_number = d.pr_number AND j.head_sha = d.head_sha
      LEFT JOIN check_publications cp ON cp.provider = d.provider AND cp.provider_instance = d.provider_instance
        AND cp.repo_full_name = d.repo_full_name AND cp.pr_number = d.pr_number AND cp.head_sha = d.head_sha
        AND cp.name = 'maomao/merge-readiness'
      WHERE j.job_type = 'pr_review' AND j.state = 'completed'
        AND (cp.id IS NULL OR cp.status != 'completed' OR cp.conclusion IS NULL OR cp.conclusion = 'action_required' OR cp.publish_error IS NOT NULL)
      ORDER BY j.id`).all() as Array<{ id: number }>).map((row) => row.id);
  }

  /** Exact-head guided sessions with evidence beyond merely opening the tab. */
  hasActiveHumanReview(key: GuidedAttentionKey): boolean {
    if (!validKey(key)) return false;
    const rows = this.db.prepare(`SELECT id, viewed_files_json, draft_summary, draft_verdict FROM guided_review_sessions
      WHERE provider = ? AND provider_instance = ? AND repo_full_name = ? AND pr_number = ? AND head_sha = ? AND historical_at IS NULL`)
      .all(key.provider, key.instance, key.repoFullName, key.prNumber, key.headSha.toLowerCase()) as Array<{ id: number; viewed_files_json: string; draft_summary: string; draft_verdict: string | null }>;
    for (const row of rows) {
      if (row.draft_summary.trim() || row.draft_verdict) return true;
      try { if ((JSON.parse(row.viewed_files_json) as unknown[]).length > 0) return true; } catch { /* malformed progress is not evidence */ }
      const comments = this.db.prepare(`SELECT COUNT(*) AS count FROM guided_review_comments WHERE session_id = ? AND deleted_at IS NULL`).get(row.id) as { count: number };
      if (comments.count > 0) return true;
    }
    return false;
  }
}
