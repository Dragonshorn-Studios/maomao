import { escapeHtml } from "../util.js";
import { CSRF_FIELD } from "../auth.js";
import type { FindingRow } from "../findings/types.js";
import { OPERATOR_NAME, PRODUCT_DESCRIPTION, PRODUCT_NAME, PRODUCT_TAGLINE, type UiFlavor } from "./copy.js";
import { mergehennaMark, operatorMark } from "./glyphs.js";
import { THEME_URL } from "./theme.js";
import { INFERNAL_URL } from "./infernal.js";
import { diskAssetUrl, PIERRE_DIFFS_HREF } from "./paths.js";
import { FAVICON_SVG_URL, FAVICON_PNG_URL, ICON_PNG_URL } from "./icons.js";

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
  /** Active family view of the home queue; the view tabs render only on home. */
  queueView?: { active: QueueView };
  /** Forge scopes with jobs; the filter chips render only when more than one exists. */
  forgeScopes?: Array<{ provider: string; instance: string }>;
  /** The active `provider:instance` filter key on the home page. */
  activeForge?: string;
  /** Superseded (stale) job visibility on the home page: `active` means the
   * list includes stale rows; `hidden` is the count filtered out otherwise. */
  superseded?: { active: boolean; hidden: number };
  /** Repository + job-type selects on the home page: `repos` is the option
   * list, `repo`/`type` the active filter values. */
  jobFilters?: { repos: string[]; repo?: string; type?: string };
  /** /reviewers board: active run-state filter and offset pagination. */
  runFilters?: { state?: string };
  runPagination?: { page: number; pageSize: number; total: number };
  /**
   * Operator chrome (connections, config, health, chat, forms). Dashboard and
   * job overview stay on the default surface so their controls are untouched.
   */
  surface?: "default" | "operator";
  /** Login hides the account menu; every other page shows it. */
  accountMenu?: boolean;
  /** The rail area the page belongs to; the matching rail button renders active. */
  nav?: NavArea;
  /** Active entry of the settings context navigation; setting it also opens
   * the shell's second column (the settings side nav). */
  settingsSection?: SettingsSection;
  /** Recently viewed jobs for the shell's second column on monitoring
   * surfaces — the triangular queue → job → runs workflow benefits from a
   * persistent jump-back list. Settings pages win the column when both are
   * set; an empty list renders no panel. */
  recentJobs?: Array<{ id: number; title: string; state: string }>;
  /** Login renders without the rail: there is nowhere useful to navigate to. */
  rail?: boolean;
}

/** Top-level product areas shown in the shell's icon rail. */
export type NavArea = "queue" | "operations" | "reviewers" | "settings" | "health";

/** The home queue's family split: the merge queue is the default surface,
 * operations collects scans and briefs, `all` is the undivided history. */
export type QueueView = "merge" | "ops" | "all";

/** Ids of the settings context-navigation entries. Superset of the old inline
 * config sub-nav: connections and health join the operator surfaces here. */
export type SettingsSection =
  | "effective"
  | "profiles"
  | "providers"
  | "telemetry"
  | "trusted-checks"
  | "merge-modes"
  | "prompts"
  | "audit"
  | "deliveries"
  | "connections"
  | "health";

const SETTINGS_NAV: Array<{ group: string; items: Array<[SettingsSection, string, string]> }> = [
  {
    group: "Review configuration",
    items: [
      ["effective", "/config", "Effective configuration"],
      ["profiles", "/config/profiles", "Profiles"],
      ["prompts", "/config/prompts", "Specialist prompts"],
      ["trusted-checks", "/config/trusted-checks", "Trusted checks"],
      ["merge-modes", "/config/merge-modes", "Merge modes"],
    ],
  },
  {
    group: "Integrations",
    items: [
      ["providers", "/config/providers", "Provider keys"],
      ["connections", "/connections", "Forge connections"],
    ],
  },
  {
    group: "Operations",
    items: [
      ["telemetry", "/config/telemetry", "Telemetry"],
      ["audit", "/config/audit", "Audit"],
      ["deliveries", "/config/deliveries", "Deliveries"],
      ["health", "/health", "Health"],
    ],
  },
];

/** Primary destinations, top to bottom in the rail. The rail is purely
 * monitoring surfaces — the merge queue, the operations jobs, the reviewer
 * runs board. The scan/brief trigger pages are actions and live on the
 * operations surface instead of competing with watching surfaces here. */
