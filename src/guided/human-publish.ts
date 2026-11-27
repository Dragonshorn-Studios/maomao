import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { SqliteDb } from "../db.js";
import { nowIso } from "../util.js";
import type { GuidedPublishPreview } from "./publish-preview.js";
import type { GuidedActor } from "./store.js";

const HUMAN_PUBLISH_TIMEOUT_MS = 10_000;
export const HUMAN_PUBLISH_PENDING_LEASE_MS = 120_000;

interface CredentialRow {
  id: number;
  actor_provider: string;
  actor_id: string;
  provider: string;
  provider_instance: string;
  token_encrypted: string;
  scope: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface HumanCredentialStatus {
  state: "ready" | "missing" | "expired" | "revoked";
  scope?: string;
  expiresAt?: string | null;
  updatedAt?: string;
}

export interface HumanPublicationRow {
  id: number;
  session_id: number;
  status: "pending" | "published" | "failed" | "uncertain";
  review_id: number | null;
  html_url: string | null;
  error_code: string | null;
  payload_hash: string;
  created_at: string;
  updated_at: string;
}

function keyFor(secret: string): Buffer {
  return createHash("sha256").update(`maomao guided human credential\0${secret}`).digest();
}

function encryptToken(secret: string, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function decryptToken(secret: string, encoded: string): string | undefined {
  const parts = encoded.split(".").map((part) => Buffer.from(part, "base64url"));
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), parts[0]);
    decipher.setAuthTag(parts[1]);
    return Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

function expired(row: CredentialRow, now = new Date()): boolean {
  return Boolean(row.expires_at && Date.parse(row.expires_at) <= now.getTime());
}

export class GuidedHumanPublishStore {
  constructor(private readonly db: SqliteDb, private readonly secret: string) {}

  saveCredential(actor: GuidedActor, token: string, scope: string, expiresAt?: string | null): void {
    if (!token) throw new Error("human credential token is empty");
    const now = nowIso();
    this.db.prepare(`INSERT INTO guided_human_credentials
      (actor_provider, actor_id, provider, provider_instance, token_encrypted, scope, expires_at, created_at, updated_at)
      VALUES (?, ?, 'github', 'github.com', ?, ?, ?, ?, ?)
      ON CONFLICT(actor_provider, actor_id, provider, provider_instance) DO UPDATE SET
        token_encrypted = excluded.token_encrypted,
        scope = excluded.scope,
        expires_at = excluded.expires_at,
        revoked_at = NULL,
        updated_at = excluded.updated_at`)
      .run(actor.actorProvider, actor.actorId, encryptToken(this.secret, token), scope, expiresAt ?? null, now, now);
    this.audit(actor, null, "credential_saved", `scope=${scope}`);
  }

  credentialStatus(actor: GuidedActor): HumanCredentialStatus {
    const row = this.credentialRow(actor);
    if (!row) return { state: "missing" };
    if (row.revoked_at) return { state: "revoked", scope: row.scope, updatedAt: row.updated_at };
    if (expired(row)) return { state: "expired", scope: row.scope, expiresAt: row.expires_at, updatedAt: row.updated_at };
    return { state: "ready", scope: row.scope, expiresAt: row.expires_at, updatedAt: row.updated_at };
  }

  accessToken(actor: GuidedActor): string | undefined {
    const row = this.credentialRow(actor);
    if (!row || row.revoked_at || expired(row)) return undefined;
    const token = decryptToken(this.secret, row.token_encrypted);
    if (token) this.db.prepare(`UPDATE guided_human_credentials SET last_used_at = ? WHERE id = ?`).run(nowIso(), row.id);
    return token;
  }

  revokeCredential(actor: GuidedActor): void {
    this.db.prepare(`UPDATE guided_human_credentials SET revoked_at = ?, updated_at = ?
      WHERE actor_provider = ? AND actor_id = ? AND provider = 'github' AND provider_instance = 'github.com'`)
      .run(nowIso(), nowIso(), actor.actorProvider, actor.actorId);
    this.audit(actor, null, "credential_revoked", null);
  }

