/**
 * Forge-connections operator page (issue #18 slice 2). Server-rendered like
 * the config pages: no JS beyond the shared layout script. Secrets are never
 * rendered — only the connection id, instance hostname, token type, and the
 * non-reversible last-4 fingerprint.
 */
import { escapeHtml } from "../util.js";
import { csrfInput, layout, type PageOptions } from "./layout.js";
import type { ForgeConnectionView } from "../forge/connections.js";
import { safeJsonParse } from "../util.js";

export interface ConnectionsPageData {
  connections: ForgeConnectionView[];
  csrfToken?: string;
  options: PageOptions;
}

function parseScopes(raw: string | null): string[] | undefined {
  const parsed = safeJsonParse(raw ?? "");
  return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? (parsed as string[]) : undefined;
}

function parseVersion(raw: string | null): string | undefined {
  const parsed = safeJsonParse(raw ?? "");
  return typeof parsed === "string" ? parsed : undefined;
}

function flag(value: number | undefined): string {
  return value ? "yes" : "no";
}

function connectionCard(row: ForgeConnectionView, csrfToken?: string): string {
  const csrf = csrfInput(csrfToken);
  const enabled = row.enabled === 1;
  const scopes = parseScopes(row.token_scopes_json);
  const version = parseVersion(row.version_json);
  const identity = row.bot_username
    ? `${escapeHtml(row.bot_username)}${row.bot_user_id != null ? ` (${escapeHtml(String(row.bot_user_id))})` : ""}`
    : '<span class="muted">not probed</span>';
  return `
  <article class="specimen" data-connection="${escapeHtml(row.id)}">
    <p class="specimen-title">[GitLab · ${escapeHtml(new URL(row.instance_base_url).hostname)}] ${escapeHtml(row.label || row.scope_path || row.instance_base_url)} ${enabled ? "" : '<span class="muted">(disabled)</span>'}</p>
    <div class="meta-row">
      <span class="pair">Connection <strong><code>${escapeHtml(row.id)}</code></strong></span>
      <span class="pair">Token <strong>${escapeHtml(row.token_type)}</strong> ···${escapeHtml(row.token_fingerprint)}</span>
      <span class="pair">Scope <strong>${escapeHtml(row.scope_type)}</strong>${row.scope_path ? ` <code>${escapeHtml(row.scope_path)}</code>` : ""}</span>
      <span class="pair">Bot <strong>${identity}</strong></span>
      ${version ? `<span class="pair">Version <strong>${escapeHtml(version)}</strong></span>` : ""}
      ${scopes ? `<span class="pair">Scopes <strong>${escapeHtml((scopes as string[]).join(", "))}</strong></span>` : ""}
      <span class="pair">Private network <strong>${flag(row.allow_private_network)}</strong></span>
      <span class="pair">Plain HTTP <strong>${flag(row.allow_insecure_http)}</strong></span>
      <span class="pair">Approval <strong>${flag(row.allow_approve)}</strong></span>
    </div>
    <div class="meta-row"><span class="pair">Webhook URL <strong><code>POST /webhooks/gitlab/${escapeHtml(row.id)}</code></strong></span></div>
    <div class="actions">
      <form method="post" action="/connections/${escapeHtml(row.id)}/probe">${csrf}<button type="submit">Probe now</button></form>
      <form method="post" action="/connections/${escapeHtml(row.id)}/toggle">${csrf}<button type="submit">${enabled ? "Disable" : "Enable"}</button></form>
      <form method="post" action="/connections/${escapeHtml(row.id)}/delete">${csrf}<button type="submit">Delete</button></form>
    </div>
  </article>`;
}

export function renderConnectionsPage(data: ConnectionsPageData): string {
  const csrf = csrfInput(data.csrfToken);
  const list = data.connections.length
    ? `<ul class="queue">${data.connections.map((row) => `<li>${connectionCard(row, data.csrfToken)}</li>`).join("")}</ul>`
    : '<p class="muted">No forge connections configured. Maomao reviews GitHub through the environment-configured GitHub App; add a GitLab connection below to review merge requests.</p>';
  const body = `
  <section>
    <p class="lede">Forge connections. Each connection carries its own base URL, credentials, webhook secret, and policy; review jobs are isolated per connection.</p>
    ${data.options.notice ? `<p class="notice">${escapeHtml(data.options.notice)}</p>` : ""}
    ${data.options.error ? `<p class="error">${escapeHtml(data.options.error)}</p>` : ""}
    ${list}
  </section>
  <section>
    <h2>Add a GitLab connection</h2>
    <form method="post" action="/connections">
      ${csrf}
      <p><label>Label <input name="label" placeholder="acme-gitlab" required/></label></p>
      <p><label>Instance URL <input name="instanceUrl" placeholder="https://gitlab.com" required/></label></p>
      <p><label>Access token <input name="token" type="password" required/> <span class="muted">project or group access token preferred; needs api + read_repository</span></label></p>
      <p><label>Token type
        <select name="tokenType">
          <option value="project">project access token</option>
          <option value="group">group access token</option>
          <option value="pat">service account PAT</option>
        </select></label></p>
      <p><label>Scope
        <select name="scopeType">
          <option value="instance">whole instance</option>
          <option value="group">one group</option>
          <option value="project">one project</option>
        </select></label>
        <label>Group/project path <input name="scopePath" placeholder="acme/widgets"/></label></p>
      <p><label>Webhook secret <input name="webhookSecret" type="password" required/></label></p>
      <p><label>Custom CA bundle (PEM, optional) <textarea name="caPem" rows="4"></textarea></label></p>
      <p><label><input type="checkbox" name="allowPrivateNetwork" value="1"/> allow private-network addresses (self-managed hosts)</label></p>
      <p><label><input type="checkbox" name="allowInsecureHttp" value="1"/> allow plain HTTP (discouraged)</label></p>
      <p><label><input type="checkbox" name="allowApprove" value="1"/> allow approval verdicts on clean reviews</label></p>
      <p><button type="submit">Create connection</button></p>
    </form>
  </section>`;
  return layout("Forge connections", body, data.options);
}
