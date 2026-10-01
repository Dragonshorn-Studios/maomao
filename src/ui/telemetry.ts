import { escapeHtml } from "../util.js";
import { csrfInput, layout, type PageOptions } from "./layout.js";
import { configSubNav } from "./pages.js";
import {
  TELEMETRY_CHANNELS,
  type TelemetryChannelStatus,
  type TelemetrySharedStatus,
} from "../telemetry/settings.js";

/**
 * OpenObserve connection page (/config/telemetry): a shared-connection card
 * (one base URL like https://host/api/<org> + credentials + logs stream that
 * all three channels inherit), per-channel status with source badges (env
 * var / stored / none) and override forms, a "Test connection" probe against
 * the effective config, and a scratch form to probe ad-hoc values before
 * committing them. Secrets are never rendered — stored values show a last-4
 * fingerprint, env values show the var name.
 */

export interface TelemetryPageData {
  channels: TelemetryChannelStatus[];
  shared: TelemetrySharedStatus;
  csrfToken?: string;
  canWrite: boolean;
  options: PageOptions;
}

function sourceLabel(source: TelemetryChannelStatus["urlSource"] | TelemetryChannelStatus["authSource"]): string {
  if (source === "environment") return "environment";
  if (source === "stored") return "stored";
  return "none";
}

function urlBadge(channel: TelemetryChannelStatus): string {
  if (channel.urlSource === "environment") {
    return `<span class="state state-completed">url from env <code>${escapeHtml(channel.urlEnvVar ?? "")}</code></span>`;
  }
  if (channel.urlSource === "stored") {
    return `<span class="state state-completed">url stored${channel.urlShared ? " (shared)" : ""}</span>`;
  }
  return `<span class="state state-queued">no url</span>`;
}

function authBadge(channel: TelemetryChannelStatus): string {
  if (channel.authSource === "environment") {
    return `<span class="state state-completed">auth from env <code>${escapeHtml(channel.authEnvVar ?? "")}</code></span>`;
  }
  if (channel.authSource === "stored") {
    const via = channel.authShared ? " (shared)" : "";
    return `<span class="state state-completed">auth stored${via} ${escapeHtml(channel.authDetail ?? "")}</span>`;
  }
  return `<span class="state state-queued">no auth</span>`;
}