  audit(actor: GuidedActor, sessionId: number | null, action: string, detail: string | null): void {
    this.db.prepare(`INSERT INTO guided_human_publish_events (actor_provider, actor_id, session_id, action, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(actor.actorProvider, actor.actorId, sessionId, action, detail, nowIso());
  }

  publicationForSession(sessionId: number): HumanPublicationRow | undefined {
    return this.db.prepare(`SELECT * FROM guided_human_publications WHERE session_id = ?`).get(sessionId) as HumanPublicationRow | undefined;
  }

  reservePublication(input: {
    sessionId: number;
    actor: GuidedActor;
    repoFullName: string;
    prNumber: number;
    headSha: string;
    event: string;
    payloadHash: string;
  }): { row: HumanPublicationRow; created: boolean } {
    const existing = this.publicationForSession(input.sessionId);
    if (existing) return { row: existing, created: false };
    const now = nowIso();
    this.db.prepare(`INSERT INTO guided_human_publications
      (session_id, actor_provider, actor_id, provider, provider_instance, repo_full_name, pr_number, head_sha, event, payload_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, 'github', 'github.com', ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(input.sessionId, input.actor.actorProvider, input.actor.actorId, input.repoFullName, input.prNumber, input.headSha, input.event, input.payloadHash, now, now);
    const row = this.publicationForSession(input.sessionId);
    if (!row) throw new Error("human publication reservation did not persist");
    return { row, created: true };
  }

  reopenPublication(id: number, event: string, payloadHash: string, options: { stalePendingBefore?: string } = {}): boolean {
    const changed = this.db.prepare(`UPDATE guided_human_publications SET event = ?, payload_hash = ?, status = 'pending', error_code = NULL, updated_at = ?
      WHERE id = ? AND (status IN ('failed', 'uncertain') OR (status = 'pending' AND updated_at < ?))`)
      .run(event, payloadHash, nowIso(), id, options.stalePendingBefore ?? "");
    return changed.changes > 0;
  }

  finishPublication(id: number, status: HumanPublicationRow["status"], patch: { reviewId?: number | null; htmlUrl?: string | null; errorCode?: string | null }): void {
    this.db.prepare(`UPDATE guided_human_publications SET status = ?, review_id = COALESCE(?, review_id), html_url = COALESCE(?, html_url), error_code = ?, updated_at = ? WHERE id = ?`)
      .run(status, patch.reviewId ?? null, patch.htmlUrl ?? null, patch.errorCode ?? null, nowIso(), id);
  }

  private credentialRow(actor: GuidedActor): CredentialRow | undefined {
    return this.db.prepare(`SELECT * FROM guided_human_credentials
      WHERE actor_provider = ? AND actor_id = ? AND provider = 'github' AND provider_instance = 'github.com'`)
      .get(actor.actorProvider, actor.actorId) as CredentialRow | undefined;
  }
}

export function guidedHumanPublishMarker(sessionId: number): string {
  return `<!-- maomao-guided-human-publish:${sessionId} -->`;
}

export function guidedHumanPayloadHash(preview: GuidedPublishPreview): string {
  return createHash("sha256").update(JSON.stringify({ event: preview.event, body: preview.body, comments: preview.comments, headSha: preview.target.headSha })).digest("hex");
}

interface GithubApiResult {
  ok: boolean;
  status: number;
  body: unknown;
}

async function githubApi(fetchImpl: typeof fetch, token: string, method: string, path: string, body?: unknown): Promise<GithubApiResult> {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "maomao-guided-human-publish",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(HUMAN_PUBLISH_TIMEOUT_MS),
  });
  const text = await response.text();
  let parsed: unknown = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { message: text.slice(0, 300) }; }
  return { ok: response.ok, status: response.status, body: parsed };
}

function messageOf(body: unknown): string {
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string") return body.message.slice(0, 300);
  return "GitHub rejected the human review submission";
}

