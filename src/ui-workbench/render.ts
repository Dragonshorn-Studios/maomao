/**
 * Workbench HTML: the gallery, the story chrome, and the sandboxed frame.
 *
 * The frame is where production markup lives. The surrounding pages are
 * workbench chrome and carry their own (small) stylesheet on top of Maomao's
 * real theme, so a preview looks like the app it came from.
 */
import { escapeHtml } from "../util.js";
import { VIEWPORTS, type ViewportName, type WorkbenchStory, type WorkbenchVariant } from "./contract.js";
import type { DesignTokens } from "./tokens.js";

export const WORKBENCH_BASE = "/dev/ui";

/** The theme the workbench chrome and its frames render in. */
export type Theme = "light" | "dark";

/** The URL of a story page. */
export function storyUrl(storyId: string, variantId?: string): string {
  return variantId ? `${WORKBENCH_BASE}/${storyId}/${variantId}` : `${WORKBENCH_BASE}/${storyId}`;
}

/** The URL of a variant's frame — the document a screenshot is taken of. */
export function frameUrl(storyId: string, variantId: string): string {
  return `${WORKBENCH_BASE}/${storyId}/${variantId}/frame`;
}

/**
 * The sandbox that every frame loads.
 *
 * The frame shows production markup, but it must never *act*: no form may
 * round-trip to the server, no link may navigate away from the preview, and
 * the only network call that can succeed is the workbench's own fake
 * endpoint. The fetch interceptor is the Sumomo mock, adapted to the chat
 * island's single allowlisted URL.
 */
export const FRAME_SANDBOX_JS = `
(function () {
  var ALLOWED = ["/dev/ui/fake/chat/stream"];
  function allowed(url) {
    for (var i = 0; i < ALLOWED.length; i++) {
      if (url === ALLOWED[i] || url.indexOf(ALLOWED[i] + "?") === 0) return true;
    }
    return false;
  }
  var originalFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input instanceof URL ? input.href : (input && input.url) || "";
    if (!allowed(url)) {
      return Promise.reject(new Error("UI workbench: network access is blocked for " + url));
    }
    return originalFetch.call(window, input, init);
  };
  document.addEventListener("submit", function (event) {
    // The frame is a preview: no form may round-trip to the server. The
    // capture phase blocks the native submit before any island handler runs;
    // a client-side handler (the chat composer) still receives the event.
    event.preventDefault();
  }, true);
  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") return;
    var anchor = target.closest("a");
    if (!anchor) return;
    var href = anchor.getAttribute("href") || "";
    if (href === "" || href.charAt(0) === "#") return;
    event.preventDefault();
  });
})();
`.trim();

