import type { MergeModeRule } from "../merge/settings.js";
import type { ForgeMergeMode } from "../forge/types.js";
import { escapeHtml } from "../util.js";
import { csrfInput, layout, type PageOptions } from "./layout.js";

export interface MergeModesPageData {
  rules: MergeModeRule[];
  csrfToken?: string;
  canWrite: boolean;
  options: PageOptions;
}

const MODE_LABELS: Array<[ForgeMergeMode, string]> = [
  ["disabled", "disabled — do not probe or act on native merge integration"],
  ["manual", "manual — report readiness/capabilities; people merge in the forge"],
  ["native_auto_merge", "native auto-merge — opt in to forge-native auto-merge where supported"],
  ["github_native_queue", "GitHub native queue — opt in to GitHub merge queue where configured"],
];

function modeOptions(selected?: string): string {
  return MODE_LABELS.map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function scopeText(rule: MergeModeRule): string {
  if (!rule.repoFullName) return "global default";
  return `${rule.provider}:${rule.providerInstance} · ${rule.repoFullName}`;
}

export function renderMergeModesPage(data: MergeModesPageData): string {
  const rows = data.rules.map((rule) => `<tr>
    <td>${escapeHtml(scopeText(rule))}</td>
    <td><code>${escapeHtml(rule.mergeMode)}</code></td>
    <td>${escapeHtml(rule.updatedBy)}<br/><span class="muted">${escapeHtml(rule.updatedAt)}</span></td>
    <td>${data.canWrite ? `<form method="post" action="/config/merge-modes/delete" class="inline-form">${csrfInput(data.csrfToken)}<input type="hidden" name="id" value="${rule.id}"/><button type="submit" class="btn-danger">Delete</button></form>` : ""}</td>
  </tr>`).join("");
  const form = data.canWrite ? `<form method="post" action="/config/merge-modes" class="card telemetry-form">
    ${csrfInput(data.csrfToken)}
    <h2>Save merge mode</h2>
    <p class="muted">Leave every scope field blank to set the global default. For a repository rule, complete all three scope fields; rules never apply across forge instances. GitHub native queue requires an explicit GitHub repository rule.</p>
    <div class="telemetry-grid">
      <label class="telemetry-field"><span>Provider</span><input type="text" name="provider" list="merge-provider-names" autocomplete="off" placeholder="github"/><datalist id="merge-provider-names"><option value="github"></option><option value="forgejo"></option></datalist></label>
      <label class="telemetry-field"><span>Forge instance</span><input type="text" name="providerInstance" autocomplete="off" placeholder="github.com or forgejo.example.com"/></label>
      <label class="telemetry-field"><span>Repository</span><input type="text" name="repoFullName" autocomplete="off" placeholder="owner/repo"/></label>
      <label class="telemetry-field"><span>Mode</span><select name="mergeMode">${modeOptions("manual")}</select></label>
    </div>
    <div class="telemetry-actions"><button type="submit" class="btn">Save merge mode</button></div>
  </form>` : "";
  const body = `
    ${data.options.notice ? `<p class="notice" role="status">${escapeHtml(data.options.notice)}</p>` : ""}
    ${data.options.error ? `<p class="error" role="alert">${escapeHtml(data.options.error)}</p>` : ""}
    <h1>Merge modes</h1>
    <p class="muted">Explicit operator policy for native merge integration. Saving a native mode records opt-in intent only; any future merge action must still revalidate live forge capabilities, exact PR state, branch protection, and operator authorization. Maomao never receives blanket merge or protected-push authority here.</p>
    <section class="card">
      <h2>Configured rules</h2>
      ${data.rules.length ? `<table><thead><tr><th>Scope</th><th>Mode</th><th>Updated</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="muted">No stored rules. The default mode is <code>manual</code>.</p>`}
    </section>
    ${form}
  `;
  return layout("Merge modes", body, { ...data.options, surface: "operator", nav: "settings", settingsSection: "merge-modes" });
}