async function findMarkerReview(fetchImpl: typeof fetch, token: string, owner: string, repo: string, prNumber: number, actorId: string, marker: string, expectedBody: string): Promise<{ id: number; htmlUrl?: string } | undefined> {
  for (let page = 1; ; page += 1) {
    const result = await githubApi(fetchImpl, token, "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/reviews?per_page=100&page=${page}`);
    if (!result.ok || !Array.isArray(result.body)) return undefined;
    for (const review of result.body) {
      if (!review || typeof review !== "object") continue;
      const row = review as { id?: unknown; body?: unknown; html_url?: unknown; user?: { id?: unknown } };
      if (String(row.user?.id ?? "") !== actorId || row.body !== expectedBody || !row.body.includes(marker)) continue;
      if (typeof row.id === "number") return { id: row.id, htmlUrl: typeof row.html_url === "string" ? row.html_url : undefined };
    }
    if (result.body.length < 100) return undefined;
  }
}

export async function submitHumanGitHubReview(input: {
  fetchImpl?: typeof fetch;
  token: string;
  actorId: string;
  sessionId: number;
  repoFullName: string;
  prNumber: number;
  preview: GuidedPublishPreview;
}): Promise<
  | { status: "published"; reviewId: number; htmlUrl?: string }
  | { status: "duplicate"; reviewId: number; htmlUrl?: string }
  | { status: "failed"; errorCode: string; message: string }
  | { status: "uncertain"; errorCode: string; message: string }
> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const [owner, repo] = input.repoFullName.split("/");
  const wrappedMarker = guidedHumanPublishMarker(input.sessionId);
  const failure = (errorCode: string, message: string) => ({ status: "failed" as const, errorCode, message });
  let user: { id?: unknown; login?: unknown };
  try {
    const userResult = await githubApi(fetchImpl, input.token, "GET", "/user");
    if (!userResult.ok) return failure(userResult.status === 401 || userResult.status === 403 ? "credential_rejected" : `github_${userResult.status}`, "GitHub rejected the stored human credential; reconnect publication authorization.");
    user = userResult.body as { id?: unknown; login?: unknown };
  } catch {
    return { status: "uncertain", errorCode: "identity_timeout", message: "Could not verify the human identity before submission; no review write was attempted." };
  }
  if (String(user.id ?? "") !== input.actorId) return failure("actor_mismatch", "The stored GitHub credential belongs to a different account; reconnect publication authorization.");

  let pull: { head?: { sha?: unknown }; state?: unknown };
  try {
    const pullResult = await githubApi(fetchImpl, input.token, "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${input.prNumber}`);
    if (pullResult.status === 404 || pullResult.status === 403) return failure("repository_access_denied", "The human account cannot access this repository or pull request with the granted credential.");
    if (!pullResult.ok) return failure(`github_${pullResult.status}`, messageOf(pullResult.body));
    pull = pullResult.body as { head?: { sha?: unknown }; state?: unknown };
  } catch {
    return { status: "uncertain", errorCode: "pull_timeout", message: "Could not verify the current pull head before submission; no review write was attempted." };
  }
  if (pull.state !== "open") return failure("pull_not_open", "The pull request is no longer open.");
  if (pull.head?.sha !== input.preview.target.headSha) return failure("head_changed", "The pull request head changed since this SHA-pinned draft; publication was rejected.");

  try {
    const existing = await findMarkerReview(fetchImpl, input.token, owner, repo, input.prNumber, input.actorId, wrappedMarker, input.preview.body);
    if (existing) return { status: "duplicate", reviewId: existing.id, htmlUrl: existing.htmlUrl };
  } catch {
    // A failed duplicate check must not block the first deliberate write; the post-failure recovery check runs again.
  }

  const payload = {
    commit_id: input.preview.target.headSha,
    event: input.preview.event,
    body: input.preview.body,
    comments: input.preview.comments.map((comment) => ({ path: comment.path, side: comment.side, line: comment.line, body: comment.body })),
  };
  try {
    const result = await githubApi(fetchImpl, input.token, "POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${input.prNumber}/reviews`, payload);
    const body = result.body as { id?: unknown; html_url?: unknown };
    if (result.ok && typeof body.id === "number") return { status: "published", reviewId: body.id, htmlUrl: typeof body.html_url === "string" ? body.html_url : undefined };
    const code = result.status === 422 ? "inline_coordinates_rejected" : result.status === 401 || result.status === 403 ? "permission_denied" : `github_${result.status}`;
    return failure(code, result.status === 422 ? `GitHub rejected the inline review coordinates: ${messageOf(result.body)}` : messageOf(result.body));
  } catch (error) {
    try {
      const recovered = await findMarkerReview(fetchImpl, input.token, owner, repo, input.prNumber, input.actorId, wrappedMarker, input.preview.body);
      if (recovered) return { status: "published", reviewId: recovered.id, htmlUrl: recovered.htmlUrl };
    } catch {
      // Keep the original timeout classification below.
    }
    return { status: "uncertain", errorCode: "submission_timeout", message: `The review submission timed out or the connection failed; no duplicate was found. Retry only after GitHub is checked. ${error instanceof Error ? error.message.slice(0, 120) : ""}`.trim() };
  }
}
