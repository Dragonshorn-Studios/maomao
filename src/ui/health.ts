/**
 * Operator HTML for process health. JSON remains the default at GET /health
 * (probes); browsers that ask for HTML get this page. No secrets.
 */
import { escapeHtml, formatDuration } from "../util.js";
import { layout, type PageOptions } from "./layout.js";

export interface HealthPageData {
  ok: boolean;
  uptimeSec: number;
  service: string;
  options?: PageOptions;
}

export function renderHealthPage(data: HealthPageData): string {
  const status = data.ok
    ? `<span class="state state-completed">ok</span>`
    : `<span class="state state-failed">down</span>`;
  const body = `
    <h1>Health</h1>
    <p class="lede">Process liveness for this Maomao instance. Probes that do not ask for HTML still receive JSON.</p>
    <dl class="meta-grid">
      <div>
        <dt>Status</dt>
        <dd>${status}</dd>
      </div>
      <div>
        <dt>Service</dt>
        <dd><code>${escapeHtml(data.service)}</code></dd>
      </div>
      <div>
        <dt>Uptime</dt>
        <dd class="metric">${escapeHtml(formatDuration(data.uptimeSec * 1000))}</dd>
      </div>
    </dl>
    <p class="muted">Machine-readable: <a href="/health?json=1"><code>GET /health?json=1</code></a></p>`;
  return layout("Health", body, { live: false, surface: "operator", ...data.options });
}
