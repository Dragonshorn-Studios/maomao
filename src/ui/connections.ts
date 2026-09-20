/**
 * Forge-connections operator page (issue #18 slice 2, #86 UX). Server-rendered
 * like the config pages: no JS beyond the shared layout script. Secrets are
 * never rendered — only the connection id, instance hostname, token type, and
 * the non-reversible last-4 fingerprint.
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

function flagChip(label: string, on: boolean): string {
  return `<span class="state ${on ? "state-completed" : "state-queued"}">${escapeHtml(label)} ${on ? "on" : "off"}</span>`;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function providerLabel(row: ForgeConnectionView): string {
  const host = hostnameOf(row.instance_base_url);
  const name = row.provider === "gitlab" ? "GitLab" : row.provider;
  return host && host !== "gitlab.com" ? `${name} · ${host}` : name;
}

function connectionCard(row: ForgeConnectionView, csrfToken?: string): string {
  const csrf = csrfInput(csrfToken);
  const enabled = row.enabled === 1;
  const scopes = parseScopes(row.token_scopes_json);
  const version = parseVersion(row.version_json);
  const probed = Boolean(row.bot_username);
  const title = row.label || row.scope_path || row.instance_base_url;
  const identity = row.bot_username
    ? `${escapeHtml(row.bot_username)}${row.bot_user_id != null ? ` (${escapeHtml(String(row.bot_user_id))})` : ""}`
    : '<span class="muted">not probed</span>';
  return `
  <article class="card connection-card" data-connection="${escapeHtml(row.id)}">
    <header class="connection-head">
      <div>
        <p class="label">${escapeHtml(providerLabel(row))}</p>
        <h3 class="specimen-title">${escapeHtml(title)}</h3>
      </div>
      <div class="connection-chips">
        <span class="state ${enabled ? "state-completed" : "state-cancelled"}">${enabled ? "Enabled" : "Disabled"}</span>
        <span class="state ${probed ? "state-completed" : "state-queued"}">${probed ? "Probed" : "Not probed"}</span>
      </div>
    </header>
    <dl class="meta-grid">
      <div>
        <dt>Connection</dt>
        <dd><code>${escapeHtml(row.id)}</code></dd>
      </div>
      <div>
        <dt>Token</dt>
        <dd>${escapeHtml(row.token_type)} ···${escapeHtml(row.token_fingerprint)}</dd>
      </div>
      <div>
        <dt>Scope</dt>
        <dd>${escapeHtml(row.scope_type)}${row.scope_path ? ` · <code>${escapeHtml(row.scope_path)}</code>` : ""}</dd>
      </div>
      <div>
        <dt>Bot</dt>
        <dd>${identity}</dd>
      </div>
      ${version ? `<div><dt>Version</dt><dd>${escapeHtml(version)}</dd></div>` : ""}
      ${scopes ? `<div><dt>Token scopes</dt><dd>${escapeHtml(scopes.join(", "))}</dd></div>` : ""}
      <div>
        <dt>Webhook</dt>
        <dd><code>POST /webhooks/gitlab/${escapeHtml(row.id)}</code></dd>
      </div>
    </dl>
    <div class="connection-flags">${flagChip("Private network", Boolean(row.allow_private_network))} ${flagChip("Plain HTTP", Boolean(row.allow_insecure_http))} ${flagChip("Approval", Boolean(row.allow_approve))}</div>
    <div class="connection-actions">
      <form method="post" action="/connections/${escapeHtml(row.id)}/probe">${csrf}<button type="submit" class="btn">Probe now</button></form>
      <form method="post" action="/connections/${escapeHtml(row.id)}/toggle">${csrf}<button type="submit" class="btn-secondary">${enabled ? "Disable" : "Enable"}</button></form>
      <form method="post" action="/connections/${escapeHtml(row.id)}/delete">${csrf}<button type="submit" class="btn-danger">Delete</button></form>
    </div>
  </article>`;
}

export function renderConnectionsPage(data: ConnectionsPageData): string {
  const csrf = csrfInput(data.csrfToken);
  const list = data.connections.length
    ? `<ul class="queue connection-list">${data.connections.map((row) => `<li>${connectionCard(row, data.csrfToken)}</li>`).join("")}</ul>`
    : `<div class="empty" role="status">
        <p><strong>No forge connections yet.</strong></p>
        <p class="muted">Maomao reviews GitHub through the environment-configured GitHub App. Add a GitLab connection below to review merge requests on that instance.</p>
      </div>`;
  const body = `
  <section>
    <h1>Forge connections</h1>
    <p class="lede">Each connection carries its own base URL, credentials, webhook secret, and policy. Review jobs are isolated per connection. Secrets are stored sealed and never shown here — only the last-four fingerprint.</p>
    ${data.options.notice ? `<p class="notice" role="status">${escapeHtml(data.options.notice)}</p>` : ""}
    ${data.options.error ? `<p class="error" role="alert">${escapeHtml(data.options.error)}</p>` : ""}
    ${list}
  </section>
  <section class="connection-create">
    <h2>Add a GitLab connection</h2>
    <form method="post" action="/connections" class="operator-form">
      ${csrf}
      <fieldset>
        <legend>Identity</legend>
        <p><label>Label <input name="label" placeholder="acme-gitlab" required/></label></p>
        <p><label>Instance URL <input name="instanceUrl" placeholder="https://gitlab.com" required/></label></p>
      </fieldset>
      <fieldset>
        <legend>Credentials</legend>
        <p><label>Access token <input name="token" type="password" required autocomplete="off"/> <span class="muted">project or group access token preferred; needs api + read_repository</span></label></p>
        <p><label>Token type
          <select name="tokenType">
            <option value="project">project access token</option>
            <option value="group">group access token</option>
            <option value="pat">service account PAT</option>
          </select></label></p>
        <p><label>Webhook secret <input name="webhookSecret" type="password" required autocomplete="off"/></label></p>
      </fieldset>
      <fieldset>
        <legend>Scope</legend>
        <p><label>Scope
          <select name="scopeType">
            <option value="instance">whole instance</option>
            <option value="group">one group</option>
            <option value="project">one project</option>
          </select></label>
          <label>Group/project path <input name="scopePath" placeholder="acme/widgets"/></label></p>
        <p><label>Custom CA bundle (PEM, optional) <textarea name="caPem" rows="4"></textarea></label></p>
      </fieldset>
      <fieldset>
        <legend>Policy</legend>
        <p><label><input type="checkbox" name="allowPrivateNetwork" value="1"/> allow private-network addresses (self-managed hosts)</label></p>
        <p><label><input type="checkbox" name="allowInsecureHttp" value="1"/> allow plain HTTP (discouraged)</label></p>
        <p><label><input type="checkbox" name="allowApprove" value="1"/> allow approval verdicts on clean reviews</label></p>
      </fieldset>
      <p><button type="submit" class="btn">Create connection</button></p>
    </form>
  </section>`;
  return layout("Forge connections", body, { ...data.options, surface: "operator" });
}
