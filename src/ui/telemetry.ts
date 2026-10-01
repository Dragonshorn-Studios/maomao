import { escapeHtml } from "../util.js";
import { csrfInput, layout, type PageOptions } from "./layout.js";
import { configSubNav } from "./pages.js";
import {
  TELEMETRY_CHANNELS,
  type TelemetryChannelStatus,
  type TelemetrySharedStatus,
} from "../telemetry/settings.js";

/**
 * OpenObserve connection page (/config/telemetry): a shared connection card
 * (base URL + ingestion token + logs stream that all three channels
 * inherit), a read-only "Effective endpoints" section that live-derives the
 * URLs Maomao will call, and an "Advanced channel overrides" section for
 * per-channel endpoint/credential overrides. Probes ("Test all" or
 * per-channel) POST one real telemetry payload to verify the effective
 * config. Secrets are never rendered — a stored credential shows only
 * "Credential stored".
 */

export interface TelemetryProbeRow {
  channel: string;
  ok: boolean;
  /** e.g. "Connected — HTTP 200" or "HTTP 401 — Unauthorized". */
  detail: string;
  /** Effective URL probed, credentials masked. */
  url?: string;
}

export interface TelemetryPageData {
  channels: TelemetryChannelStatus[];
  shared: TelemetrySharedStatus;
  csrfToken?: string;
  canWrite: boolean;
  /** Result of a "Test all" run, rendered as a compact summary. */
  probeResults?: TelemetryProbeRow[];
  options: PageOptions;
}

export const TELEMETRY_PAGE_HREF = "/assets/telemetry.js";

/**
 * Live effective-endpoint derivation + copy buttons. Reads the shared base
 * URL / logs stream inputs and each channel's endpoint-override input, then
 * mirrors the server's deriveChannelUrl logic. No secrets involved — it only
 * reads the URL/stream fields. Runs deferred on /config/telemetry only.
 */
export const TELEMETRY_PAGE_JS = String.raw`(function () {
  "use strict";

  function field(name) {
    return document.querySelector('input[name="' + name + '"]');
  }

  function cleanBase(value) {
    return (value || "").trim().split(/[?#]/)[0].replace(/\/+$/, "");
  }

  function derive(channel, base, stream) {
    if (!base) return null;
    if (channel === "logs") {
      var name = (stream || "").trim();
      return name ? base + "/" + encodeURIComponent(name) + "/_json" : null;
    }
    return base + "/v1/" + channel;
  }

  function copyText(button, text) {
    function done(ok) {
      button.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(function () { button.textContent = "Copy"; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      var area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      try { done(document.execCommand("copy")); } catch (e) { done(false); }
      document.body.removeChild(area);
    }
  }

  function refresh() {
    var section = document.querySelector("[data-shared-base]");
    var typedBase = cleanBase(field("baseUrl") && field("baseUrl").value);
    var typedStream = field("stream") && field("stream").value.trim();
    var base = typedBase || (section ? section.getAttribute("data-shared-base") : "");
    var stream = typedStream || (section ? section.getAttribute("data-shared-stream") : "");
    var rows = document.querySelectorAll("[data-endpoint]");
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var channel = row.getAttribute("data-endpoint");
      var override = row.getAttribute("data-override-input");
      var overrideValue = override && field(override) ? field(override).value.trim() : "";
      var pinned = row.getAttribute("data-pinned") === "1";
      var fallback = row.getAttribute("data-fallback") || "";
      var url = overrideValue || (pinned ? fallback : derive(channel, base, stream)) || fallback;
      var value = row.querySelector(".endpoint-value");
      var button = row.querySelector(".endpoint-copy");
      if (url) {
        value.textContent = url;
        row.classList.remove("endpoint-missing");
        if (button) button.disabled = false;
      } else {
        var hint = !base
          ? "Enter a Base URL above to calculate this endpoint."
          : "Enter a Logs stream above to calculate this endpoint.";
        value.textContent = hint;
        row.classList.add("endpoint-missing");
        if (button) button.disabled = true;
      }
    }
  }

  var rows = document.querySelectorAll("[data-endpoint]");
  if (!rows.length) return;
  document.addEventListener("input", refresh);
  for (var i = 0; i < rows.length; i++) {
    (function (row) {
      var button = row.querySelector(".endpoint-copy");
      if (!button) return;
      button.addEventListener("click", function () {
        var value = row.querySelector(".endpoint-value").textContent;
        copyText(button, value);
      });
    })(rows[i]);
  }
  refresh();
})();`;