const WORKBENCH_CSS = `
:root { --wb-gap: 0.9rem; }
body.workbench { background: var(--paper); color: var(--ink); font-family: var(--font-ui); }
.workbench-bar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.9rem;
  padding: 0.65rem 1.1rem; background: var(--surface);
  border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 5;
}
.workbench-bar h1 { font-size: 1rem; margin: 0; font-family: var(--font-display); }
.workbench-bar .grow { flex: 1 1 8rem; }
.workbench-chip {
  display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.1rem 0.5rem;
  border: 1px solid var(--line); border-radius: 999px; font-size: 0.72rem;
  letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-muted);
  font-family: var(--font-mono); white-space: nowrap;
}
.workbench-chip[aria-current="true"] { border-color: var(--jade); color: var(--ink); background: var(--jade-soft); }
.workbench-chip:hover { color: var(--ink); text-decoration: none; }
.workbench-main { padding: 1.2rem 1.35rem 3rem; max-width: 76rem; margin: 0 auto; }
.workbench-lede { color: var(--ink-muted); max-width: 46rem; }
.workbench-search {
  width: 100%; max-width: 26rem; padding: 0.45rem 0.6rem; margin: 0.8rem 0 1.2rem;
  background: var(--surface); color: var(--ink); border: 1px solid var(--line-strong);
}
.workbench-section { margin-bottom: 1.6rem; }
.workbench-section > h2 {
  font-family: var(--font-mono); font-size: 0.72rem; text-transform: uppercase;
  letter-spacing: 0.12em; color: var(--ash); border: 0; padding: 0; margin: 0 0 0.6rem;
}
.workbench-grid { display: grid; gap: 0.85rem; grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr)); }
.workbench-card {
  display: flex; flex-direction: column; gap: 0.55rem; padding: 0.8rem 0.9rem;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
}
.workbench-card h3 { margin: 0; font-size: 1rem; }
.workbench-card h3 a { color: var(--ink); text-decoration: none; }
.workbench-card h3 a:hover { color: var(--jade); text-decoration: underline; }
.workbench-card > .workbench-chip { align-self: flex-start; }
.workbench-variants { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.workbench-variants a {
  font-family: var(--font-mono); font-size: 0.72rem; padding: 0.05rem 0.45rem;
  border: 1px solid var(--line); border-radius: 999px; color: var(--ink-muted); text-decoration: none;
}
.workbench-variants a:hover { border-color: var(--jade); color: var(--ink); }
.workbench-sources {
  margin: 0; padding: 0.5rem 0 0; border-top: 1px solid var(--line);
  list-style: none; display: flex; flex-direction: column; gap: 0.15rem;
}
.workbench-sources li { font-family: var(--font-mono); font-size: 0.72rem; color: var(--ash); overflow-wrap: anywhere; }
.workbench-frame-shell { display: flex; gap: 1rem; align-items: flex-start; flex-wrap: wrap; }
.workbench-frame-shell iframe {
  border: 1px solid var(--line); background: var(--paper); border-radius: var(--radius);
}
.workbench-aside {
  flex: 1 1 16rem; min-width: 15rem; background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 0.8rem 0.9rem; display: flex; flex-direction: column; gap: 0.7rem;
}
.workbench-aside h2 {
  font-family: var(--font-mono); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--ash); border: 0; padding: 0; margin: 0;
}
.workbench-aside ul { margin: 0; padding-left: 1rem; }
.workbench-aside code { font-family: var(--font-mono); font-size: 0.78rem; overflow-wrap: anywhere; }
.workbench-empty { padding: 1.2rem; border: 1px dashed var(--line); color: var(--ink-muted); }
.workbench-token-grid { display: grid; gap: 0.7rem; grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr)); }
.workbench-token {
  display: flex; flex-direction: column; gap: 0.3rem; padding: 0.6rem 0.7rem;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
}
.workbench-token-name { margin: 0; font-family: var(--font-mono); font-size: 0.78rem; font-weight: 600; color: var(--ink); }
.workbench-token-value { margin: 0; font-family: var(--font-mono); font-size: 0.7rem; color: var(--ink-muted); overflow-wrap: anywhere; }
.workbench-token-specimen { margin: 0.2rem 0 0; font-size: 0.85rem; color: var(--ink); overflow-wrap: anywhere; }
.workbench-swatch-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 0.3rem; }
.workbench-swatch-pair > span {
  display: block; height: 2.6rem; border-radius: var(--radius);
  border: 1px solid var(--line);
}
.workbench-aside a { color: var(--jade); }
`;

