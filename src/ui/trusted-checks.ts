import { escapeHtml } from "../util.js";
import { csrfInput, layout, type PageOptions } from "./layout.js";
import { configSubNav } from "./pages.js";
import type { TrustedCheckSettingsStatus } from "../checks/settings.js";

export interface TrustedChecksPageData {
  status: TrustedCheckSettingsStatus;
  csrfToken?: string;
  canWrite: boolean;
  options: PageOptions;
}

function checkboxes(status: TrustedCheckSettingsStatus): string {
  const box = (name: "secrets" | "security", label: string) =>
    `<label class="role-check"><input type="checkbox" name="${name}" value="1"${status.enabledChecks.includes(name) ? " checked" : ""}/> <span>${label}</span></label>`;
  return `<fieldset class="trusted-checks-enabled">
    <legend>Enabled deterministic checks</legend>
    <div class="alert-level">
    ${box("secrets", "maomao/secrets — credential scanning")}
    ${box("security", "maomao/security — static security scanning")}
    </div>
    <small class="muted">Unchecked checks are not executed; already queued native checks are cancelled. Clear the whole configuration to disable trusted checks.</small>
  </fieldset>`;
}

export function renderTrustedChecksPage(data: TrustedChecksPageData): string {
  const status = data.status;
  const envManaged = status.source === "environment";
  const sourceText = envManaged
    ? "environment variables (read-only here)"
    : status.source === "stored"
      ? "stored operator settings"
      : "not configured";
  const form = data.canWrite && !envManaged
    ? `<form method="post" action="/config/trusted-checks" class="card telemetry-form">
        ${csrfInput(data.csrfToken)}
        <h2>Trusted checks source</h2>
        <div class="telemetry-grid">
          <label class="telemetry-field telemetry-field-wide">
            <span>Repository URL</span>
            <input type="text" name="repoUrl" value="${escapeHtml(status.repoUrl)}" autocomplete="off" placeholder="https://git.example.com/security/maomao-trusted-checks.git"/>
            <small class="muted">Operator-controlled git repository containing <code>maomao-trusted-checks.json</code>. Leave the local path blank when using this.</small>
          </label>
          <label class="telemetry-field telemetry-field-wide">
            <span>Local checkout path</span>
            <input type="text" name="localPath" value="${escapeHtml(status.localPath)}" autocomplete="off" placeholder="/opt/maomao-trusted-checks"/>
            <small class="muted">Alternative for operator-managed local deployments. It must stay clean and exactly at the pinned revision.</small>
          </label>
          <label class="telemetry-field telemetry-field-wide">
            <span>Pinned revision</span>
            <input type="text" name="revision" value="${escapeHtml(status.revision)}" autocomplete="off" minlength="40" maxlength="40" pattern="[0-9a-fA-F]{40}" placeholder="0123456789abcdef0123456789abcdef01234567"/>
            <small class="muted">Full commit SHA. Updating it affects subsequent scans only; already running jobs keep their checkout input.</small>
          </label>
        </div>
        ${checkboxes(status)}
        <div class="telemetry-actions">
          <button type="submit" class="btn">Save trusted checks</button>
          ${status.hasStored ? `<button type="submit" formaction="/config/trusted-checks/delete" formnovalidate class="btn-danger">Clear stored settings</button>` : ""}
        </div>
      </form>`
    : "";
  const current = `<section class="card">
    <h2>Effective trusted checks</h2>
    <dl class="config-grid">
      <dt>Source</dt><dd>${escapeHtml(sourceText)}</dd>
      <dt>Repository URL</dt><dd>${status.repoUrl ? `<code>${escapeHtml(status.repoUrl)}</code>` : "—"}</dd>
      <dt>Local path</dt><dd>${status.localPath ? `<code>${escapeHtml(status.localPath)}</code>` : "—"}</dd>
      <dt>Pinned revision</dt><dd>${status.revision ? `<code>${escapeHtml(status.revision)}</code>` : "—"}</dd>
      <dt>Enabled checks</dt><dd>${status.enabledChecks.length ? status.enabledChecks.map((name) => `<code>maomao/${name}</code>`).join(" ") : "none"}</dd>
    </dl>
    ${envManaged ? `<p class="muted">This deployment is pinned by <code>MAOMAO_TRUSTED_CHECKS_*</code> environment variables, so the UI cannot change the effective source.</p>` : ""}
    ${envManaged && data.canWrite && status.hasStored ? `<form method="post" action="/config/trusted-checks/delete">${csrfInput(data.csrfToken)}<button type="submit" class="btn-danger">Clear shadowed stored settings</button></form>` : ""}
  </section>`;
  const body = `
    ${configSubNav("trusted-checks")}
    ${data.options.notice ? `<p class="notice" role="status">${escapeHtml(data.options.notice)}</p>` : ""}
    ${data.options.error ? `<p class="error" role="alert">${escapeHtml(data.options.error)}</p>` : ""}
    <h1>Trusted checks</h1>
    <p class="muted">Select the operator-controlled repository or checkout and immutable revision used for deterministic secrets/security scans. Pull-request content is never executed as part of these checks.</p>
    ${current}
    ${form}
  `;
  return layout("Trusted checks", body, { ...data.options, surface: "operator" });
}
