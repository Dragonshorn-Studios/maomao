import { escapeHtml } from "../util.js";
import { CSRF_FIELD } from "../auth.js";
import type { FindingRow } from "../findings/types.js";
import { PRODUCT_TAGLINE } from "./copy.js";
import { brandMark } from "./glyphs.js";
import { THEME_HREF } from "./theme.js";

export interface PageOptions {
  showLogout?: boolean;
  live?: boolean;
  notice?: string;
  error?: string;
  reviewUrl?: string;
  prFindings?: FindingRow[];
  csrfToken?: string;
  identity?: { login: string; avatarUrl: string | null };
}

export function csrfInput(token: string | undefined): string {
  return token ? `<input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(token)}"/>` : "";
}

const APPEARANCE_BOOT = `
(function () {
  var KEY = "maomao-appearance";
  var params = new URLSearchParams(location.search);
  var mode = params.get("appearance") || localStorage.getItem(KEY) || "system";
  if (mode !== "light" && mode !== "dark" && mode !== "system") mode = "system";
  function resolved(m) {
    if (m === "light" || m === "dark") return m;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function apply(m) {
    var theme = resolved(m);
    document.documentElement.dataset.appearance = m;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }
  apply(mode);
  window.__maomaoAppearance = {
    key: KEY,
    apply: apply,
    get: function () { return document.documentElement.dataset.appearance || localStorage.getItem(KEY) || "system"; },
    set: function (m) { localStorage.setItem(KEY, m); apply(m); sync(); },
  };
  function sync() {
    var current = window.__maomaoAppearance.get();
    document.querySelectorAll("[data-appearance]").forEach(function (btn) {
      btn.setAttribute("aria-pressed", btn.getAttribute("data-appearance") === current ? "true" : "false");
    });
  }
  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("[data-appearance]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        window.__maomaoAppearance.set(btn.getAttribute("data-appearance"));
      });
    });
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) mq.addEventListener("change", function () {
      if (window.__maomaoAppearance.get() === "system") window.__maomaoAppearance.apply("system");
    });
    sync();
  });
})();
`.trim();

export function layout(title: string, body: string, options: PageOptions = {}): string {
  const live = options.live !== false;
  const logout = options.showLogout
    ? `<form method="post" action="/logout" class="logout">${csrfInput(options.csrfToken)}<button type="submit">Log out</button></form>`
    : "";
  const identity = options.identity
    ? `<span class="who">${options.identity.avatarUrl ? `<img class="who-avatar" src="${escapeHtml(options.identity.avatarUrl)}" alt="" width="20" height="20"/> ` : ""}signed in as <strong>${escapeHtml(options.identity.login)}</strong></span>`
    : "";
  const script = live
    ? `<script>
    if (!new URLSearchParams(location.search).has("static")) {
      const events = new EventSource("/events");
      events.addEventListener("message", () => {});
      events.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "hello") return;
          if (location.pathname === "/" && (data.type === "jobs" || data.type === "job")) {
            location.reload();
          }
          if (location.pathname.startsWith("/jobs/") && (data.type === "job" || data.type === "log")) {
            const id = Number(location.pathname.split("/")[2]);
            if (!data.jobId || data.jobId === id) location.reload();
          }
        } catch {}
      };
    }
  </script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="color-scheme" content="light dark"/>
  <meta name="description" content="Self-hosted multi-agent pull request review powered by OpenCode."/>
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${THEME_HREF}"/>
  <script>${APPEARANCE_BOOT}</script>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="top">
    <a class="brand" href="/">${brandMark()} Maomao</a>
    <span class="tag">${escapeHtml(PRODUCT_TAGLINE)}</span>
    <span class="grow"></span>
    <div class="appearance" role="group" aria-label="Appearance">
      <button type="button" data-appearance="light" aria-pressed="false">Light</button>
      <button type="button" data-appearance="dark" aria-pressed="false">Dark</button>
      <button type="button" data-appearance="system" aria-pressed="true">System</button>
    </div>
    <a class="top-link" href="/health">health</a>
    ${identity}
    ${logout}
  </header>
  <main id="main">${body}</main>
  ${script}
</body>
</html>`;
}