function helpBlock(): string {
  return `<details class="card telemetry-help">
    <summary>How to configure OpenObserve</summary>
    <ol class="telemetry-steps">
      <li>In OpenObserve, create or copy an <strong>ingestion token</strong> (it usually starts with <code>o2oi_</code>).</li>
      <li>Copy your organization API base URL, for example <code>https://openobserve.example.com/api/default</code>.</li>
      <li>Paste the base URL, your OpenObserve email, and the ingestion token below.</li>
      <li>Choose a logs stream name, for example <code>maomao</code>.</li>
      <li>Save, then run <strong>Test all</strong>.</li>
    </ol>
    <p class="muted">Telemetry ingestion tokens are for <em>sending</em> data into OpenObserve. MCP / service-account
    tokens are for <em>reading</em> or managing OpenObserve and are normally configured elsewhere — do not use them
    here.</p>
  </details>`;
}

function authFields(prefix: string, storedAuth: boolean, tokenLabel: string, tokenHelp: string): string {
  const scope = prefix ? ` for ${prefix.replace(/-$/, "")}` : "";
  const keep = storedAuth ? "Keep stored credential" : "";
  return `
    <div class="telemetry-grid">
      <div class="telemetry-auth-alt">
        <label class="telemetry-field">
          <span>OpenObserve email</span>
          <input type="email" name="${prefix}email" autocomplete="off"
            placeholder="${keep || "you@example.com"}"
            aria-label="OpenObserve email${scope}"/>
        </label>
        <label class="telemetry-field">
          <span>${tokenLabel}</span>
          <input type="password" name="${prefix}token" autocomplete="off" minlength="4"
            placeholder="${keep || "o2oi_…"}"
            aria-label="${escapeHtml(tokenLabel)}${scope}"/>
        </label>
        <small class="muted telemetry-auth-alt-note">${tokenHelp} Maomao sends the token as the basic-auth
        <em>password</em> with this email as the username — OpenObserve ingestion does not accept Bearer tokens.</small>
      </div>
      <div class="telemetry-or" role="separator"><span>OR</span></div>
      <div class="telemetry-auth-alt">
        <label class="telemetry-field">
          <span>User</span>
          <input type="text" name="${prefix}user" autocomplete="off"
            placeholder="${keep}"
            aria-label="Basic-auth user${scope}"/>
        </label>
        <label class="telemetry-field">
          <span>Password</span>
          <input type="password" name="${prefix}password" autocomplete="off"
            placeholder="${keep}"
            aria-label="Basic-auth password${scope}"/>
        </label>
        <small class="muted telemetry-auth-alt-note">Legacy alternative: a regular OpenObserve user/password
        (also sent as basic auth). Use either email + ingestion token <em>or</em> user/password — not both.</small>
      </div>
    </div>`;
}

function sharedCard(shared: TelemetrySharedStatus, csrfToken: string | undefined, canWrite: boolean): string {
  const field = (source: TelemetrySharedStatus["baseUrlSource"], envVar?: string): string => {
    if (source === "environment") return `from environment variable <code>${escapeHtml(envVar ?? "")}</code>`;
    if (source === "stored") return "stored";
    return "not set";
  };
  const statusLine = `Base URL: ${field(shared.baseUrlSource, shared.baseUrlEnvVar)} ·
    Logs stream: ${field(shared.streamSource, shared.streamEnvVar)} ·
    Credential: ${field(shared.authSource, shared.authEnvVar)}`;
  const form = canWrite
    ? `<form method="post" action="/config/telemetry/shared" class="telemetry-form">
        ${csrfInput(csrfToken)}
        <div class="telemetry-grid">
          <label class="telemetry-field telemetry-field-wide">
            <span>Base URL</span>
            <input type="url" name="baseUrl" autocomplete="off"
              placeholder="${shared.baseUrl ? escapeHtml(shared.baseUrl) : "https://openobserve.example.com/api/default"}"
              aria-label="OpenObserve organization API base URL"/>
            <small class="muted">OpenObserve organization API base URL. Do not include <code>/v1/traces</code>, <code>/v1/metrics</code>, or a stream name.</small>
          </label>
          <label class="telemetry-field">
            <span>Logs stream</span>
            <input type="text" name="stream" autocomplete="off"
              placeholder="${shared.stream ? escapeHtml(shared.stream) : "maomao"}"
              aria-label="OpenObserve stream for job summary logs"/>
            <small class="muted">OpenObserve stream used for Maomao job summary logs. The stream is created automatically when OpenObserve receives the first log event — you do not need to create it manually.</small>
          </label>
        </div>
        ${authFields("", shared.authSource === "stored", "OpenObserve ingestion token",
          "Recommended. Paste an OpenObserve ingestion token, typically beginning with <code>o2oi_</code>. It is intended for sending logs, metrics and traces — do not use an MCP/read-only service-account token here.")}
        <div class="telemetry-actions">
          <button type="submit" class="btn">Save</button>
          ${shared.authSource === "stored" ? `<button type="submit" formaction="/config/telemetry/shared/delete-auth" formnovalidate class="btn-secondary">Clear stored credential</button>` : ""}
          ${shared.hasStored ? `<button type="submit" formaction="/config/telemetry/shared/delete" formnovalidate class="btn-danger">Clear all</button>` : ""}
        </div>
        <p class="muted">Blank fields keep what is stored. Environment variables (<code>OPENOBSERVE_BASE_URL</code>,
        <code>OPENOBSERVE_LOGS_STREAM</code>, <code>OPENOBSERVE_EMAIL</code>, <code>OPENOBSERVE_TOKEN</code> /
        <code>OPENOBSERVE_USER</code> / <code>OPENOBSERVE_PASSWORD</code>) always win over saved values.</p>
      </form>
      <form method="post" action="/config/telemetry/test-all" class="telemetry-inline-form">
        ${csrfInput(csrfToken)}
        <button type="submit" class="btn-secondary"
          title="Probe all three channels with the effective (saved/env) configuration">Test all</button>
        <span class="muted">Tests the saved + environment configuration of all three channels — save first.</span>
      </form>`
    : "";
  return `<section class="card telemetry-card" data-channel="shared">
    <header class="connection-head">
      <div>
        <h3 class="specimen-title">OpenObserve connection</h3>
        <p class="muted">Configure OpenObserve once here. Traces, metrics and logs inherit these settings unless you explicitly override a channel below.</p>
      </div>
    </header>
    <p class="muted">${statusLine}</p>
    ${form}
  </section>`;
}

