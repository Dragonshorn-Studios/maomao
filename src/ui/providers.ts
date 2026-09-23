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
  <script>
  (() => {
    const input = document.getElementById("provider-filter");
    const empty = document.getElementById("provider-filter-empty");
    const cards = document.querySelectorAll("#provider-list [data-provider]");
    if (!input || !empty) return;
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      let visible = 0;
      for (const card of cards) {
        const show = !q || card.getAttribute("data-provider").includes(q);
        card.style.display = show ? "" : "none";
        if (show) visible += 1;
      }
      empty.hidden = visible !== 0;
    });
  })();
  </script>`;
  return layout("Provider API keys", body, { ...data.options, surface: "operator" });
}
