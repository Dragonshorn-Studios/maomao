/**
 * Forge connections: persisted, per-instance credentials and policy (issue
 * #18 slice 2). One row per GitLab.com account or self-managed instance
 * scope; the webhook URL carries the connection id so routing never relies
 * on process-wide env vars. Tokens are sealed at rest with secretbox and
 * never logged or rendered.
 */
import { randomUUID } from "node:crypto";
import type { SqliteDb } from "../db.js";
import { nowIso } from "../util.js";
import { canonicalizeInstanceUrl, type CanonicalInstance } from "./safe-http.js";
import { openSecret, sealSecret, secretFingerprint } from "./secretbox.js";

export type ForgeConnectionProvider = "gitlab";
export type GitLabTokenType = "project" | "group" | "pat";

export interface ForgeConnectionRow {
  id: string;
  provider: string;
  label: string;
  instance_base_url: string;
  api_base_url: string;
  token_sealed: string;
  token_fingerprint: string;
  token_type: GitLabTokenType;
  scope_type: "instance" | "group" | "project";
  scope_path: string;
  webhook_secret_sealed: string;
  ca_pem: string | null;
  allow_private_network: number;
  allow_insecure_http: number;
  allow_approve: number;
  enabled: number;
  bot_user_id: number | null;
  bot_username: string | null;
  token_scopes_json: string | null;
  version_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface ForgeConnectionInput {
  provider: "gitlab";
  label: string;
  instanceUrl: string;
  token: string;
  tokenType: GitLabTokenType;
  scopeType: "instance" | "group" | "project";
  scopePath: string;
  webhookSecret: string;
  caPem?: string;
  allowPrivateNetwork: boolean;
  allowInsecureHttp: boolean;
  allowApprove: boolean;
}

/** A connection with its secrets unsealed — short-lived, never persisted or rendered. */
export interface OpenedConnection {
  row: ForgeConnectionRow;
  instance: CanonicalInstance;
  token: string;
  webhookSecret: string;
}

export class ForgeConnectionStore {
  constructor(
    private readonly db: SqliteDb,
    private readonly key: Buffer,
  ) {}

  list(provider?: string): ForgeConnectionRow[] {
    if (provider) {
      return this.db
        .prepare(`SELECT * FROM forge_connections WHERE provider = ? ORDER BY created_at ASC, id ASC`)
        .all(provider) as ForgeConnectionRow[];
    }
    return this.db.prepare(`SELECT * FROM forge_connections ORDER BY created_at ASC, id ASC`).all() as ForgeConnectionRow[];
  }

  get(id: string): ForgeConnectionRow | undefined {
    return this.db.prepare(`SELECT * FROM forge_connections WHERE id = ?`).get(id) as ForgeConnectionRow | undefined;
  }

  /** Resolves a connection and unseals its secrets for use. */
  open(id: string): OpenedConnection {
    const row = this.get(id);
    if (!row) throw new Error(`forge connection ${id} does not exist`);
    const instance = canonicalizeInstanceUrl(row.instance_base_url, {
      allowInsecureHttp: row.allow_insecure_http === 1,
    });
    return {
      row,
      instance,
      token: openSecret(this.key, row.token_sealed),
      webhookSecret: openSecret(this.key, row.webhook_secret_sealed),
    };
  }

  create(input: ForgeConnectionInput): ForgeConnectionRow {
    if (input.provider !== "gitlab") {
      throw new Error(`unsupported forge provider: ${input.provider}`);
    }
    if (!input.token || input.token.length < 8) {
      throw new Error("an access token of at least 8 characters is required");
    }
    const instance = canonicalizeInstanceUrl(input.instanceUrl, {
      allowInsecureHttp: input.allowInsecureHttp,
    });
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO forge_connections (
          id, provider, label, instance_base_url, api_base_url,
          token_sealed, token_fingerprint, token_type, scope_type, scope_path,
          webhook_secret_sealed, ca_pem, allow_private_network, allow_insecure_http,
          allow_approve, enabled, created_at, updated_at
        ) VALUES (?, 'gitlab', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        input.label.trim(),
        instance.origin,
        instance.apiBaseUrl,
        sealSecret(this.key, input.token),
        secretFingerprint(input.token),
        input.tokenType,
        input.scopeType,
        input.scopePath.trim(),
        sealSecret(this.key, input.webhookSecret),
        input.caPem?.trim() || null,
        input.allowPrivateNetwork ? 1 : 0,
        input.allowInsecureHttp ? 1 : 0,
        input.allowApprove ? 1 : 0,
        now,
        now,
      );
    const row = this.get(id);
    if (!row) throw new Error("failed to load created forge connection");
    return row;
  }

  update(id: string, patch: Partial<Omit<ForgeConnectionInput, "provider">> & { enabled?: boolean }): void {
    const row = this.get(id);
    if (!row) throw new Error(`forge connection ${id} does not exist`);
    const assignments: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.label != null) set("label", patch.label.trim());
    if (patch.token != null && patch.token !== "") {
      set("token_sealed", sealSecret(this.key, patch.token));
      set("token_fingerprint", secretFingerprint(patch.token));
    }
    if (patch.webhookSecret != null && patch.webhookSecret !== "") {
      set("webhook_secret_sealed", sealSecret(this.key, patch.webhookSecret));
    }
    if (patch.tokenType != null) set("token_type", patch.tokenType);
    if (patch.scopeType != null) set("scope_type", patch.scopeType);
    if (patch.scopePath != null) set("scope_path", patch.scopePath.trim());
    if (patch.caPem !== undefined) set("ca_pem", patch.caPem?.trim() || null);
    if (patch.allowPrivateNetwork != null) set("allow_private_network", patch.allowPrivateNetwork ? 1 : 0);
    if (patch.allowApprove != null) set("allow_approve", patch.allowApprove ? 1 : 0);
    if (patch.enabled != null) set("enabled", patch.enabled ? 1 : 0);
    if (assignments.length === 0) return;
    set("updated_at", nowIso());
    this.db.prepare(`UPDATE forge_connections SET ${assignments.join(", ")} WHERE id = ?`).run(...values, id);
  }

  /** Stores the probe results (bot identity, token scopes, instance version). */
  recordProbe(id: string, probe: { botUserId?: number; botUsername?: string; scopes?: string[]; version?: string }): void {
    const row = this.get(id);
    if (!row) return;
    this.db
      .prepare(
        `UPDATE forge_connections SET bot_user_id = ?, bot_username = ?, token_scopes_json = ?, version_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        probe.botUserId ?? row.bot_user_id,
        probe.botUsername ?? row.bot_username,
        probe.scopes ? JSON.stringify(probe.scopes) : row.token_scopes_json,
        probe.version ? JSON.stringify(probe.version) : row.version_json,
        nowIso(),
        id,
      );
  }

  delete(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM forge_connections WHERE id = ?`).run(id);
    return (result as { changes?: number }).changes != null && (result as { changes: number }).changes > 0;
  }
}