/** Read-only derived endpoints; values update live via telemetry.js. */
function effectiveEndpoints(channels: TelemetryChannelStatus[], shared: TelemetrySharedStatus): string {
  const rows = channels
    .map((channel) => {
      const pinned = channel.urlSource !== "none" && !channel.urlShared;
      const value = channel.url ?? "";
      const missing = value === "";
      return `<div class="endpoint-row${missing ? " endpoint-missing" : ""}" data-endpoint="${channel.channel}"
        data-override-input="url-${channel.channel}" data-fallback="${escapeHtml(value)}"${pinned ? ` data-pinned="1"` : ""}>
        <span class="endpoint-label">${escapeHtml(channel.channel === "logs" ? "Logs" : channel.channel === "traces" ? "Traces" : "Metrics")}</span>
        <code class="endpoint-value">${escapeHtml(missing ? "not configured" : value)}</code>
        <button type="button" class="btn-secondary endpoint-copy"${missing ? " disabled" : ""}>Copy</button>
      </div>`;
    })
    .join("");
  return `<section class="card" data-shared-base="${escapeHtml(shared.baseUrl ?? "")}" data-shared-stream="${escapeHtml(shared.stream ?? "")}">
    <h2>Effective endpoints</h2>
    <p class="muted">The URLs Maomao will call. They update as you type above.</p>
    ${rows}
  </section>`;
}

function endpointSourceText(channel: TelemetryChannelStatus): string {
  if (channel.urlSource === "environment") {
    return `from environment variable <code>${escapeHtml(channel.urlEnvVar ?? "")}</code>`;
  }
  if (channel.urlSource === "stored") {
    return channel.urlShared ? "derived from the shared connection" : "custom override (stored)";
  }
  return "not configured";
}

function authSourceText(channel: TelemetryChannelStatus): string {
  if (channel.authSource === "environment") {
    return `from environment variable <code>${escapeHtml(channel.authEnvVar ?? "")}</code>`;
  }
  if (channel.authSource === "stored") {
    return channel.authShared ? "using the shared credentials" : "channel-specific credentials (stored)";
  }
  return "no credentials configured";
}

