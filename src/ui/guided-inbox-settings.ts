import { escapeHtml } from "../util.js";
import { csrfInput, layout, type PageOptions } from "./layout.js";

export interface GuidedInboxSettingsPageData {
  options: PageOptions;
  csrfToken?: string;
  canWrite: boolean;
  stats: { totalRows: number; openPulls: number; repos: number; lastCacheWriteAt?: string };
}

export function renderGuidedInboxSettingsPage(data: GuidedInboxSettingsPageData): string {
  const body = `
    ${data.options.notice ? `<p class="notice if-banner if-banner--success" role="status">${escapeHtml(data.options.notice)}</p>` : ""}
    ${data.options.error ? `<p class="error if-banner if-banner--danger" role="alert">${escapeHtml(data.options.error)}</p>` : ""}
    <h1>Guided Review inbox</h1>
    <p class="lede">The inbox is webhook-cached so normal <a href="/guided">Guided Review</a> reads stay fast. Backfill reconciles every currently open pull request accessible to the configured GitHub App installations, including PRs opened before webhook caching was enabled.</p>
    <section class="card">
      <h2>Cache status</h2>
      <table>
        <tbody>
          <tr><th>Open pull requests cached</th><td>${data.stats.openPulls}</td></tr>
          <tr><th>Repositories represented</th><td>${data.stats.repos}</td></tr>
          <tr><th>Total cache rows</th><td>${data.stats.totalRows}</td></tr>
          <tr><th>Latest cache write</th><td>${data.stats.lastCacheWriteAt ? `<time datetime="${escapeHtml(data.stats.lastCacheWriteAt)}">${escapeHtml(data.stats.lastCacheWriteAt)}</time>` : `<span class="muted">Never</span>`}</td></tr>
        </tbody>
      </table>
    </section>
    <section class="card">
      <h2>Backfill and reconcile</h2>
      <p class="muted">This deliberately contacts GitHub, upserts all open pull requests into the webhook cache, and closes cached rows that are no longer open or no longer accessible. It does not backfill closed pull requests because the inbox is an open-review worklist. Depending on installation size this can take a minute.</p>
      ${data.canWrite ? `<form method="post" action="/config/guided-inbox/sync">${csrfInput(data.csrfToken)}<button type="submit" class="if-button if-button--primary">Backfill open pull requests</button></form>` : `<p class="muted">Operator access is required to run backfill.</p>`}
    </section>`;
  return layout("Guided Review inbox", body, { ...data.options, surface: "operator", nav: "settings", settingsSection: "guided-inbox" });
}