function sharedCard(shared: TelemetrySharedStatus, csrfToken: string | undefined, canWrite: boolean): string {
  const baseBadge =
    shared.baseUrlSource === "environment"
      ? `<span class="state state-completed">base url from env <code>${escapeHtml(shared.baseUrlEnvVar ?? "")}</code></span>`
      : shared.baseUrlSource === "stored"
        ? `<span class="state state-completed">base url stored</span>`
        : `<span class="state state-queued">no base url</span>`;
  const streamBadge =
    shared.streamSource === "environment"
      ? `<span class="state state-completed">stream from env <code>${escapeHtml(shared.streamEnvVar ?? "")}</code></span>`
      : shared.streamSource === "stored"
        ? `<span class="state state-completed">stream stored</span>`
        : `<span class="state state-queued">no logs stream</span>`;
  const authBadgeHtml =
    shared.authSource === "environment"
      ? `<span class="state state-completed">auth from env <code>${escapeHtml(shared.authEnvVar ?? "")}</code></span>`
      : shared.authSource === "stored"
        ? `<span class="state state-completed">auth stored ${escapeHtml(shared.authDetail ?? "")}</span>`
        : `<span class="state state-queued">no auth</span>`;
  const form = canWrite
    ? `<form method="post" action="/config/telemetry/shared" class="telemetry-form">
        ${csrfInput(csrfToken)}
        <div class="telemetry-grid">
          <label class="telemetry-field telemetry-field-wide">
            <span>Base URL</span>
            <input type="url" name="baseUrl" autocomplete="off"
              placeholder="${shared.baseUrl ? escapeHtml(shared.baseUrl) : "https://oo.example.com/api/default"}"
              aria-label="Shared OpenObserve base URL"/>
          </label>
          <label class="telemetry-field">
            <span>Logs stream</span>
            <input type="text" name="stream" autocomplete="off"
              placeholder="${shared.stream ? escapeHtml(shared.stream) : "job_summaries"}"
              aria-label="OpenObserve stream for job summaries"/>
          </label>
          <label class="telemetry-field">
            <span>Bearer token</span>
            <input type="password" name="token" autocomplete="off" minlength="4"
              placeholder="${shared.authSource === "stored" ? "Keep stored credential" : "OPENOBSERVE_TOKEN"}"
              aria-label="Shared bearer token"/>
          </label>
          <label class="telemetry-field">
            <span>User</span>
            <input type="text" name="user" autocomplete="off"
              placeholder="${shared.authSource === "stored" ? "Keep stored credential" : "OPENOBSERVE_USER"}"
              aria-label="Shared basic-auth user"/>
          </label>
          <label class="telemetry-field">
            <span>Password</span>
            <input type="password" name="password" autocomplete="off"
              placeholder="${shared.authSource === "stored" ? "Keep stored credential" : "OPENOBSERVE_PASSWORD"}"
              aria-label="Shared basic-auth password"/>
          </label>
        </div>
        <div class="telemetry-actions">
          <button type="submit" class="btn">Save</button>
          ${shared.hasStored ? `<button type="submit" formaction="/config/telemetry/shared/delete" formnovalidate class="btn-danger">Clear stored</button>` : ""}
        </div>
        <p class="muted">One OpenObserve org usually feeds all three channels — set the base here once; per-channel fields below are overrides. The logs channel also needs a stream name. Env counterparts: <code>OPENOBSERVE_BASE_URL</code>, <code>OPENOBSERVE_LOGS_STREAM</code>, <code>OPENOBSERVE_TOKEN</code>/<code>OPENOBSERVE_USER</code>/<code>OPENOBSERVE_PASSWORD</code> (auth env applies to traces/metrics only; logs takes <code>OPENOBSERVE_LOGS_*</code> or these stored credentials).</p>
      </form>`
    : "";
  return `<li class="card telemetry-card" data-channel="shared">
    <header class="connection-head">
      <div>
        <p class="label">shared</p>
        <h3 class="specimen-title">Shared connection</h3>
        <p class="muted">base URL + credentials all channels inherit</p>
      </div>
      <div class="connection-chips">${baseBadge} ${streamBadge} ${authBadgeHtml}</div>
    </header>
    ${shared.baseUrl ? `<p class="muted telemetry-url">Effective base: <code>${escapeHtml(shared.baseUrl)}</code>${shared.stream ? ` · stream <code>${escapeHtml(shared.stream)}</code>` : ""}</p>` : ""}
    ${form}
  </li>`;
}

function channelCard(channel: TelemetryChannelStatus, csrfToken: string | undefined, canWrite: boolean): string {
  const meta = TELEMETRY_CHANNELS.find((c) => c.id === channel.channel);
  const id = escapeHtml(channel.channel);
  // Badges describe effective sources; the clear action keys off the file so
  // a stored config fully shadowed by env stays removable.
  const hasStored = channel.hasStored;
  const hasConfig = channel.url != null;
  const form = canWrite
    ? `<form method="post" action="/config/telemetry/${id}" class="telemetry-form">
        ${csrfInput(csrfToken)}
        <div class="telemetry-grid">
          <label class="telemetry-field telemetry-field-wide">
            <span>Endpoint URL</span>
            <input type="url" name="url" autocomplete="off"
              placeholder="${channel.url ? escapeHtml(channel.url) : "inherit shared base + /v1/…"}"
              aria-label="Endpoint URL for ${id}"/>
          </label>
          <label class="telemetry-field">
            <span>Bearer token</span>
            <input type="password" name="token" autocomplete="off" minlength="4"
              placeholder="${channel.authSource === "stored" ? "Keep stored credential" : "OPENOBSERVE_*_TOKEN"}"
              aria-label="Bearer token for ${id}"/>
          </label>
          <label class="telemetry-field">
            <span>User</span>
            <input type="text" name="user" autocomplete="off"
              placeholder="${channel.authSource === "stored" ? "Keep stored credential" : "OPENOBSERVE_*_USER"}"
              aria-label="Basic-auth user for ${id}"/>
          </label>
          <label class="telemetry-field">
            <span>Password</span>
            <input type="password" name="password" autocomplete="off"
              placeholder="${channel.authSource === "stored" ? "Keep stored credential" : "OPENOBSERVE_*_PASSWORD"}"
              aria-label="Basic-auth password for ${id}"/>
          </label>
        </div>
        <div class="telemetry-actions">
          <button type="submit" class="btn">Save</button>
          <button type="submit" formaction="/config/telemetry/${id}/test" formnovalidate class="btn-secondary"
            ${hasConfig ? "" : "disabled"} title="POST one probe payload to the effective endpoint">Test connection</button>
          ${hasStored ? `<button type="submit" formaction="/config/telemetry/${id}/delete" formnovalidate class="btn-danger">Clear stored</button>` : ""}
        </div>
        <p class="muted">Blank fields inherit the shared connection / keep the stored value. Environment variables always win over stored values — unset them to use the page's config.</p>
      </form>`
    : "";
  return `<li class="card telemetry-card" data-channel="${id}">
    <header class="connection-head">
      <div>
        <p class="label">${id}</p>
        <h3 class="specimen-title">${escapeHtml(meta?.label ?? channel.channel)}</h3>
        <p class="muted">${escapeHtml(meta?.detail ?? "")}</p>
      </div>
      <div class="connection-chips">${urlBadge(channel)} ${authBadge(channel)}</div>
    </header>
    ${channel.url ? `<p class="muted telemetry-url">Effective endpoint: <code>${escapeHtml(channel.url)}</code></p>` : ""}
    ${form}
  </li>`;
}

