import { PACK_DEFAULTS, THEME_PACKS, UI_FLAVORS, type InstanceBranding, type StoredInstanceBranding, type UiFlavor, type UiThemePack } from "../branding.js";
import { escapeHtml } from "../util.js";
import { csrfInput, layout, type PageOptions } from "./layout.js";

export interface AppearancePageData {
  effective: InstanceBranding;
  stored: StoredInstanceBranding;
  hasStored: boolean;
  env: NodeJS.ProcessEnv;
  csrfToken?: string;
  canWrite: boolean;
  options: PageOptions;
}

function envNote(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  return value ? ` <small class="muted">Overridden by <code>${escapeHtml(key)}</code>; the stored value is ignored.</small>` : "";
}

export function renderAppearancePage(data: AppearancePageData): string {
  const defaults = PACK_DEFAULTS[data.effective.themePack];
  const themeOptions = THEME_PACKS.map((pack) =>
    `<option value="${pack}"${pack === data.effective.themePack ? " selected" : ""}>${pack}</option>`,
  ).join("");
  const copyOptions = [`<option value=""${data.stored.copyFlavor ? "" : " selected"}>Match theme pack</option>`]
    .concat(UI_FLAVORS.map((flavor) => `<option value="${flavor}"${flavor === data.stored.copyFlavor ? " selected" : ""}>${flavor}</option>`))
    .join("");
  const textField = (key: "name" | "tagline" | "description", label: string, maxLength: number, envKey: string) => `
    <label class="telemetry-field telemetry-field-wide">
      <span>${label}</span>
      <input type="text" name="${key}" value="${escapeHtml(data.stored[key] ?? "")}" maxlength="${maxLength}" autocomplete="off" placeholder="${escapeHtml(defaults[key])}"/>
      <small class="muted">Blank uses the selected theme pack default.${envNote(data.env, envKey)}</small>
    </label>`;
  const form = data.canWrite
    ? `<form method="post" action="/config/appearance" class="card telemetry-form">
        ${csrfInput(data.csrfToken)}
        <h2>Instance branding</h2>
        <div class="telemetry-grid">
          <label class="telemetry-field">
            <span>Theme pack</span>
            <select name="themePack">${themeOptions}</select>
            <small class="muted">Controls the visual token and icon pack.${envNote(data.env, "UI_THEME_PACK")}</small>
          </label>
          <label class="telemetry-field">
            <span>Copy flavor</span>
            <select name="copyFlavor">${copyOptions}</select>
            <small class="muted">Controls flavored interface copy independently from the visual pack.${envNote(data.env, "UI_FLAVOR")}</small>
          </label>
          ${textField("name", "Instance display name", 80, "UI_INSTANCE_NAME")}
          ${textField("tagline", "Instance tagline", 120, "UI_INSTANCE_TAGLINE")}
          ${textField("description", "Instance description", 240, "UI_INSTANCE_DESCRIPTION")}
        </div>
        <div class="telemetry-actions">
          <button type="submit" class="btn">Save appearance</button>
          ${data.hasStored ? `<button type="submit" formaction="/config/appearance/delete" formnovalidate class="btn-danger">Clear stored branding</button>` : ""}
        </div>
      </form>`
    : "";
  const body = `
    ${data.options.notice ? `<p class="notice" role="status">${escapeHtml(data.options.notice)}</p>` : ""}
    ${data.options.error ? `<p class="error" role="alert">${escapeHtml(data.options.error)}</p>` : ""}
    <h1>Appearance</h1>
    <p class="muted">Instance-wide branding for every operator and viewer of this deployment. Changes apply immediately to subsequently rendered pages; environment variables remain authoritative field-by-field.</p>
    <section class="card">
      <h2>Effective branding</h2>
      <dl class="config-grid">
        <dt>Name</dt><dd>${escapeHtml(data.effective.name)}</dd>
        <dt>Tagline</dt><dd>${escapeHtml(data.effective.tagline)}</dd>
        <dt>Description</dt><dd>${escapeHtml(data.effective.description)}</dd>
        <dt>Theme pack</dt><dd><code>${escapeHtml(data.effective.themePack)}</code></dd>
        <dt>Copy flavor</dt><dd><code>${escapeHtml(data.effective.copyFlavor)}</code></dd>
      </dl>
    </section>
    ${form}
  `;
  return layout("Appearance", body, { ...data.options, surface: "operator", nav: "settings", settingsSection: "appearance" });
}