const RAIL_ITEMS: Array<[NavArea, string, string, string]> = [
  // [area, href, label, glyph]
  ["queue", "/", "Merge queue", "▤"],
  ["operations", "/?view=ops", "Operations", "⌗"],
  ["reviewers", "/reviewers", "Reviewer runs", "◈"],
];

/** Utility destinations pinned to the rail's bottom. */
const RAIL_UTILITIES: Array<[NavArea, string, string, string]> = [
  ["settings", "/config", "Settings", "⚙"],
  ["health", "/health", "Health", "♡"],
];

export function csrfInput(token: string | undefined): string {
  return token ? `<input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(token)}"/>` : "";
}

export interface GlobalPauseInfo {
  actor: string;
  since: string;
}

let globalPauseProvider: (() => GlobalPauseInfo | undefined) | undefined;

/**
 * Wired once at app start so every page renders the global pause banner
 * without each render call site plumbing the store through itself.
 * Tests set and clear this around each case.
 */
export function setGlobalPauseProvider(provider: (() => GlobalPauseInfo | undefined) | undefined): void {
  globalPauseProvider = provider;
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
    // The vendored Infernal SaaS stylesheet keys its tokens off data-if-theme.
    document.documentElement.dataset.ifTheme = theme;
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

function railItem(options: PageOptions, [area, href, label, glyph]: [NavArea, string, string, string]): string {
  const active = options.nav === area;
  return `<a class="if-rail__button${active ? " is-active" : ""}" href="${href}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"${
    active ? ' aria-current="page"' : ""
  }>${glyph}</a>`;
}

/** The shell's first column: icon rail with product areas, utilities pinned low. */
function railHtml(options: PageOptions): string {
  return `<nav class="shell-rail if-rail" aria-label="Product areas">
    <a class="if-rail__logo shell-rail__logo" href="/" title="${escapeHtml(PRODUCT_NAME)} — operated by ${escapeHtml(OPERATOR_NAME)}" aria-label="${escapeHtml(PRODUCT_NAME)} home">${mergehennaMark()}</a>
    ${RAIL_ITEMS.map((entry) => railItem(options, entry)).join("\n    ")}
    <span class="if-rail__spacer"></span>
    ${RAIL_UTILITIES.map((entry) => railItem(options, entry)).join("\n    ")}
  </nav>`;
}

/** The shell's optional second column: the settings side navigation. */
function settingsContextNav(active: SettingsSection): string {
  const groups = SETTINGS_NAV.map(({ group, items }) => {
    const links = items
      .map(([id, href, label]) => {
        const isActive = id === active;
        return `<a class="if-context-nav__item${isActive ? " is-active" : ""}" href="${href}"${
          isActive ? ' aria-current="page"' : ""
        }><span>${escapeHtml(label)}</span></a>`;
      })
      .join("\n      ");
    return `<div class="if-context-nav__section">${escapeHtml(group)}</div>\n      ${links}`;
  }).join("\n      ");
  return `<nav class="shell-context if-context-nav" aria-label="Settings navigation">
    <div class="if-context-nav__head"><span class="if-context-nav__title">Settings</span></div>
    <div class="if-context-nav__scroll">
      ${groups}
    </div>
  </nav>`;
}

/** The shell's second column on monitoring surfaces: recently viewed jobs,
 * most-recent first, with a state glance so a stale entry is obvious. */
function recentContextNav(jobs: Array<{ id: number; title: string; state: string }>): string {
  const links = jobs
    .map(
      (job) =>
        `<a class="if-context-nav__item recent-job" href="/jobs/${job.id}"><span class="recent-job__title">${escapeHtml(job.title)}</span><span class="recent-job__state" data-state="${escapeHtml(job.state)}">${escapeHtml(job.state)}</span></a>`,
    )
    .join("\n      ");
  return `<nav class="shell-context if-context-nav" aria-label="Recently viewed jobs">
    <div class="if-context-nav__head"><span class="if-context-nav__title">Recently viewed</span></div>
    <div class="if-context-nav__scroll">
      ${links}
    </div>
  </nav>`;
}

function accountMenu(options: PageOptions): string {
  if (options.accountMenu === false) return "";
  const identity = options.identity;
  const signedIn = Boolean(identity) || Boolean(options.showLogout);
  const label = identity?.login
    ? escapeHtml(identity.login)
    : signedIn
      ? "Operator"
      : "Menu";
  const avatar = identity?.avatarUrl
    ? `<img class="who-avatar" src="${escapeHtml(identity.avatarUrl)}" alt="" width="28" height="28"/>`
    : signedIn
      ? `<span class="who-glyph" aria-hidden="true">${operatorMark()}</span>`
      : "";
  const who = signedIn ? `<p class="account-who">${label}</p>` : "";
  const logout = options.showLogout
    ? `<form method="post" action="/logout" class="account-logout">${csrfInput(options.csrfToken)}<button type="submit">Log out</button></form>`
    : "";
  return `<details class="account-menu">
      <summary class="account-menu-summary" aria-label="${signedIn ? `Signed in as ${label}` : "Operator menu"}">
        ${avatar}<span class="account-name">${label}</span>
      </summary>
      <nav class="account-menu-panel" aria-label="Operator">
        ${who}
        <a href="/reviewers">Reviewers</a>
        <a href="/connections">Connections</a>
        <a href="/config#effective">Configuration</a>
        <a href="/health">Health</a>
        <a href="/scan">Scan</a>
        <a href="/brief">Brief</a>
        <a href="/pause">Pause</a>
        ${logout}
      </nav>
    </details>`;
}

/** The `<main>` markers of the shell below. */
const MAIN_OPEN = '<main id="main">';
const MAIN_CLOSE = "</main>";

/**
 * The `<main>` body of a page rendered by `layout`, without the app chrome.
 *
 * The dev-only UI workbench frames one component at a time; extracting the
 * marker here keeps it next to the code that writes it, so a change to the
 * shell cannot silently break the frames.
 */
export function layoutBody(html: string): string {
  const start = html.indexOf(MAIN_OPEN);
  const end = html.lastIndexOf(MAIN_CLOSE);
  if (start < 0 || end < start) return "";
  return html.slice(start + MAIN_OPEN.length, end);
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
  const rail = options.rail !== false;
  const contextNav = options.settingsSection
    ? settingsContextNav(options.settingsSection)
    : options.recentJobs?.length
      ? recentContextNav(options.recentJobs)
      : "";
  return `<!doctype html>
<html lang="en" data-if-brand="mergehenna">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="color-scheme" content="light dark"/>
  <meta name="description" content="${escapeHtml(PRODUCT_DESCRIPTION)}"/>
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="${FAVICON_SVG_URL}" type="image/svg+xml"/>
  <link rel="alternate icon" href="${FAVICON_PNG_URL}"/>
  <link rel="apple-touch-icon" href="${ICON_PNG_URL}"/>
  <link rel="stylesheet" href="${INFERNAL_URL}"/>
  <link rel="stylesheet" href="${THEME_URL}"/>
  <script src="${diskAssetUrl(PIERRE_DIFFS_HREF)}" defer></script>
  <script>${APPEARANCE_BOOT}</script>
  <script>${PANCAKE_BOOT}</script>
  <script>${ACCOUNT_BOOT}</script>
</head>
<body${options.surface === "operator" ? ' class="operator"' : ""}>
  <a class="skip" href="#main">Skip to content</a>
  <div class="shell${rail ? "" : " shell--railless"}${contextNav ? " has-context" : ""}">
    ${rail ? railHtml(options) : ""}
    ${contextNav}
    <div class="shell-content">
      <header class="top">
        <a class="brand" href="/"><img class="brand-mark" src="${FAVICON_SVG_URL}" width="28" height="28" alt=""/><span class="brand-text"><span class="brand-name">${escapeHtml(PRODUCT_NAME)}</span><span class="brand-caption">operated by ${escapeHtml(OPERATOR_NAME)}</span></span></a>
        <span class="tag">${escapeHtml(PRODUCT_TAGLINE)}</span>
        <span class="grow"></span>
        <div class="appearance" role="group" aria-label="Appearance">
          <button type="button" data-appearance="light" aria-pressed="false">Light</button>
          <button type="button" data-appearance="dark" aria-pressed="false">Dark</button>
          <button type="button" data-appearance="system" aria-pressed="true">System</button>
        </div>
        ${accountMenu(options)}
      </header>
      ${(() => {
        const pause = globalPauseProvider?.();
        return pause
          ? `<div class="pause-banner" role="status">Reviews paused by ${escapeHtml(pause.actor)} — no reviews will be enqueued or run. <a href="/pause">Manage</a></div>`
          : "";
      })()}
      ${MAIN_OPEN}${body}${MAIN_CLOSE}
    </div>
  </div>
  ${script}
</body>
</html>`;
}