function adHocForm(csrfToken: string | undefined, canWrite: boolean): string {
  if (!canWrite) return "";
  const options = TELEMETRY_CHANNELS.map(
    (c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`,
  ).join("");
  return `
  <section class="card">
    <h2>Test ad-hoc values</h2>
    <p class="muted">Probe an endpoint without saving it — nothing here is persisted.</p>
    <form method="post" action="/config/telemetry/test" class="telemetry-form">
      ${csrfInput(csrfToken)}
      <div class="telemetry-grid">
        <label class="telemetry-field">
          <span>Channel</span>
          <select name="channel" aria-label="Channel to probe">${options}</select>
        </label>
        <label class="telemetry-field telemetry-field-wide">
          <span>Endpoint URL</span>
          <input type="url" name="url" required autocomplete="off" placeholder="https://oo.example.com/api/default/v1/traces"/>
        </label>
        <label class="telemetry-field">
          <span>Bearer token</span>
          <input type="password" name="token" autocomplete="off"/>
        </label>
        <label class="telemetry-field">
          <span>User</span>
          <input type="text" name="user" autocomplete="off"/>
        </label>
        <label class="telemetry-field">
          <span>Password</span>
          <input type="password" name="password" autocomplete="off"/>
        </label>
      </div>
      <div class="telemetry-actions">
        <button type="submit" class="btn-secondary">Test these values</button>
      </div>
    </form>
  </section>`;
}

export function renderTelemetryPage(data: TelemetryPageData): string {
  const cards = [sharedCard(data.shared, data.csrfToken, data.canWrite), ...data.channels.map((channel) => channelCard(channel, data.csrfToken, data.canWrite))].join("");
  const body = `
    ${configSubNav("telemetry")}
    ${data.options.notice ? `<p class="notice" role="status">${escapeHtml(data.options.notice)}</p>` : ""}
    ${data.options.error ? `<p class="error" role="alert">${escapeHtml(data.options.error)}</p>` : ""}
    <h1>Telemetry</h1>
    <p class="muted">OpenObserve connection for each export channel. See the
    <a href="https://github.com/Dragonshorn-Studios/maomao/blob/main/docs/telemetry/openobserve-setup.md">OpenObserve setup guide</a>
    for endpoint URLs and credentials. Env source: ${data.channels
      .map((c) => `${c.channel} ${sourceLabel(c.urlSource)}/${sourceLabel(c.authSource)}`)
      .join(" · ")}</p>
    <ul class="telemetry-list">${cards}</ul>
    ${adHocForm(data.csrfToken, data.canWrite)}
  `;
  return layout("Telemetry", body, { ...data.options, surface: "operator" });
}
