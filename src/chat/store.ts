/**
 * Code-explainer chat (issue: "Ask Maomao" on the job page). A conversation
 * is bound to one job and one opencode session; every assistant reply is a
 * read-only `opencode run` in the job's checked-out workspace. Maomao is the
 * only surface: the browser talks to maomao routes, never to opencode.
 */
import type { SqliteDb } from "../db.js";
import { nowIso } from "../util.js";

export interface ChatConversationRow {
  id: number;
  job_id: number;
  created_by: string | null;
  opencode_session_id: string | null;
  workspace_path: string | null;
  /** active | error — error carries the reason in last_error. */
  state: "active" | "error";
  last_error: string | null;
  message_count: number;
  cost: number | null;
  total_tokens: number | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageRow {
  id: number;
  conversation_id: number;
  role: "user" | "assistant";
  content: string;
  cost: number | null;
  total_tokens: number | null;
  duration_ms: number | null;
  created_at: string;
}

export class ChatStore {
  constructor(private readonly db: SqliteDb) {}

  createConversation(jobId: number, createdBy: string | null): ChatConversationRow {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO chat_conversations (job_id, created_by, state, message_count, created_at, updated_at)
         VALUES (?, ?, 'active', 0, ?, ?)`,
      )
      .run(jobId, createdBy, now, now);
    const row = this.db
      .prepare(`SELECT * FROM chat_conversations WHERE id = last_insert_rowid()`)
      .get() as ChatConversationRow;
    return row;
  }

  getConversation(id: number): ChatConversationRow | undefined {
    return this.db.prepare(`SELECT * FROM chat_conversations WHERE id = ?`).get(id) as
      | ChatConversationRow
      | undefined;
  }

  /**
   * The conversation an operator is chatting in for this job: the newest one,
   * regardless of state — an errored conversation stays visible (banner) and
   * its next send resumes the same opencode session.
   */
  activeConversationForJob(jobId: number): ChatConversationRow | undefined {
    return this.db
      .prepare(`SELECT * FROM chat_conversations WHERE job_id = ? ORDER BY id DESC LIMIT 1`)
      .get(jobId) as ChatConversationRow | undefined;
  }

  /** Creates the conversation, or returns the newest existing one (double-submit safe). */
  getOrCreateConversation(jobId: number, createdBy: string | null): ChatConversationRow {
    return this.db.transaction(() => {
      const existing = this.activeConversationForJob(jobId);
      if (existing) return existing;
      return this.createConversation(jobId, createdBy);
    })();
  }

  /** Marks every active conversation of a job superseded by an explicit reset. */
  supersedeActive(jobId: number): void {
    this.db
      .prepare(
        `UPDATE chat_conversations SET state = 'reset', updated_at = ? WHERE job_id = ? AND state = 'active'`,
      )
      .run(nowIso(), jobId);
  }

  listMessages(conversationId: number): ChatMessageRow[] {
    return this.db
      .prepare(`SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY id ASC`)
      .all(conversationId) as ChatMessageRow[];
  }

  appendMessage(input: {
    conversationId: number;
    role: "user" | "assistant";
    content: string;
    cost?: number | null;
    totalTokens?: number | null;
    durationMs?: number | null;
  }): ChatMessageRow {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO chat_messages (conversation_id, role, content, cost, total_tokens, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.conversationId,
        input.role,
        input.content,
        input.cost ?? null,
        input.totalTokens ?? null,
        input.durationMs ?? null,
        now,
      );
    this.db
      .prepare(
        `UPDATE chat_conversations
         SET message_count = message_count + 1,
             cost = COALESCE(cost, 0) + COALESCE(?, 0),
             total_tokens = COALESCE(total_tokens, 0) + COALESCE(?, 0),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(input.cost ?? null, input.totalTokens ?? null, now, input.conversationId);
    const id = (this.db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    const row = this.db.prepare(`SELECT * FROM chat_messages WHERE id = ?`).get(id) as ChatMessageRow | undefined;
    if (!row) throw new Error("failed to append chat message");
    return row;
  }

  bindSession(conversationId: number, sessionId: string, workspacePath: string): void {
    this.db
      .prepare(
        `UPDATE chat_conversations SET opencode_session_id = ?, workspace_path = ?, updated_at = ? WHERE id = ?`,
      )
      .run(sessionId, workspacePath, nowIso(), conversationId);
  }

  setWorkspace(conversationId: number, workspacePath: string): void {
    this.db
      .prepare(`UPDATE chat_conversations SET workspace_path = ?, updated_at = ? WHERE id = ?`)
      .run(workspacePath, nowIso(), conversationId);
  }

  setError(conversationId: number, message: string): void {
    this.db
      .prepare(`UPDATE chat_conversations SET state = 'error', last_error = ?, updated_at = ? WHERE id = ?`)
      .run(message.slice(0, 500), nowIso(), conversationId);
  }

  /** A later successful send recovers the conversation; the banner clears. */
  clearError(conversationId: number): void {
    this.db
      .prepare(`UPDATE chat_conversations SET state = 'active', last_error = NULL, updated_at = ? WHERE id = ?`)
      .run(nowIso(), conversationId);
  }

  /** Budget check inputs: message count and accumulated cost for one conversation. */
  usage(conversationId: number): { messages: number; cost: number } {
    const row = this.db
      .prepare(`SELECT message_count AS messages, COALESCE(cost, 0) AS cost FROM chat_conversations WHERE id = ?`)
      .get(conversationId) as { messages: number; cost: number } | undefined;
    return row ?? { messages: 0, cost: 0 };
  }
}