function channelCard(channel: TelemetryChannelStatus, csrfToken: string | undefined, canWrite: boolean): string {
  const meta = TELEMETRY_CHANNELS.find((c) => c.id === channel.channel);
  const id = escapeHtml(channel.channel);
  const hasConfig = channel.url != null;
  const overrideForm = canWrite
    ? `<details class="telemetry-override">
        <summary>Override this channel (optional)</summary>
        <form method="post" action="/config/telemetry/${id}" class="telemetry-form">
          ${csrfInput(csrfToken)}
          <div class="telemetry-grid">
            <label class="telemetry-field telemetry-field-wide">
              <span>Endpoint URL</span>
              <input type="url" name="url-${id}" autocomplete="off"
                placeholder="Leave blank to use the derived endpoint"
                aria-label="Endpoint URL override for ${id}"/>
              <small class="muted">Optional. Leave blank to use the endpoint derived from the shared Base URL.</small>
            </label>
          </div>
          ${authFields(`${id}-`, channel.authSource === "stored" && !channel.authShared, `${meta?.label ?? id} token`,
            "Optional. Leave blank to use the shared OpenObserve ingestion credentials.")}
          <div class="telemetry-actions">
            <button type="submit" class="btn">Save override</button>
            ${channel.hasStored ? `<button type="submit" formaction="/config/telemetry/${id}/delete" formnovalidate class="btn-danger">Clear stored override</button>` : ""}
          </div>
        </form>
      </details>`
    : "";
  return `<li class="card telemetry-card" data-channel="${id}">
    <header class="connection-head">
      <div>
        <h3 class="specimen-title">${escapeHtml(meta?.label ?? channel.channel)}</h3>
        <p class="muted">${escapeHtml(meta?.detail ?? "")}</p>
      </div>
    </header>
    <p class="muted telemetry-url">Effective endpoint: ${channel.url ? `<code>${escapeHtml(channel.url)}</code>` : "<em>not configured</em>"} — ${endpointSourceText(channel)}</p>
    <p class="muted">Authentication: ${authSourceText(channel)}</p>
    ${canWrite ? `<div class="telemetry-actions">
      <form method="post" action="/config/telemetry/${id}/test" class="telemetry-inline-form">
        ${csrfInput(csrfToken)}
        <button type="submit" class="btn-secondary" ${hasConfig ? "" : "disabled"}
          title="POST one probe payload to the effective endpoint">Test connection</button>
      </form>
    </div>` : ""}
    ${overrideForm}
  </li>`;
}

function adHocForm(csrfToken: string | undefined, canWrite: boolean): string {
  if (!canWrite) return "";
  const options = TELEMETRY_CHANNELS.map(
    (c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`,
  ).join("");
  return `
  <details class="card telemetry-override">
    <summary>Test ad-hoc values — probe an endpoint without saving anything</summary>
    <form method="post" action="/config/telemetry/test" class="telemetry-form">
      ${csrfInput(csrfToken)}
      <div class="telemetry-grid">
        <label class="telemetry-field">
          <span>Channel</span>
          <select name="channel" aria-label="Channel to probe">${options}</select>
        </label>
        <label class="telemetry-field telemetry-field-wide">
          <span>Endpoint URL</span>
          <input type="url" name="url" required autocomplete="off" placeholder="https://openobserve.example.com/api/default/v1/traces"/>
        </label>
        <label class="telemetry-field">
          <span>Email</span>
          <input type="email" name="email" autocomplete="off"/>
        </label>
        <label class="telemetry-field">
          <span>Ingestion token</span>
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
  </details>`;
}

function probeResultsBlock(results: TelemetryProbeRow[]): string {
  const rows = results
    .map(
      (r) => `<li class="${r.ok ? "probe-ok" : "probe-fail"}">
        <strong>${escapeHtml(r.channel)}</strong> — ${escapeHtml(r.detail)}${r.url ? ` <code>${escapeHtml(r.url)}</code>` : ""}
      </li>`,
    )
    .join("");
  return `<ul class="probe-results">${rows}</ul>`;
}

export function renderTelemetryPage(data: TelemetryPageData): string {
  const cards = data.channels.map((channel) => channelCard(channel, data.csrfToken, data.canWrite)).join("");
  const body = `
    ${configSubNav("telemetry")}
    ${data.options.notice ? `<p class="notice" role="status">${escapeHtml(data.options.notice)}</p>` : ""}
    ${data.options.error ? `<p class="error" role="alert">${escapeHtml(data.options.error)}</p>` : ""}
    <h1>Telemetry</h1>
    ${helpBlock()}
    ${sharedCard(data.shared, data.csrfToken, data.canWrite)}
    ${data.probeResults ? probeResultsBlock(data.probeResults) : ""}
    ${effectiveEndpoints(data.channels, data.shared)}
    <h2>Advanced channel overrides</h2>
    <p class="muted">Normally you do not need anything below. Leave these fields blank to inherit the shared OpenObserve connection.</p>
    <ul class="telemetry-list">${cards}</ul>
    ${adHocForm(data.csrfToken, data.canWrite)}
    <script src="${TELEMETRY_PAGE_HREF}" defer></script>
  `;
  return layout("Telemetry", body, { ...data.options, surface: "operator" });
}
