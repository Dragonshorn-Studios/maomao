/**
 * Provider API-key page (issue #94). Keys entered here are written to
 * OpenCode's auth.json on the OpenCode data dir — never into Maomao's
 * database or env. Keys are write-only: the page shows source and a last-4
 * fingerprint, never the key itself.
 */
import { escapeHtml } from "../util.js";
import { csrfInput, layout, type PageOptions } from "./layout.js";
import { configSubNav } from "./pages.js";
import type { ProviderCredentialStatus } from "../opencode/credentials.js";

export interface ProvidersPageData {
  providers: ProviderCredentialStatus[];
  csrfToken?: string;
  canWrite: boolean;
  /** MODEL_CATALOG entries merged with live-discovered models (deduped). */
  modelCatalog?: Array<{ id: string; hint?: string }>;
  /** Epoch ms of the last successful `opencode models` refresh; 0 while none. */
  modelsFetchedAt?: number;
  /** Last discovery error, when refresh failed. */
  modelsError?: string;
  options: PageOptions;
}

function sourceBadge(provider: ProviderCredentialStatus): string {
  if (provider.source === "environment") {
    return `<span class="state state-completed">key from env <code>${escapeHtml(provider.envVar ?? "")}</code></span>`;
  }
  if (provider.source === "stored") {
    return `<span class="state state-completed">key stored in auth.json ···${escapeHtml(provider.fingerprint ?? "")}</span>`;
  }
  return `<span class="state state-queued">no key</span>`;
}

function providerRow(provider: ProviderCredentialStatus, csrfToken: string | undefined, canWrite: boolean): string {
  const actionId = escapeHtml(encodeURIComponent(provider.id));
  const stored = provider.source === "stored";
  const keyForm = canWrite
    ? `<form method="post" action="/config/providers/${actionId}" class="provider-key-form">
        ${csrfInput(csrfToken)}
        <input type="password" name="key" required autocomplete="off" minlength="4"
          placeholder="${stored ? "Replace stored key" : "Paste API key"}"
          aria-label="API key for ${escapeHtml(provider.label)}"/>
        <button type="submit" class="btn">${stored ? "Replace" : "Save"}</button>
        ${stored || provider.source === "environment" ? `<button type="submit" formaction="/config/providers/${actionId}/test" formnovalidate class="btn-secondary" title="Spawn a real opencode run with the configured key">Test key</button>` : ""}
        ${stored ? `<button type="submit" formaction="/config/providers/${actionId}/delete" formnovalidate class="btn-danger">Remove</button>` : ""}
      </form>`
    : "";
  const help = provider.helpUrl
    ? `<p class="muted provider-help">${escapeHtml(provider.helpLabel ?? "Get a key")}:
       <a href="${escapeHtml(provider.helpUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(provider.helpUrl.replace(/^https?:\/\//, ""))}</a></p>`
    : "";
  const envNote =
    provider.source === "environment"
      ? `<p class="muted">Set via environment — the env var wins over a stored key. Unset it to use the stored one.</p>`
      : "";
  return `<li class="card provider-card" data-provider="${escapeHtml(`${provider.id} ${provider.label}`.toLowerCase())}">
    <header class="connection-head">
      <div>
        <p class="label">${escapeHtml(provider.id)}</p>
        <h3 class="specimen-title">${escapeHtml(provider.label)}</h3>
      </div>
      <div class="connection-chips">${sourceBadge(provider)}</div>
    </header>
    ${help}
    ${envNote}
    ${keyForm}
  </li>`;
}