/** The shell of the workbench's own pages (gallery, story chrome). */
function workbenchShell(
  title: string,
  body: string,
  options: { theme?: Theme; extraHead?: string } = {},
): string {
  const theme = options.theme ?? "light";
  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="robots" content="noindex"/>
  <title>${escapeHtml(title)} · Maomao UI workbench</title>
  <link rel="stylesheet" href="/assets/maomao.css"/>
  <style>${WORKBENCH_CSS}</style>
  ${options.extraHead ?? ""}
</head>
<body class="workbench">
${body}
</body>
</html>`;
}

function chip(label: string, href: string, current: boolean): string {
  return `<a class="workbench-chip" href="${escapeHtml(href)}"${current ? ' aria-current="true"' : ""}>${escapeHtml(label)}</a>`;
}

/** The gallery: every story, grouped by category, searchable in the browser. */
export function renderGallery(stories: WorkbenchStory[], theme: Theme = "light"): string {
  const grouped = new Map<string, WorkbenchStory[]>();
  for (const story of stories) {
    const bucket = grouped.get(story.category);
    if (bucket) bucket.push(story);
    else grouped.set(story.category, [story]);
  }

  const sections = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, categoryStories]) => {
      const cards = categoryStories
        .map((story) => {
          const search = [story.id, story.title, story.category, story.family]
            .join(" ")
            .toLowerCase();
          const variants = story.variants
            .map(
              (variant) =>
                `<a href="${escapeHtml(storyUrl(story.id, variant.id))}">${escapeHtml(variant.title)}</a>`,
            )
            .join("");
          const sources = story.sourceFiles
            .map((file) => `<li>${escapeHtml(file)}</li>`)
            .join("");
          return `<article class="workbench-card" data-search="${escapeHtml(search)}">
  <h3><a href="${escapeHtml(storyUrl(story.id))}">${escapeHtml(story.title)}</a></h3>
  <span class="workbench-chip">${escapeHtml(story.family)}</span>
  <div class="workbench-variants">${variants}</div>
  <ul class="workbench-sources">${sources}</ul>
</article>`;
        })
        .join("");
      return `<section class="workbench-section">
  <h2>${escapeHtml(category)}</h2>
  <div class="workbench-grid">${cards}</div>
</section>`;
    })
    .join("");

  const body = `<header class="workbench-bar">
  <h1>Maomao UI workbench</h1>
  <span class="grow"></span>
  ${chip("design tokens", `${WORKBENCH_BASE}/tokens?theme=${theme}`, false)}
  ${chip("light", `${WORKBENCH_BASE}?theme=light`, theme === "light")}
  ${chip("dark", `${WORKBENCH_BASE}?theme=dark`, theme === "dark")}
  <a class="workbench-chip" href="${WORKBENCH_BASE}/catalog.json">catalog.json</a>
</header>
<main class="workbench-main">
  <p class="workbench-lede">Dev-only gallery of Maomao's real server-rendered pages, components, and React islands. Every preview runs on deterministic fixtures — no job is started and no model is called.</p>
  <input class="workbench-search" id="workbench-search" type="search" placeholder="Filter stories" aria-label="Filter stories"/>
  ${sections || '<p class="workbench-empty">No stories registered.</p>'}
</main>
<script>
(function () {
  var input = document.getElementById("workbench-search");
  var cards = document.querySelectorAll("[data-search]");
  var sections = document.querySelectorAll(".workbench-section");
  if (!input) return;
  input.addEventListener("input", function () {
    var query = input.value.trim().toLowerCase();
    cards.forEach(function (card) {
      var haystack = card.getAttribute("data-search") || "";
      card.style.display = query === "" || haystack.indexOf(query) >= 0 ? "" : "none";
    });
    // A category whose stories are all filtered out disappears with them.
    sections.forEach(function (section) {
      var visible = section.querySelectorAll('[data-search]:not([style*="display: none"])').length;
      section.style.display = visible > 0 ? "" : "none";
    });
  });
})();
</script>`;

  return workbenchShell("Gallery", body, { theme });
}

/** The design tokens of the app, parsed from the theme CSS. */
export function renderTokensPage(tokens: DesignTokens, theme: Theme = "light"): string {
  const groups = tokens.groups
    .map((group) => {
      const cards = group.tokens
        .map((token) => {
          const name = `--${token.name}`;
          const values = [
            `<p class="workbench-token-value" title="light">${escapeHtml(token.resolvedLight)}</p>`,
            token.resolvedDark !== token.resolvedLight
              ? `<p class="workbench-token-value" title="dark">${escapeHtml(token.resolvedDark)}</p>`
              : "",
          ]
            .filter(Boolean)
            .join("");

          const preview =
            token.kind === "color"
              ? `<div class="workbench-swatch-pair">
    <span class="workbench-token-light" style="background: var(${name})" title="light"></span>
    <span class="workbench-token-dark" style="background: var(${name})" title="dark"></span>
  </div>`
              : token.kind === "font"
                ? `<p class="workbench-token-specimen" style="font-family: var(${name})">The quick brown fox 0123456789</p>`
                : token.kind === "space"
                  ? `<p class="workbench-token-specimen">${escapeHtml(token.resolvedLight)}</p>`
                  : "";

          return `<article class="workbench-token">
  ${preview}
  <p class="workbench-token-name">${escapeHtml(name)}</p>
  ${values}
</article>`;
        })
        .join("");

      return `<section class="workbench-section">
  <h2>${escapeHtml(group.title)}</h2>
  <div class="workbench-token-grid">${cards}</div>
</section>`;
    })
    .join("");

  const body = `<header class="workbench-bar">
  <a class="workbench-chip" href="${WORKBENCH_BASE}?theme=${theme}">← gallery</a>
  <h1>Design tokens</h1>
  <span class="workbench-chip">src/ui/theme.ts</span>
  <span class="grow"></span>
  ${chip("light", `${WORKBENCH_BASE}/tokens?theme=light`, theme === "light")}
  ${chip("dark", `${WORKBENCH_BASE}/tokens?theme=dark`, theme === "dark")}
</header>
<main class="workbench-main">
  <p class="workbench-lede">The app's design tokens, parsed from the theme stylesheet. Every swatch shows the token in both themes.</p>
  ${groups || '<p class="workbench-empty">No tokens found.</p>'}
</main>`;

  // The swatches carry their own token set, so they render the light and the
  // dark value side by side whatever the page's own theme is.
  const tokenStyles = `<style>
.workbench-token-light {
${tokens.lightCss}
}
.workbench-token-dark {
${tokens.darkCss}
}
</style>`;

  return workbenchShell("Design tokens", body, { theme, extraHead: tokenStyles });
}

/** The story chrome: variant links, viewport presets, and the frame. */
export function renderStoryPage(
  story: WorkbenchStory,
  variant: WorkbenchVariant,
  viewport: ViewportName,
  theme: Theme,
  frozen: boolean,
  composition: { uses: WorkbenchStory[]; usedBy: WorkbenchStory[] } = { uses: [], usedBy: [] },
): string {
  const preset = VIEWPORTS[viewport];
  const query = new URLSearchParams();
  query.set("viewport", viewport);
  query.set("theme", theme);
  if (frozen) query.set("frozen", "1");

  const variantLinks = story.variants
    .map((candidate) =>
      chip(
        candidate.title,
        `${storyUrl(story.id, candidate.id)}?${query.toString()}`,
        candidate.id === variant.id,
      ),
    )
    .join("");
  const viewportLinks = (Object.keys(VIEWPORTS) as ViewportName[])
    .map((name) =>
      chip(
        name,
        `?viewport=${name}&theme=${theme}${frozen ? "&frozen=1" : ""}`,
        name === viewport,
      ),
    )
    .join("");
  const themeLinks = (["light", "dark"] as const)
    .map((name) =>
      chip(name, `?viewport=${viewport}&theme=${name}${frozen ? "&frozen=1" : ""}`, name === theme),
    )
    .join("");

  const sources = story.sourceFiles.map((file) => `<li><code>${escapeHtml(file)}</code></li>`).join("");
  const notes = [
    story.notes ? `<p>${escapeHtml(story.notes)}</p>` : "",
    variant.notes ? `<p>${escapeHtml(variant.notes)}</p>` : "",
  ]
    .filter(Boolean)
    .join("");

  const usesList = composition.uses
    .map((used) => `<li><a href="${escapeHtml(storyUrl(used.id))}">${escapeHtml(used.title)}</a></li>`)
    .join("");
  const usedByList = composition.usedBy
    .map((user) => `<li><a href="${escapeHtml(storyUrl(user.id))}">${escapeHtml(user.title)}</a></li>`)
    .join("");

  const body = `<header class="workbench-bar">
  <a class="workbench-chip" href="${WORKBENCH_BASE}">← gallery</a>
  <h1>${escapeHtml(story.title)}</h1>
  <span class="workbench-chip">${escapeHtml(story.id)}/${escapeHtml(variant.id)}</span>
  <span class="grow"></span>
  ${variantLinks}
  ${viewportLinks}
  ${themeLinks}
  ${frozen ? '<span class="workbench-chip" aria-current="true">frozen</span>' : ""}
</header>
<main class="workbench-main">
  <div class="workbench-frame-shell">
    <iframe src="${escapeHtml(`${frameUrl(story.id, variant.id)}?${query.toString()}`)}" title="${escapeHtml(story.title)} · ${escapeHtml(variant.title)}" width="${preset.width}" height="${preset.height}" style="max-width:100%"></iframe>
    <aside class="workbench-aside">
      <section>
        <h2>Source files</h2>
        <ul>${sources}</ul>
      </section>
      ${usesList ? `<section><h2>Uses</h2><ul>${usesList}</ul></section>` : ""}
      ${usedByList ? `<section><h2>Used by</h2><ul>${usedByList}</ul></section>` : ""}
      ${notes ? `<section><h2>Notes</h2>${notes}</section>` : ""}
      <section>
        <h2>Frame URL</h2>
        <ul><li><code>${escapeHtml(frameUrl(story.id, variant.id))}</code></li></ul>
      </section>
    </aside>
  </div>
</main>`;

  return workbenchShell(`${story.title} · ${variant.title}`, body, { theme });
}

export interface FrameOptions {
  frozen: boolean;
  theme: Theme;
  viewport: ViewportName;
  /** Extra script tags for the frame head (vendor bundles that exist). */
  headScripts?: string[];
}

/**
 * The frame document: production markup inside the app's real theme.
 *
 * The body is the story's own fragment — nothing is rewritten — and the
 * sandbox script keeps the preview inert.
 */
export function renderFrame(
  story: WorkbenchStory,
  variant: WorkbenchVariant,
  fragment: string,
  options: FrameOptions,
): string {
  const scripts = (options.headScripts ?? []).join("\n");
  const frozenStyle = options.frozen
    ? `<style>[data-workbench-frozen] *, [data-workbench-frozen] *::before, [data-workbench-frozen] *::after {
  animation-play-state: paused !important;
  transition: none !important;
  caret-color: transparent !important;
}</style>`
    : "";

  return `<!doctype html>
<html lang="en" data-theme="${options.theme}"${options.frozen ? ' data-workbench-frozen="1"' : ""}>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="robots" content="noindex"/>
  <title>${escapeHtml(story.title)} · ${escapeHtml(variant.title)}</title>
  <link rel="stylesheet" href="/assets/maomao.css"/>
  ${frozenStyle}
  ${scripts}
</head>
<body${options.frozen ? " data-workbench-frozen" : ""} data-workbench-story="${escapeHtml(story.id)}" data-workbench-variant="${escapeHtml(variant.id)}" data-workbench-family="${escapeHtml(story.family)}" data-workbench-viewport="${escapeHtml(options.viewport)}">
<main id="main">${fragment}</main>
<script>${FRAME_SANDBOX_JS}</script>
</body>
</html>`;
}
