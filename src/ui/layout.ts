import { escapeHtml } from "../util.js";
import { CSRF_FIELD } from "../auth.js";
import type { FindingRow } from "../findings/types.js";
import { PRODUCT_TAGLINE, type UiFlavor } from "./copy.js";
import { brandMark } from "./glyphs.js";
import { THEME_HREF } from "./theme.js";
import { PIERRE_DIFFS_HREF } from "./paths.js";

export interface UiIdentity {
  login: string;
  avatarUrl: string | null;
}

export interface PageOptions {
  showLogout?: boolean;
  live?: boolean;
  notice?: string;
  error?: string;
  reviewUrl?: string;
  prFindings?: FindingRow[];
  csrfToken?: string;
  identity?: UiIdentity;
  /** Latest reviewed head SHA for this pull request, for stale-finding detection. */
  prHeadSha?: string;
  uiFlavor?: UiFlavor;
  /** Pagination state; only the paginated home renders (including the POST /reviews error re-render) pass it. */
  pagination?: { hasOlder: boolean; hasNewer: boolean };
  /** Forge scopes with jobs; the filter chips render only when more than one exists. */
  forgeScopes?: Array<{ provider: string; instance: string }>;
  /** The active `provider:instance` filter key on the home page. */
  activeForge?: string;
  /**
   * Operator chrome (connections, config, health, chat, forms). Dashboard and
   * job overview stay on the default surface so their controls are untouched.
   */
  surface?: "default" | "operator";
  /** Login hides the account menu; every other page shows it. */
  accountMenu?: boolean;
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

/**
 * Pancake easter egg trigger. The home page renders a `.pancake-chip` carrying
 * the latest completed job id; a reload (often fired by the SSE handler below)
 * that reveals a newer id than the localStorage high-water mark plays the
 * drop animation once, then records the id. No chip (plain flavor, other
 * pages) means no script work.
 */
const PANCAKE_BOOT = `
(function () {
  function boot() {
    var chip = document.querySelector(".pancake-chip[data-pancake-latest]");
    if (!chip || chip.dataset.pancakeCount === "0") return;
    var latest = Number(chip.getAttribute("data-pancake-latest")) || 0;
    var KEY = "maomao-pancakes";
    var seen = 0;
    try { seen = Number(localStorage.getItem(KEY)) || 0; } catch {}
    if (latest <= seen) return;
    try { localStorage.setItem(KEY, String(latest)); } catch {}
    chip.classList.add("nom");
    setTimeout(function () { chip.classList.remove("nom"); }, 2000);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
`.trim();

const ACCOUNT_BOOT = `
(function () {
  function closeAll(except) {
    document.querySelectorAll("details.account-menu[open]").forEach(function (el) {
      if (el !== except) el.removeAttribute("open");
    });
  }
  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!(target instanceof Node)) return;
    var open = document.querySelector("details.account-menu[open]");
    if (open && !open.contains(target)) closeAll();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeAll();
  });
})();
`.trim();

function accountMenu(options: PageOptions): string {
  if (options.accountMenu === false) return "";
  const identity = options.identity;
  const avatar = identity?.avatarUrl
    ? `<img class="who-avatar" src="${escapeHtml(identity.avatarUrl)}" alt="" width="28" height="28"/>`
    : "";
  const label = identity ? escapeHtml(identity.login) : "Menu";
  const logout = options.showLogout
    ? `<form method="post" action="/logout" class="account-logout">${csrfInput(options.csrfToken)}<button type="submit">Log out</button></form>`
    : "";
  return `<details class="account-menu">
      <summary class="account-menu-summary" aria-label="Operator menu">
        ${avatar}<span class="account-name">${label}</span>
      </summary>
      <nav class="account-menu-panel" aria-label="Operator">
        <a href="/connections">Connections</a>
        <a href="/config#effective">Configuration</a>
        <a href="/health">Health</a>
        <a href="/scan">Scan</a>
        ${logout}
      </nav>
    </details>`;
}

export function layout(title: string, body: string, options: PageOptions = {}): string {
  const live = options.live !== false;
  const script = live
    ? `<script>
    if (!new URLSearchParams(location.search).has("static")) {
      // Guard against double submits: on any POST form submission, disable its
      // first submit button while the request navigates (responses are full
      // page loads, so it is never re-enabled here). Forms still work without
      // JS. Keep submit buttons nameless: a disabled submitter's name/value
      // would be dropped from the payload.
      document.addEventListener("submit", (event) => {
        const form = event.target;
        if (form.method !== "post") return;
        const button = form.querySelector('button[type="submit"]');
        if (button) button.disabled = true;
      });
      // Back/forward cache restores the old DOM with the disabled attribute;
      // re-enable so a restored page is not a dead end.
      window.addEventListener("pageshow", (event) => {
        if (event.persisted) {
          document.querySelectorAll('form button[type="submit"][disabled]').forEach((button) => {
            button.disabled = false;
          });
        }
      });
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
  <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml"/>
  <link rel="alternate icon" href="/assets/favicon.png"/>
  <link rel="apple-touch-icon" href="/assets/icon.png"/>
  <link rel="stylesheet" href="${THEME_HREF}"/>
  <script src="${PIERRE_DIFFS_HREF}" defer></script>
  <script>${APPEARANCE_BOOT}</script>
  <script>${PANCAKE_BOOT}</script>
  <script>${ACCOUNT_BOOT}</script>
</head>
<body${options.surface === "operator" ? ' class="operator"' : ""}>
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
    ${accountMenu(options)}
  </header>
  <main id="main">${body}</main>
  ${script}
</body>
</html>`;
}