function modelListSection(data: ProvidersPageData): string {
  const catalog = data.modelCatalog ?? [];
  const keyedProviders = new Set(data.providers.filter((p) => p.source !== "none").map((p) => p.id));
  const groups = new Map<string, Array<{ id: string; hint?: string }>>();
  for (const model of catalog) {
    const provider = model.id.split("/")[0] ?? model.id;
    const bucket = groups.get(provider) ?? [];
    if (bucket.length === 0) groups.set(provider, bucket);
    bucket.push(model);
  }
  const refreshed =
    data.modelsFetchedAt && data.modelsFetchedAt > 0
      ? `refreshed ${escapeHtml(new Date(data.modelsFetchedAt).toISOString().slice(0, 16).replace("T", " "))} UTC`
      : "never refreshed";
  const refreshForm = data.canWrite
    ? `<form method="post" action="/config/models/refresh?next=providers" class="model-refresh">
        ${csrfInput(data.csrfToken)}
        <button type="submit" class="btn-secondary" title="Re-run opencode models so newly saved keys expose their models">Refresh model list</button>
      </form>`
    : "";
  const errorNote = data.modelsError
    ? `<p class="error" role="alert">Last model refresh failed: ${escapeHtml(data.modelsError)}</p>`
    : "";
  const groupHtml =
    catalog.length === 0
      ? `<p class="muted">No models known yet — save a key, then refresh the list.</p>`
      : [...groups.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([provider, models]) => {
            const badge = keyedProviders.has(provider) ? `<span class="state state-completed">key set</span>` : "";
            const items = models
              .map(
                (model) =>
                  `<li class="model-item" data-model="${escapeHtml(model.id.toLowerCase())}"><code>${escapeHtml(model.id)}</code>${
                    model.hint ? ` <span class="muted">${escapeHtml(model.hint)}</span>` : ""
                  }</li>`,
              )
              .join("");
            return `<section class="model-group" data-model-group>
              <h3 class="model-group-head">${escapeHtml(provider)} ${badge}<span class="muted model-group-count">${models.length}</span></h3>
              <ul class="model-grid">${items}</ul>
            </section>`;
          })
          .join("");
  return `
  <section class="model-list">
    <header class="model-list-head">
      <div>
        <h2>Available models</h2>
        <p class="muted">${catalog.length} models · ${refreshed} — from <code>opencode models</code> and MODEL_CATALOG.</p>
      </div>
      ${refreshForm}
    </header>
    ${errorNote}
    <p class="provider-filter">
      <input type="search" id="model-filter" placeholder="Search models…" aria-label="Search models"/>
      <span class="muted" id="model-filter-empty" hidden>No models match.</span>
    </p>
    <div id="model-groups">${groupHtml}</div>
  </section>`;
}

export function renderProvidersPage(data: ProvidersPageData): string {
  const rows = data.providers.map((provider) => providerRow(provider, data.csrfToken, data.canWrite)).join("");
  const body = `
  <section>
    ${configSubNav("providers")}
    <h1>Provider API keys</h1>
    <p class="lede">Keys are written to OpenCode's credential file (<code>auth.json</code> in its data directory — the
    <code>maomao-opencode</code> volume in the Compose setup) and are read by OpenCode at each run. Keys are never
    shown again after saving; an environment variable of the same provider takes precedence over a stored key.
    OAuth providers are still enrolled with <code>opencode auth login</code> on the volume.</p>
    ${data.options.notice ? `<p class="notice" role="status">${escapeHtml(data.options.notice)}</p>` : ""}
    ${data.options.error ? `<p class="error" role="alert">${escapeHtml(data.options.error)}</p>` : ""}
    ${data.canWrite ? "" : `<p class="muted">Writing provider keys requires an operator OAuth identity.</p>`}
    <p class="provider-filter">
      <input type="search" id="provider-filter" placeholder="Filter providers…" aria-label="Filter providers"/>
      <span class="muted" id="provider-filter-empty" hidden>No providers match.</span>
    </p>
    <ul class="queue connection-list" id="provider-list">${rows}</ul>
  </section>
  ${modelListSection(data)}
  <script>
  (() => {
    const input = document.getElementById("provider-filter");
    const empty = document.getElementById("provider-filter-empty");
    const cards = document.querySelectorAll("#provider-list [data-provider]");
    if (input && empty) input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      let visible = 0;
      for (const card of cards) {
        const show = !q || card.getAttribute("data-provider").includes(q);
        card.style.display = show ? "" : "none";
        if (show) visible += 1;
      }
      empty.hidden = visible !== 0;
    });
    const modelInput = document.getElementById("model-filter");
    const modelEmpty = document.getElementById("model-filter-empty");
    const items = document.querySelectorAll("#model-groups [data-model]");
    const groups = document.querySelectorAll("#model-groups [data-model-group]");
    if (modelInput && modelEmpty) modelInput.addEventListener("input", () => {
      const q = modelInput.value.trim().toLowerCase();
      let visible = 0;
      for (const item of items) {
        const show = !q || item.getAttribute("data-model").includes(q);
        item.style.display = show ? "" : "none";
        if (show) visible += 1;
      }
      for (const group of groups) {
        group.style.display = group.querySelector('[data-model]:not([style*="none"])') ? "" : "none";
      }
      modelEmpty.hidden = visible !== 0;
    });
  })();
  </script>`;
  return layout("Provider API keys", body, { ...data.options, surface: "operator" });
}
