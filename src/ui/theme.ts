/** Visual tokens and CSS for the monitoring UI. Orchestration does not import this. */

import { versionedUrl } from "./paths.js";

export const THEME_HREF = "/assets/maomao.css";

export const THEME_CSS = `
/*
 * Theme packs are composed on top of the vendored Infernal SaaS stylesheet
 * (assets/infernal.css, loaded before this one): data-if-theme and
 * data-if-brand on the root element resolve the base --if-* tokens. Product
 * packs may override those tokens here without editing the vendored library.
 * The app's historical token names map onto the library so existing components
 * pick up the active pack without rewrites. Interactive chrome uses --action*;
 * semantic state colors keep their own names so a completed state never reads
 * as a clickable accent.
 */
:root {
  --paper: var(--if-bg);
  --surface: var(--if-surface);
  --surface-2: var(--if-surface-2);
  --ink: var(--if-text);
  --ink-muted: var(--if-text-soft);
  --jade: var(--if-success);
  --jade-soft: var(--if-success-soft);
  --herb: var(--if-success);
  --plum: var(--if-accent);
  --plum-soft: var(--if-accent-soft);
  --cinnabar: var(--if-danger);
  --cinnabar-soft: var(--if-danger-soft);
  --amber: var(--if-warning);
  --amber-soft: var(--if-warning-soft);
  --working: var(--if-accent);
  --working-soft: var(--if-accent-soft);
  --action: var(--if-accent);
  --action-ink: var(--if-accent-ink);
  --action-soft: var(--if-accent-soft);
  --ash: var(--if-muted);
  --muted: var(--if-muted);
  --ink-weak: var(--if-text-soft);
  --ink-soft: var(--if-text-soft);
  --rule: var(--if-line);
  --well: var(--if-bg-raised);
  --font-body: var(--if-font);
  --line: var(--if-line);
  --line-strong: var(--if-line-strong);
  --focus: var(--if-accent);
  --shadow: var(--if-shadow);
  --code-bg: var(--if-bg);
  --code-fg: var(--if-text);
  --live: var(--working);
  --btn-fg: var(--if-accent-ink);
  --chat-thought: var(--plum);
  --radius: var(--if-radius-sm);
  --font-display: var(--if-display);
  --font-ui: var(--if-font);
  --font-mono: var(--if-mono);
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2.25rem;
  --measure: 72rem;

}

/* Apothecary is the base Maomao pack: the pre-rebrand parchment/jade palette
   restated in Infernal token space. These rules intentionally live here rather
   than in the vendored infernal.css library. */
[data-if-brand="apothecary"] {
  --if-bg: #121612;
  --if-bg-raised: #1a1f1a;
  --if-surface: #1a1f1a;
  --if-surface-2: #232a23;
  --if-surface-hover: #2b332b;
  --if-line: #2e352e;
  --if-line-strong: #4a524a;
  --if-text: #e8e4d6;
  --if-text-soft: #a8a494;
  --if-muted: #8c8a7e;
  --if-accent: #7dcea0;
  --if-accent-ink: #121612;
  --if-accent-soft: #1c3328;
  --if-accent-line: #3f6b52;
  --if-success: #7dcea0;
  --if-success-soft: #1c3328;
  --if-warning: #e0b45c;
  --if-warning-soft: #3a3220;
  --if-danger: #e88989;
  --if-danger-soft: #3a2224;
  --if-info: #9dbbe0;
  --if-info-soft: #223242;
  --if-shadow: 0 1px 0 rgba(0, 0, 0, 0.25);
  --code-bg: #0e120e;
  --code-fg: #d9d4c4;
  --if-radius-sm: 3px;
  --if-radius: 3px;
  --if-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --if-mono: ui-monospace, "SFMono-Regular", "Cascadia Mono", "Cascadia Code", "Liberation Mono", Menlo, Monaco, Consolas, monospace;
  --if-display: "Iowan Old Style", Palatino, "Palatino Linotype", "Book Antiqua", Georgia, "Times New Roman", serif;
}
[data-if-brand="apothecary"][data-if-theme="light"] {
  --if-bg: #f3efe3;
  --if-bg-raised: #faf7ee;
  --if-surface: #faf7ee;
  --if-surface-2: #ece6d6;
  --if-surface-hover: #e4ddca;
  --if-line: #cfc8b6;
  --if-line-strong: #b7b09c;
  --if-text: #1a221c;
  --if-text-soft: #5a6258;
  --if-muted: #7a776b;
  --if-accent: #1f6a4e;
  --if-accent-ink: #f3efe3;
  --if-accent-soft: #d5eadc;
  --if-accent-line: #9fc9b3;
  --if-success: #1f6a4e;
  --if-success-soft: #d5eadc;
  --if-warning: #8a5a10;
  --if-warning-soft: #f1e4c4;
  --if-danger: #9c2432;
  --if-danger-soft: #f3d6d6;
  --if-info: #2f5d88;
  --if-info-soft: #dfe9f1;
  --if-shadow: 0 1px 0 rgba(26, 34, 28, 0.04);
  --code-bg: #eae4d4;
  --code-fg: #1a221c;
}
[data-if-brand="apothecary"][data-if-theme="light"] body {
  background: repeating-linear-gradient(to bottom, transparent 0, transparent calc(1.4rem - 1px), color-mix(in srgb, var(--line) 32%, transparent) calc(1.4rem - 1px), color-mix(in srgb, var(--line) 32%, transparent) 1.4rem), var(--paper);
}
[data-if-brand="apothecary"][data-if-theme="dark"] body,
[data-if-brand="apothecary"]:not([data-if-theme]) body {
  background: repeating-linear-gradient(to bottom, transparent 0, transparent calc(1.4rem - 1px), color-mix(in srgb, var(--line) 32%, transparent) calc(1.4rem - 1px), color-mix(in srgb, var(--line) 32%, transparent) 1.4rem), var(--paper);
}

/* Infernal's component library hardcodes part of its SaaS geometry and dark
   code wells. Apothecary keeps circular affordances circular, but otherwise
   returns rectangular surfaces, controls, navigation, and code blocks to the
   base Maomao geometry instead of letting those library values leak through. */
[data-if-brand="apothecary"] .if-badge,
[data-if-brand="apothecary"] .if-tabs,
[data-if-brand="apothecary"] .if-tab,
[data-if-brand="apothecary"] .if-progress,
[data-if-brand="apothecary"] .if-avatar,
[data-if-brand="apothecary"] .if-activity,
[data-if-brand="apothecary"] .if-skeleton,
[data-if-brand="apothecary"] .if-dialog,
[data-if-brand="apothecary"] .if-popover,
[data-if-brand="apothecary"] .if-menu-item,
[data-if-brand="apothecary"] .if-brand__mark,
[data-if-brand="apothecary"] .if-nav-link,
[data-if-brand="apothecary"] .if-stack-track a,
[data-if-brand="apothecary"] .if-stack-track span,
[data-if-brand="apothecary"] .if-reviewer-card,
[data-if-brand="apothecary"] .if-reviewer-card__icon,
[data-if-brand="apothecary"] .if-finding,
[data-if-brand="apothecary"] .if-tool-card,
[data-if-brand="apothecary"] .if-approval,
[data-if-brand="apothecary"] .if-metric-strip,
[data-if-brand="apothecary"] .if-command-list,
[data-if-brand="apothecary"] .if-log,
[data-if-brand="apothecary"] .if-screen-preview,
[data-if-brand="apothecary"] .if-rail-layout,
[data-if-brand="apothecary"] .if-rail__logo,
[data-if-brand="apothecary"] .if-rail__button,
[data-if-brand="apothecary"] .if-context-nav__item {
  border-radius: 3px;
}
[data-if-brand="apothecary"] .if-chat__bubble {
  border-radius: 3px;
}
[data-if-brand="apothecary"] .if-avatar--round {
  border-radius: 50%;
}
[data-if-brand="apothecary"] .if-code,
[data-if-brand="apothecary"] .if-diff,
[data-if-brand="apothecary"] .if-log {
  background: var(--code-bg);
  border-color: var(--line);
  color: var(--code-fg);
}

[data-if-brand="apothecary"] .appearance {
  border-radius: 0;
  padding: 0.1rem;
  gap: 0.1rem;
}
[data-if-brand="apothecary"] .appearance button {
  border-radius: 0;
  font-size: 0.75rem;
  font-weight: inherit;
}

[data-if-brand="apothecary"] .state,
[data-if-brand="apothecary"] .kind-chip,
[data-if-brand="apothecary"] .sev {
  border-radius: 0;
}

/* The pre-Infernal UI was flat parchment: rectangular controls, no floating
   hover lift, and live work marked by a thin side rule rather than a copper
   glow pooled under the card. Keep those effects exclusive to mergehenna. */
[data-if-brand="apothecary"] .if-button,
[data-if-brand="apothecary"] .if-input,
[data-if-brand="apothecary"] .if-select,
[data-if-brand="apothecary"] .if-textarea,
[data-if-brand="apothecary"] .if-rail__button[aria-pressed="true"]::before {
  border-radius: 0;
}
[data-if-brand="apothecary"] .if-card--interactive:hover {
  transform: none;
}
[data-if-brand="apothecary"] .if-card--ember::before,
[data-if-brand="apothecary"] .if-card--ember::after,
[data-if-brand="apothecary"] .if-stack-review::before,
[data-if-brand="apothecary"] .if-stack-review::after,
[data-if-brand="apothecary"] .if-panel:has(#build-progress)::before,
[data-if-brand="apothecary"] .if-panel:has(#build-progress)::after,
[data-if-brand="apothecary"] .specimen.is-live::after {
  content: none;
}
[data-if-brand="apothecary"] .specimen.is-live::before {
  inset: 0.65rem auto 0.65rem 0;
  width: 3px;
  background: var(--live);
  filter: none;
  animation: breathe 2.6s ease-in-out infinite;
}
[data-if-brand="apothecary"] .if-h1,
[data-if-brand="apothecary"] .if-h2,
[data-if-brand="apothecary"] .if-brand__title,
[data-if-brand="apothecary"] .if-kpi__value {
  font-family: var(--if-display);
  letter-spacing: 0.01em;
}


@media (prefers-color-scheme: light) {
  :root[data-if-brand="apothecary"]:not([data-if-theme]) {
    color-scheme: light;
  --if-bg: #f3efe3;
  --if-bg-raised: #faf7ee;
  --if-surface: #faf7ee;
  --if-surface-2: #ece6d6;
  --if-surface-hover: #e4ddca;
  --if-line: #cfc8b6;
  --if-line-strong: #b7b09c;
  --if-text: #1a221c;
  --if-text-soft: #5a6258;
  --if-muted: #7a776b;
  --if-accent: #1f6a4e;
  --if-accent-ink: #f3efe3;
  --if-accent-soft: #d5eadc;
  --if-accent-line: #9fc9b3;
  --if-success: #1f6a4e;
  --if-success-soft: #d5eadc;
  --if-warning: #8a5a10;
  --if-warning-soft: #f1e4c4;
  --if-danger: #9c2432;
  --if-danger-soft: #f3d6d6;
  --if-info: #2f5d88;
  --if-info-soft: #dfe9f1;
  --if-shadow: 0 1px 0 rgba(26, 34, 28, 0.04);
  --code-bg: #eae4d4;
  --code-fg: #1a221c;
  }
  :root[data-if-brand="apothecary"]:not([data-if-theme]) body {
    background: repeating-linear-gradient(to bottom, transparent 0, transparent calc(1.4rem - 1px), color-mix(in srgb, var(--line) 32%, transparent) calc(1.4rem - 1px), color-mix(in srgb, var(--line) 32%, transparent) 1.4rem), var(--paper);
  }
}

/* No-JS light fallback: the shell's theme is applied by the appearance boot
   script setting data-if-theme, and infernal's :root base is dark — so a
   client without JavaScript would be locked to dark regardless of OS
   preference. When the attribute is absent (only possible without JS) and
   the OS prefers light, re-state the library's light + mergehenna-brand
   token values for the mergehenna pack. Apothecary has its own pack rules
   above. Keep in sync with the infernal.css [data-if-theme="light"] block and
   its mergehenna brand override when re-vendoring. */
@media (prefers-color-scheme: light) {
  :root[data-if-brand="mergehenna"]:not([data-if-theme]) {
    color-scheme: light;
    --if-bg: #f2eff4;
    --if-bg-raised: #f9f7fb;
    --if-surface: #ffffff;
    --if-surface-2: #f4f2f8;
    --if-surface-hover: #eae7f1;
    --if-line: #dfdce8;
    --if-line-strong: #c5bfd3;
    --if-text: #282334;
    --if-text-soft: #5c586b;
    --if-muted: #777383;
    --if-success: #14784a;
    --if-success-soft: #ddf5e7;
    --if-warning: #8f580e;
    --if-warning-soft: #fff1d9;
    --if-danger: #b72d47;
    --if-danger-soft: #ffe5e9;
    --if-info: #2b67b2;
    --if-info-soft: #e1efff;
    --if-shadow: 0 20px 55px rgba(56, 39, 71, 0.09);
    --if-accent: #a95523;
    --if-accent-ink: #fff;
    --if-accent-soft: #fff0e3;
    --if-accent-line: #e7c4aa;
  }
}

*, *::before, *::after { box-sizing: border-box; }

html { font-size: 100%; }

body {
  margin: 0;
  min-height: 100vh;
  font-family: var(--font-ui);
  font-size: 0.95rem;
  line-height: 1.5;
  background: var(--paper);
  color: var(--ink);
}

a { color: var(--action); text-decoration: underline; text-underline-offset: 0.15em; }
a:hover { color: var(--action); filter: brightness(1.12); }

:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.skip {
  position: absolute;
  left: -999px;
  top: 0.5rem;
  background: var(--surface);
  color: var(--ink);
  padding: 0.4rem 0.7rem;
  z-index: 10;
}
.skip:focus { left: 0.5rem; }

.top {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1rem;
  align-items: center;
  padding: 0.75rem 1.25rem;
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  border-bottom: 1px solid var(--line);
  position: sticky;
  top: 0;
  z-index: 5;
  backdrop-filter: blur(8px);
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-family: var(--font-display);
  font-size: 1.2rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--ink);
  text-decoration: none;
}
.brand-mark {
  width: 1.75rem;
  height: 1.75rem;
  display: block;
  flex: none;
  object-fit: contain;
}
.brand svg { width: 1.15rem; height: 1.15rem; color: var(--action); flex: none; }
.tag { color: var(--ink-muted); font-size: 0.82rem; }
.grow { flex: 1 1 6rem; }

.appearance {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
  padding: 3px;
  gap: 2px;
}
.appearance button {
  appearance: none;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ink-muted);
  font: inherit;
  font-weight: 600;
  font-size: 0.72rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 0.28rem 0.6rem;
  cursor: pointer;
}
.appearance button:hover { color: var(--ink); }
.appearance button[aria-pressed="true"] {
  background: var(--action-soft);
  color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--line);
}


/* ---- App shell: global icon rail + optional contextual side nav ----
   Composition over the library's .if-rail / .if-context-nav piece classes:
   these rules only position them as a full-height application shell and add
   the link-active state (the library expresses it with aria-pressed on its
   JS-driven buttons; the shell uses plain navigation links). */
.shell {
  display: grid;
  grid-template-columns: 3.75rem minmax(0, 1fr);
  min-height: 100vh;
}
.shell.has-context { grid-template-columns: 3.75rem 14.5rem minmax(0, 1fr); }
/* Rail-less pages (login) have no rail child — without this their content
   would land in the 3.75rem first column and render unusably narrow. */
.shell--railless, .shell--railless.has-context { grid-template-columns: minmax(0, 1fr); }
.shell-rail {
  position: sticky;
  top: 0;
  height: 100vh;
  z-index: 6;
}
.shell-context {
  position: sticky;
  top: 0;
  height: 100vh;
  z-index: 6;
}
.shell-content { min-width: 0; }
a.if-rail__button { display: grid; place-items: center; text-decoration: none; }
.shell-rail .if-rail__button.is-active {
  background: var(--if-accent-soft);
  color: var(--if-accent);
}
.shell-rail .if-rail__button.is-active::before {
  content: "";
  position: absolute;
  left: -7px;
  top: 10px;
  height: 20px;
  width: 3px;
  border-radius: 4px;
  background: var(--if-accent);
}
.shell-rail__logo svg { width: 22px; height: 22px; display: block; }
.shell-context .if-context-nav__item { text-decoration: none; }
.shell-context .if-context-nav__item[aria-current] { font-weight: 600; }

/* Queue family switcher: links wearing the library's tab visuals. */
.ops-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin: 0.7rem 0 1rem;
}
.ops-actions .if-button { text-decoration: none; }
.recent-job { justify-content: space-between; gap: 0.5rem; }
.recent-job__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.recent-job__state {
  flex: none;
  font-family: var(--font-mono);
  font-size: 0.58rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--ink-muted);
}
.recent-job__state[data-state="completed"] { color: var(--ok-text); }
.recent-job__state[data-state="failed"], .recent-job__state[data-state="cancelled"] { color: var(--bad); }
.recent-job__state[data-state="reviewing"], .recent-job__state[data-state="running"] { color: var(--accent); }


.brand-text { display: inline-flex; flex-direction: column; line-height: 1.05; }
.brand-name { font-family: var(--font-display); font-size: 1.15rem; font-weight: 600; letter-spacing: 0.01em; }
.brand-caption {
  font-family: var(--font-mono);
  font-size: 0.58rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ash);
  margin-top: 0.18rem;
}

.stack-progress {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 0.5rem 0 0.4rem;
}

.stack-progress .if-progress {
  flex: 0 1 240px;
}

.stack-progress .muted {
  margin: 0;
}

/* Merge lifecycle panel — infernal inspector rows on top of if-panel. The
 * library owns the panel chrome (head band, surface, radius); these rows lay
 * the facts out label-left / value-right like the example inspector. */
.merge-lifecycle .if-panel__head code.sha {
  font-family: var(--if-mono);
  font-size: 12px;
  color: var(--muted);
}

.merge-fact {
  padding: 7px 0;
  border-bottom: 1px solid var(--rule);
  align-items: baseline;
  gap: 18px;
}

.merge-fact:last-of-type {
  border-bottom: 0;
}

.merge-fact .if-label {
  flex: none;
  min-width: 132px;
}

.merge-fact-value {
  text-align: right;
  font-size: 12.5px;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}

.merge-fact-value code {
  font-family: var(--if-mono);
  font-size: 11.5px;
}

.merge-fact-value a {
  color: var(--if-accent);
  font-weight: 600;
}

.merge-diagnostics {
  font-size: 12.5px;
  color: var(--muted);
}

.merge-diagnostics summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--ink-weak);
  border-radius: var(--radius);
}

.merge-diagnostics summary:hover {
  color: var(--if-accent);
}

.merge-diagnostics ul {
  margin: 8px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.merge-diagnostics pre {
  margin-top: 8px;
  padding: 12px 14px;
  background: var(--well);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  font-size: 11.5px;
  overflow-x: auto;
}

.merge-lifecycle-note {
  margin: 2px 0 0;
}

/* if-field error variant: the config form marks invalid controls with
   aria-invalid rather than a wrapper class, so key the danger treatment off
   the attribute — same visual as the library's if-field--error .if-input. */
body.operator main input[aria-invalid="true"],
body.operator main select[aria-invalid="true"],
body.operator main textarea[aria-invalid="true"],
body.operator main .model-picker [aria-invalid="true"] {
  border-color: var(--if-danger);
}

body.operator main input[aria-invalid="true"]:focus,
body.operator main select[aria-invalid="true"]:focus,
body.operator main textarea[aria-invalid="true"]:focus {
  outline-color: var(--if-danger);
}

/* if-label inside converted config fields — quiet 12px library treatment. */
label.if-field {
  margin-bottom: 0.7rem;
}

/* infernal component adaptations — the vendored if-log/if-diff colors are
   hardcoded for dark; key them to the theme tokens instead. Placed late so
   they win over both the vendored rules and the legacy .log-panel frame. */
.if-log {
  background: var(--code-bg);
  border-color: var(--line);
  color: var(--code-fg);
  /* maomao reviewer output is longer than the library's 160px default. */
  max-height: 22rem;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Reviewer run cards on the job detail: vertical rhythm for the adopted
   if-reviewer-card chrome. */
.run-card { display: flex; flex-direction: column; gap: 10px; margin-bottom: 12px; }
.run-card .if-metric-strip { margin: 2px 0; }
.run-card .if-reviewer-card__icon svg { width: 15px; height: 15px; }
.run-card form.retry { margin: 0; }

@media (max-width: 720px) {
  .shell, .shell.has-context { display: block; }
  .shell-rail {
    position: static;
    height: auto;
    flex-direction: row;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid var(--if-line, var(--line));
    padding: 0.4rem 0.5rem;
    gap: 4px;
  }
  .shell-rail .if-rail__spacer { display: none; }
  .shell-rail .if-rail__logo { width: 34px; height: 34px; margin-bottom: 0; }
  .shell-rail .if-rail__button.is-active::before {
    left: 10px;
    top: auto;
    bottom: -4px;
    height: 3px;
    width: 20px;
  }
  .shell-context {
    position: static;
    height: auto;
    border-right: 0;
    border-bottom: 1px solid var(--if-line, var(--line));
    padding: 0.6rem 0.7rem;
  }
  .shell-context .if-context-nav__head { padding-bottom: 8px; }
}

.logout { margin: 0; }
.logout button,
.top-link {
  font: inherit;
  font-size: 0.85rem;
  color: var(--ink-muted);
  background: none;
  border: 0;
  cursor: pointer;
  text-decoration: none;
  padding: 0.2rem 0;
}
.who {
  font-size: 0.85rem;
  color: var(--ink-muted);
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}
.who strong { color: var(--ink); }
.who-avatar { border-radius: 50%; vertical-align: middle; }
.who-glyph {
  display: inline-flex;
  color: var(--ink-muted);
}
.who-glyph svg { display: block; }
.github-login {
  display: inline-block;
  margin: 0.35rem 0;
  font-weight: 600;
}

main {
  padding: 1.25rem 1.35rem 3rem;
  max-width: var(--measure);
  margin: 0 auto;
}

h1 {
  margin: 0.15rem 0 0.4rem;
  font-family: var(--font-display);
  font-size: clamp(1.45rem, 2.4vw, 2rem);
  font-weight: 600;
  letter-spacing: 0.01em;
  line-height: 1.2;
}
h2 {
  margin: 1.6rem 0 0.7rem;
  font-family: var(--font-display);
  font-size: 1.15rem;
  font-weight: 600;
  border-bottom: 1px solid var(--line);
  padding-bottom: 0.3rem;
}
.section-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 0.55rem 1rem;
  flex-wrap: wrap;
  margin: 1.6rem 0 0.7rem;
  border-bottom: 1px solid var(--line);
  padding-bottom: 0.3rem;
}
.section-head h2 {
  margin: 0;
  border: none;
  padding: 0;
}
.lede, .muted, .crumb { color: var(--ink-muted); }
.crumb { margin: 0 0 0.6rem; font-size: 0.88rem; }

.label {
  display: block;
  font-size: 0.7rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ash);
  margin-bottom: 0.15rem;
}

code, .sha, .metric, kbd {
  font-family: var(--font-mono);
  font-size: 0.86em;
}
.sha { font-size: 0.9em; overflow-wrap: anywhere; word-break: break-all; }

button, input, textarea {
  font: inherit;
}
button, summary {
  appearance: none;
  border-radius: var(--if-radius-sm, 7px);
}

.btn:not(.if-button), .login button:not(.if-button), .trigger button:not(.if-button), .logout button.primary, .chat-send {
  background: var(--action);
  color: var(--btn-fg);
  border: 1px solid color-mix(in srgb, var(--action) 70%, var(--ink));
  padding: 0.45rem 0.85rem;
  font-weight: 600;
  cursor: pointer;
  letter-spacing: 0.02em;
}
.btn:not(.if-button):hover, .login button:not(.if-button):hover, .trigger button:not(.if-button):hover, .chat-send:hover {
  filter: brightness(1.05);
}

.config-source {
  display: inline-block;
  margin-left: 0.4rem;
  padding: 0.05rem 0.45rem;
  border: 1px solid var(--line);
  border-radius: 3px;
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  vertical-align: middle;
  white-space: nowrap;
}
.config-source-profile { border-color: var(--jade); color: var(--jade); }
.config-effective h3 { margin-top: 0.9rem; }
.jobs-pagination {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  margin-top: 1rem;
  font-size: 0.9rem;
}
.jobs-pagination .jobs-pagination-note { margin: 0 0 0.35rem; }

.if-banner { margin: 0.8rem 0; border-radius: var(--radius); }
.notice, .error, .warn {
  border: 1px solid var(--line);
  padding: 0.65rem 0.8rem;
  margin: 0.8rem 0;
  background: var(--surface);
}
.notice:not(.if-banner) { border-color: var(--jade); background: var(--jade-soft); }
/* Flash banners are infernal if-banner instances; the legacy frame rules
   above only cover inline notices that have not adopted the component. */
.pause-banner {
  background: var(--amber-soft);
  border-bottom: 1px solid var(--amber);
  color: var(--ink);
  padding: 0.5rem 1rem;
  text-align: center;
  font-size: 0.85rem;
}
.pause-banner a { color: inherit; }
.global-pause {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 1rem 1.1rem;
  margin: 1rem 0;
}
.global-pause h2 { margin-top: 0; }
.global-pause.is-paused {
  border-color: var(--amber);
  background: var(--amber-soft);
}
.error:not(.if-banner) { border-color: var(--cinnabar); background: var(--cinnabar-soft); color: var(--ink); }
.warn { border-color: var(--amber); background: var(--amber-soft); }
.usage-incomplete { color: var(--amber); font-size: 0.9em; margin: 0.35rem 0 0; }
.usage-breakdown, .usage-note { font-size: 0.9em; margin: 0.25rem 0 0; }

.login, .trigger, .specimen, .card, .meta-grid > div, .finding, .empty {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow), inset 0 0 0 1px color-mix(in srgb, var(--surface-2) 80%, transparent);
}

.login {
  max-width: 22rem;
  display: grid;
  gap: 0.8rem;
  padding: 1rem 1.1rem;
}
.login input, .trigger input, .trigger select {
  width: 100%;
  margin-top: 0.3rem;
  padding: 0.45rem 0.6rem;
  background: var(--if-bg-raised, var(--paper));
  color: var(--ink);
  border: 1px solid var(--line-strong);
}

.trigger {
  display: flex;
  gap: 0.6rem;
  align-items: end;
  flex-wrap: wrap;
  margin: 1rem 0 1.2rem;
  padding: 0.85rem 1rem;
}
.trigger label { flex: 1; min-width: 16rem; color: var(--ink-muted); font-size: 0.85rem; }
.trigger .typeahead-wrap { position: relative; display: block; z-index: 5; }

.queue {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  /* A single auto column sizes to the widest card's min-content (e.g. a
     stack card's nowrap member rows) and stretches every card past the
     viewport; capping the track keeps each card at the container width. */
  grid-template-columns: minmax(0, 1fr);
  gap: 0.85rem;
}
/* Grid items default to min-width: auto, so a card whose contents have a
   large min-content (nowrap member rows) would still overflow the capped
   track — let items shrink and leave truncation to the ellipsis styles. */
.queue > li { min-width: 0; }

.guided-inbox-row {
  display: grid;
  gap: 0.45rem;
  padding: 0.85rem 1rem;
  border: 1px solid var(--line);
  border-radius: var(--if-radius, 4px);
  background: var(--surface);
}
.guided-inbox-main {
  display: grid;
  gap: 0.25rem;
  color: inherit;
  text-decoration: none;
  min-width: 0;
}
.guided-inbox-title { font-weight: 650; overflow-wrap: anywhere; }
.guided-inbox-meta, .guided-inbox-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.8rem;
  color: var(--ink-muted);
  font-size: 0.84rem;
}
.guided-inbox-facts { align-items: center; }
.pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 1rem;
  margin-top: 1rem;
}
.gd-head { display: flex; justify-content: space-between; gap: 1rem; align-items: center; flex-wrap: wrap; }
.gd-layout { display: grid; grid-template-columns: minmax(12rem, 18rem) minmax(0, 1fr); gap: 1rem; align-items: start; }
.gd-tree { position: sticky; top: 1rem; max-height: 80vh; overflow: auto; border-right: 1px solid var(--line); padding-right: 0.75rem; }
.gd-tree ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.35rem; font-size: 0.85rem; }
.gd-tree a { overflow-wrap: anywhere; }
.gd-file { margin-bottom: 1rem; border: 1px solid var(--line); border-radius: var(--if-radius, 4px); background: var(--surface); padding: 0.8rem; min-width: 0; }
.gd-file h3 { margin-top: 0; overflow-wrap: anywhere; }
.gd-hunk summary { cursor: pointer; color: var(--ink-muted); font-family: var(--font-mono); font-size: 0.78rem; }
.gd-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-family: var(--font-mono); font-size: 0.78rem; }
.gd-no { width: 3.4rem; text-align: right; color: var(--ink-muted); user-select: none; padding: 0 0.35rem; border-right: 1px solid var(--line); }
.gd-code { white-space: pre-wrap; overflow-wrap: anywhere; padding-left: 0.55rem; }
.gd-add { background: color-mix(in srgb, var(--jade) 13%, transparent); }
.gd-del { background: color-mix(in srgb, var(--cinnabar) 13%, transparent); }
.gd-line:focus { outline: 2px solid var(--focus); outline-offset: -2px; }
@media (max-width: 620px) {
  .trigger label { min-width: 100%; }
  .guided-inbox-row { padding: 0.75rem; }
  .gd-layout { grid-template-columns: 1fr; }
  .gd-tree { position: static; max-height: 16rem; border-right: 0; border-bottom: 1px solid var(--line); padding-bottom: 0.7rem; }
}

.specimen {
  padding: 0.85rem 1rem 0.95rem;
  position: relative;
  border-radius: var(--if-radius, 10px);
  overflow: hidden;
}
/* Live jobs wear the infernal if-card--ember treatment: an accent-line
   border, a faint ember glow pooled at the card's floor, and a thin glint
   running along the bottom edge — no side bar. */
.specimen.is-live {
  border-color: var(--if-accent-line, var(--live));
}
.specimen.is-live::before {
  content: "";
  position: absolute;
  pointer-events: none;
  inset: 40% -20% -45%;
  background: radial-gradient(ellipse 55% 60% at 30% 90%, color-mix(in srgb, var(--live) 30%, transparent), transparent 78%);
  filter: blur(16px);
  animation: breathe 4.5s ease-in-out infinite;
}
.specimen.is-live::after {
  content: "";
  position: absolute;
  pointer-events: none;
  left: 10%;
  right: 10%;
  bottom: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--live), transparent);
  opacity: 0.65;
}

/* Kind chips borrow the .state badge shape (flat, small caps) in plum. */
.kind-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 2px 7px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: var(--plum-soft);
  color: var(--plum);
  font-family: var(--font-mono);
  font-size: 0.63rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  vertical-align: middle;
  white-space: nowrap;
}
.kind-chip svg { width: 0.9em; height: 0.9em; display: block; color: var(--plum); }

.specimen-head {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 0.8rem;
  align-items: center;
  justify-content: space-between;
  /* The infernal screen-job head band: a separated strip bleeding to the
     card edges, so the state badge reads as card chrome, not content. */
  margin: -0.85rem -1rem 0.65rem;
  padding: 0.65rem 1rem;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--surface-2) 50%, transparent);
}
.specimen-id {
  font-family: var(--font-mono);
  font-size: 0.63rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ash);
}
.specimen-title {
  margin: 0.1rem 0 0.15rem;
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.specimen-title a { color: var(--ink); text-decoration: none; }
.specimen-title a:hover { color: var(--action); text-decoration: underline; }
.forge-mark {
  display: inline-flex;
  vertical-align: -0.2em;
  margin-right: 0.4rem;
  color: var(--ink);
}
.forge-mark svg { width: 1.15em; height: 1.15em; display: block; }
.forge-mark-text { font-size: 0.85em; color: var(--ink-muted); margin-right: 0.35rem; }
.forge-host { font-weight: 500; }

/* "View on <forge>" external link right of change titles — quiet until hovered. */
a.pr-external {
  display: inline-flex;
  align-items: center;
  margin-left: 0.4rem;
  color: var(--ink-muted);
  text-decoration: none;
  vertical-align: middle;
}
a.pr-external:hover { color: var(--action); text-decoration: none; }
a.pr-external svg { width: 1em; height: 1em; display: block; }
h1 a.pr-external { font-size: 0.72em; }

.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 1.1rem;
  align-items: center;
  margin-top: 0.55rem;
  font-size: 0.88rem;
}
/* Inside job cards the meta row is the infernal screen-job__meta pattern:
   small mono, quiet labels, brighter values. */
.specimen .meta-row, .member-card .meta-row {
  font-family: var(--font-mono);
  font-size: 0.68rem;
}
.meta-row .pair { color: var(--ink-muted); }
.meta-row .pair strong { color: var(--ink); font-weight: 600; }
.specimen .meta-row .pair strong, .member-card .meta-row .pair strong { font-weight: 500; }

.diagnosis {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem 0.7rem;
  align-items: center;
  margin-top: 0.7rem;
  padding-top: 0.65rem;
  border-top: 1px dashed var(--line);
  font-size: 0.85rem;
}
.ticks { display: inline-flex; gap: 0.2rem; align-items: center; }
.tick {
  width: 0.62rem;
  height: 0.62rem;
  border: 1px solid var(--line-strong);
  background: var(--paper);
  display: inline-block;
}
.tick.done { background: var(--jade); border-color: var(--jade); }
.tick.running {
  border-radius: 50%;
  background: transparent;
  border: 1.5px solid color-mix(in srgb, var(--working) 28%, var(--line));
  border-top-color: var(--working);
  animation: spin 0.8s linear infinite;
}
.tick.failed { background: var(--cinnabar); border-color: var(--cinnabar); }
.join { color: var(--plum); letter-spacing: 0.08em; }

.state {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 3px 8px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: var(--surface-2);
  font-family: var(--font-mono);
  font-size: 0.63rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-soft, var(--ink));
  white-space: nowrap;
}
.state .mark { font-size: 0.7rem; }
.state-completed, .state-done { color: var(--jade); background: var(--jade-soft); }
.state-failed { color: var(--cinnabar); background: var(--cinnabar-soft); }
.state-stale, .state-cancelled { color: var(--amber); background: var(--amber-soft); }
.state-reviewing, .state-aggregating, .state-sniffing, .state-publishing, .state-running, .state-preparing, .state-routing, .state-reconciling {
  color: var(--working);
  background: var(--working-soft);
}
.state-preparing .mark,
.state-reconciling .mark,
.state-reviewing .mark,
.state-aggregating .mark,
.state-sniffing .mark,
.state-publishing .mark,
.state-running .mark,
.state-routing .mark {
  width: 0.65rem;
  height: 0.65rem;
  padding: 0;
  font-size: 0;
  color: transparent;
  overflow: hidden;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, var(--working) 28%, var(--surface));
  border-top-color: var(--working);
  background: transparent;
  animation: spin 0.8s linear infinite;
  flex: none;
}
.state-queued { background: var(--surface-2); }

.sev {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-family: var(--font-mono);
  font-size: 0.63rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  padding: 2px 7px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: var(--surface-2);
}
.sev-blocker, .sev-high { color: var(--cinnabar); background: var(--cinnabar-soft); }
.sev-medium { color: var(--amber); background: var(--amber-soft); }
.sev-low, .sev-info { color: var(--herb); background: var(--jade-soft); }

/* Stack members on a stack_review job page: numbered nodes on a connecting
   rail, in the bottom-up order the runner reviews them. */
.stack-rail {
  list-style: none;
  margin: 0.7rem 0 0;
  padding: 0;
}
.stack-member {
  display: flex;
  gap: 0.75rem;
  position: relative;
  padding-bottom: 0.9rem;
}
.stack-member:last-child { padding-bottom: 0; }
.stack-member::before {
  content: "";
  position: absolute;
  left: 0.72rem;
  top: 1.6rem;
  bottom: 0.1rem;
  width: 1px;
  background: var(--line-strong);
}
.stack-member:last-child::before { display: none; }
.stack-node {
  width: 1.45rem;
  height: 1.45rem;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: var(--surface);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--ink-muted);
}
.stack-member.is-current .stack-node {
  border-color: var(--working);
  color: var(--working);
  box-shadow: 0 0 0 3px var(--working-soft);
}
.stack-member-body {
  flex: 1;
  min-width: 0;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 0.5rem 0.7rem;
}
.stack-member.is-current .stack-member-body { border-color: color-mix(in srgb, var(--working) 55%, var(--line)); }
.stack-member-head {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem 0.7rem;
  align-items: center;
  justify-content: space-between;
}
.stack-member-pr { font-weight: 600; }
.stack-edge {
  margin-left: 0.45rem;
  padding: 0 0.35rem;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius);
  color: var(--ash);
  font-size: 0.66rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.stack-member-meta {
  margin-top: 0.2rem;
  font-size: 0.85rem;
  color: var(--ink-muted);
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem 0.45rem;
  align-items: baseline;
}
.stack-member-meta code { font-size: 0.85em; }

/* Miniature member rail on stack queue cards: same node vocabulary as the
   job-page .stack-rail, laid out horizontally inside a dashed panel. */
.stack-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem 0.7rem;
  align-items: center;
  justify-content: space-between;
  margin-top: 0.55rem;
  font-size: 0.85rem;
}
.stack-mini {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  row-gap: 0.25rem;
  margin: 0;
  padding: 0;
}
.stack-mini-member {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-weight: 600;
}
.stack-mini-member + .stack-mini-member::before {
  content: "";
  width: 0.85rem;
  height: 1px;
  background: var(--line-strong);
  margin: 0 0.35rem;
}
.stack-mini-member a { color: inherit; text-decoration: none; }
.stack-mini-member a:hover { color: var(--action); text-decoration: underline; }
.stack-mini-node {
  width: 1.15rem;
  height: 1.15rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: var(--surface);
  font-family: var(--font-mono);
  font-size: 0.62rem;
  color: var(--ink-muted);
}
.stack-mini-member.st-done .stack-mini-node {
  border-color: var(--jade);
  color: var(--jade);
  background: var(--jade-soft);
}
.stack-mini-member.st-reviewing .stack-mini-node {
  border-color: var(--working);
  color: var(--working);
  box-shadow: 0 0 0 2px var(--working-soft);
}
.stack-mini-member.st-failed { color: var(--cinnabar); }
.stack-mini-member.st-failed .stack-mini-node {
  border-color: var(--cinnabar);
  color: var(--cinnabar);
  background: var(--cinnabar-soft);
}
.stack-mini-member.st-cancelled .stack-mini-node {
  border-style: dashed;
}
.stack-strip-count { color: var(--ink-muted); font-size: 0.8rem; white-space: nowrap; }

/* Stack member jobs nest under their stack card on the home list — one
   glued block (no gap, no rail), each member a compact two-line row. */
/* Stack members hang off the stack card on the infernal screen-rail
   pattern: one vertical line, a dot per member, no nested boxes. */
.member-cards {
  list-style: none;
  margin: 0.25rem 0 0.4rem 1.4rem;
  padding: 0;
  border-left: 1px solid var(--line-strong, var(--line));
}
.member-card {
  position: relative;
  padding: 0.45rem 0.7rem 0.5rem 1.15rem;
  font-size: 0.88rem;
}
.member-card::before {
  content: "";
  position: absolute;
  left: -5.5px;
  top: 0.85rem;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--surface);
  border: 2px solid var(--line-strong, var(--line));
}
.member-card.is-live::before {
  border-color: var(--working);
  background: var(--working-soft);
}
.member-card + .member-card { border-top: 1px solid color-mix(in srgb, var(--line) 55%, transparent); }
.member-row {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-width: 0;
}
.member-pos {
  font-size: 0.68rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ash);
  white-space: nowrap;
}
.member-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.member-row .state { margin-left: auto; }
.member-meta { font-size: 0.85em; }

/* /reviewers board: dense one-line rows — role · PR title · owning job ·
   mode · head · elapsed · state. */
/* Reviewer runs board — an infernal if-table with fixed columns so every
   row's meta lines up. The library owns the chrome (wrap, header band, row
   hover); these rules size the columns and truncate the change title. */
.run-board {
  background: var(--surface);
  margin-bottom: 0.4rem;
}
.run-board .if-table { table-layout: fixed; min-width: 760px; }
.run-board .col-role { width: 9.5rem; }
.run-board .col-title { width: auto; }
.run-board .col-owner { width: 12rem; }
.run-board .col-mode { width: 5.5rem; }
.run-board .col-sha { width: 6.5rem; }
.run-board .col-elapsed { width: 4.5rem; }
.run-board .col-state { width: 7.5rem; }
.run-row td { vertical-align: middle; }
.run-row .role { white-space: nowrap; display: inline-flex; align-items: center; gap: 0.35rem; }
.run-row .role svg { width: 0.9em; height: 0.9em; flex: none; }
.run-title a {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.run-row .run-owner,
.run-row .run-elapsed,
.run-row .sha { white-space: nowrap; }
.run-row .run-owner {
  overflow: hidden;
  text-overflow: ellipsis;
}
.run-row .run-state .state { white-space: nowrap; }
.run-row td.muted, .run-row .muted { font-size: 11.5px; }
.pager {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  margin: 0.55rem 0.1rem 0;
  font-size: 0.88rem;
}

.pager > a {
  display: inline-flex;
  align-items: center;
  padding: 5px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--if-accent);
  font-weight: 600;
  font-size: 12px;
  text-decoration: none;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.pager > a:hover {
  border-color: var(--if-accent);
  background: var(--if-accent-soft, var(--well));
}

.pager > .muted {
  font-family: var(--if-mono);
  font-size: 11px;
  letter-spacing: 0.02em;
}

/* Repo / job-type filter bar on the home job list; it reuses the .trigger
   card + button chrome, the select just needs field styling. */
.job-filters { margin: 0.4rem 0 1rem; }
.job-filters label { flex: 0 1 16rem; min-width: 11rem; }
.job-filters select {
  width: 100%;
  margin-top: 0.3rem;
  padding: 0.45rem 0.6rem;
  background: var(--if-bg-raised, var(--paper));
  color: var(--ink);
  border: 1px solid var(--line-strong);
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.6rem 0.8rem;
  margin: 1rem 0;
}
.meta-grid > div { padding: 0.7rem 0.8rem; }
.meta-grid dt {
  font-size: 0.7rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ash);
  margin: 0 0 0.2rem;
}
.meta-grid dd { margin: 0; }
.config-hint { font-size: 0.82rem; margin-top: 0.25rem; }

.sha-block {
  grid-column: 1 / -1;
}
.sha-block dd { font-size: 1.05rem; }

.cards {
  display: grid;
  gap: 0.8rem;
}
.card { padding: 0.85rem 1rem; }
.card header {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: center;
  flex-wrap: wrap;
}
form.retry, form.retry-job, form.dequeue {
  margin: 0;
  background: none;
  border: none;
  box-shadow: none;
  padding: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
}
/* a.cancel-review is an anchor styled as a button — see the anchor resets below. */
.retry button:not(.if-button), .retry-job button:not(.if-button), .dequeue button:not(.if-button), a.cancel-review {
  background: var(--paper);
  color: var(--ink);
  border: 1px solid var(--line-strong);
  border-radius: var(--if-radius-sm, 7px);
  padding: 0.22rem 0.65rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.retry button:not(.if-button):hover, .retry-job button:not(.if-button):hover, .dequeue button:not(.if-button):hover, a.cancel-review:hover {
  color: var(--action);
  border-color: var(--action);
}
/* The cancel entry point is an anchor styled as a button: match the form controls. */
a.cancel-review { text-decoration: none; display: inline-block; }
.card .retry { margin-top: 0.55rem; }
.role {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-weight: 600;
}
.role svg { width: 1rem; height: 1rem; color: var(--action); flex: none; }
.role-agg svg { color: var(--plum); }

.finding {
  margin: 0 0 0.75rem;
}

/* Adopted if-finding chrome: summary/body own the padding, the card is a
   borderless-at-rest disclosure. Theme layer keeps status-driven border
   treatments working on top. */
.finding.if-finding {
  padding: 0;
  background: var(--surface);
}

.finding.if-finding summary {
  gap: 14px;
}

.finding-summary-text {
  min-width: 0;
  font-size: 12.5px;
}

.finding-summary-text .finding-title {
  font-size: 13px;
}

.finding-summary-text .loc {
  display: inline-block;
  margin-top: 3px;
}

.finding-summary-badges {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
  flex: none;
  margin-left: auto;
}

/* The library chevron sits after the badges; keep it compact. */
.finding.if-finding summary::after {
  flex: none;
}

.finding.if-finding .if-finding__body {
  color: var(--ink-weak);
  font-size: 12.5px;
}
.finding.is-unconfirmed {
  border-style: dashed;
  background: color-mix(in srgb, var(--plum-soft) 70%, var(--surface));
}
.finding-head {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.7rem;
  align-items: baseline;
  font-family: var(--font-mono);
  font-size: 0.82rem;
}
.unconfirmed {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--plum);
  border: 1px dashed var(--plum);
  background: var(--plum-soft);
  padding: 0.05rem 0.4rem;
}
.findings-provisional {
  border: 1px dashed var(--plum);
  background: var(--plum-soft);
  padding: 0.65rem 0.8rem;
  margin: 0.8rem 0;
}
.finding-head {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.7rem;
  align-items: baseline;
  font-family: var(--font-mono);
  font-size: 0.82rem;
}
.finding h3 {
  margin: 0.35rem 0 0.45rem;
  font-size: 1.02rem;
  font-family: var(--font-ui);
}
.finding p { margin: 0.35rem 0; }
.finding .loc { font-family: var(--font-mono); color: var(--ink-muted); }

.finding-status {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  border: 1px solid var(--line-strong);
  padding: 0.05rem 0.4rem;
}
.finding-status-resolved { color: var(--jade); background: var(--jade-soft); border-color: var(--jade); }
.finding-status-dismissed { color: var(--plum); background: var(--plum-soft); border-color: var(--plum); }
.finding-status-still_valid, .finding-status-open { color: var(--cinnabar); background: var(--cinnabar-soft); border-color: var(--cinnabar); }
.finding-status-moved { color: var(--amber); background: var(--amber-soft); border-color: var(--amber); }
.finding-status-uncertain { color: var(--ink-muted); background: var(--surface-2); }

.stale-sha {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--amber);
  background: var(--amber-soft);
  border: 1px solid var(--amber);
  padding: 0.05rem 0.4rem;
}
.finding.is-stale-sha { border-style: dashed; }
.loc-link { font-size: 0.8rem; }

.finding-diff { margin: 0.4rem 0 0; }
.finding-diff summary {
  cursor: pointer;
  font-size: 0.85rem;
  color: var(--ink-muted);
}
.diff-panel {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.45;
  background: var(--surface-2);
  border: 1px solid var(--line-strong);
  border-radius: var(--if-radius-sm, 7px);
  padding: 0.5rem 0.75rem;
  overflow-x: auto;
  white-space: pre;
  max-height: 24rem;
  overflow-y: auto;
  position: relative;
}
/* Server-rendered line spans (no-JS fallback) share the panel pre's newlines —
   they must stay inline or every line renders double-spaced. The soft tinted
   backgrounds mirror the infernal if-diff--add/--remove line treatment, keyed
   to theme tokens (the vendored component colors are hardcoded for dark). */
.diff-panel {
  font-size: 11px;
  line-height: 1.75;
}
.diff-panel .diff-add {
  color: var(--jade);
  background: var(--jade-soft);
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
.diff-panel .diff-del {
  color: var(--cinnabar);
  background: var(--cinnabar-soft);
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
.diff-panel .diff-ctx { color: var(--ink-muted); }
.diff-note { font-size: 0.8rem; }

/* @pierre/diffs bridge: point the library's CSS variables at Maomao tokens.
   Pierre paints chrome from --diffs-bg/--diffs-fg and add/del mix-ins; those
   are set on :host inside a CSS layer, so unlayered rules on the custom
   element win and keep the viewer on paper/ink/jade/cinnabar instead of
   Pierre's stock white/neon palette. Syntax tokens still come from the
   bundled pierre-light/dark Shiki themes. */
.pierre-diff,
.pierre-diff diffs-container,
details.finding-diff {
  --diffs-font-family: var(--font-mono);
  --diffs-font-size: 0.78rem;
  --diffs-header-font-family: var(--font-ui);
  --diffs-bg: var(--code-bg);
  --diffs-fg: var(--ink);
  --diffs-light-bg: var(--code-bg);
  --diffs-dark-bg: var(--code-bg);
  --diffs-light: var(--ink);
  --diffs-dark: var(--ink);
  --diffs-fg-number-override: var(--ink-muted);
  --diffs-addition-color-override: var(--jade);
  --diffs-deletion-color-override: var(--cinnabar);
  --diffs-modified-color-override: var(--herb);
  --diffs-added-light: var(--jade);
  --diffs-added-dark: var(--jade);
  --diffs-deleted-light: var(--cinnabar);
  --diffs-deleted-dark: var(--cinnabar);
  --diffs-modified-light: var(--herb);
  --diffs-modified-dark: var(--herb);
  --diffs-warning-light: var(--amber);
  --diffs-warning-dark: var(--amber);
}
.pierre-annotation {
  border-left: 3px solid var(--amber);
  background: color-mix(in srgb, var(--amber) 14%, transparent);
  padding: 0.25rem 0.5rem;
  margin: 0.15rem 0;
  font-size: 0.78rem;
  border-radius: 4px;
}
.pierre-annotation.severity-blocker,
.pierre-annotation.severity-high { border-left-color: var(--cinnabar); }
.pierre-annotation.severity-medium { border-left-color: var(--amber); }
.pierre-annotation.severity-low,
.pierre-annotation.severity-info { border-left-color: var(--herb); }
details.finding-diff > summary {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}
.diff-layout-toggle {
  margin-left: auto;
  font-size: 0.72rem;
  padding: 0.05rem 0.45rem;
  cursor: pointer;
  color: var(--ink-muted);
  background: transparent;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
}
.pierre-diff diffs-container {
  display: block;
  min-height: 4rem;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--code-bg);
  color: var(--ink);
}
/* Scan-page repository typeahead (progressively enhanced by /assets/typeahead.js) */
.typeahead-wrap { position: relative; display: block; }
.typeahead-wrap input { width: 100%; }
.typeahead-listbox {
  position: absolute;
  z-index: 10;
  left: 0;
  right: 0;
  margin: 0.2rem 0 0;
  padding: 0.2rem;
  list-style: none;
  background: var(--surface-2);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  box-shadow: var(--shadow);
  max-height: 16rem;
  overflow-y: auto;
}
.typeahead-option {
  padding: 0.3rem 0.55rem;
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 0.85rem;
  border-radius: 6px;
}
.typeahead-option.is-active,
.typeahead-option[aria-selected="true"] { background: color-mix(in srgb, var(--action) 26%, transparent); }
.typeahead-empty,
.typeahead-empty.is-active {
  cursor: default;
  color: var(--ink-muted);
  background: transparent;
}

/* Model picker: provider-grouped popover (progressively enhanced by /assets/model-picker.js).
   Without is-js the wrapper is just the text input — the field stays editable
   with JavaScript disabled. is-js reveals the button and hides the input;
   is-custom ("Type a custom model…") brings the input back. */
.model-picker { position: relative; display: block; margin-top: 0.3rem; }
.model-picker .model-picker-input { margin-top: 0; }
.model-picker.is-js .model-picker-input { display: none; }
.model-picker.is-js.is-custom .model-picker-input { display: block; margin-bottom: 0.3rem; }
.model-picker-btn {
  display: none;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  width: 100%;
  padding: 0.45rem 0.5rem;
  background: var(--paper);
  color: var(--ink);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.model-picker-btn:hover { border-color: var(--action); }
.model-picker-btn[aria-expanded="true"] { border-color: var(--action); }
.model-picker-btn[aria-invalid="true"] { border-color: var(--cinnabar); }
.model-picker-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 0.86em;
}
.model-picker.is-js .model-picker-btn { display: flex; }
.model-picker-caret { flex: none; color: var(--ink-muted); font-size: 0.75rem; }
.model-picker-pop {
  display: none;
  position: absolute;
  z-index: 20;
  left: 0;
  right: 0;
  margin-top: 0.25rem;
  padding: 0.3rem;
  background: var(--surface-2);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  box-shadow: var(--shadow);
  max-height: 18rem;
  overflow-y: auto;
}
/* :not([hidden]) keeps this reveal rule at equal specificity order under the
   [hidden] guard below — otherwise pops paint open once is-js is stamped. */
.model-picker.is-js .model-picker-pop:not([hidden]) { display: block; }
.model-picker-pop[hidden] { display: none; }
.model-picker-search { display: block; padding: 0 0.15rem 0.3rem; }
.model-picker-search .model-picker-search-input {
  width: 100%;
  box-sizing: border-box;
  margin-top: 0;
  font-family: var(--font-mono);
  font-size: 0.85rem;
}
.model-picker-none {
  display: block;
  padding: 0.6rem 0.55rem 0.4rem;
  color: var(--ink-muted);
  font-size: 0.8rem;
}
.model-picker-none[hidden] { display: none; }
.model-picker-group {
  display: block;
  padding: 0.45rem 0.55rem 0.15rem;
  color: var(--ink-muted);
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.model-picker-group[hidden] { display: none; }
/* Same [hidden] guard for options: the flex rule below beats the UA
   [hidden] display:none — search filtering relies on it hiding. */
.model-picker-option[hidden] { display: none; }
.model-picker-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.55rem;
  border-radius: 6px;
  cursor: pointer;
}
.model-picker-option.is-active { background: color-mix(in srgb, var(--action) 26%, transparent); }
.model-picker-check { flex: none; width: 1em; color: var(--action); visibility: hidden; }
.model-picker-option[aria-selected="true"] .model-picker-check { visibility: visible; }
.model-picker-text { display: flex; flex-direction: column; min-width: 0; }
.model-picker-name {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-picker-empty-label { color: var(--ink-muted); }
.model-picker-detail {
  color: var(--ink-muted);
  font-size: 0.72rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.finding.is-buried,
.finding.is-resolved {
  border-style: dashed;
}
details.finding:not([open]) {
  opacity: 0.82;
}
/* The infernal if-finding component owns disclosure chrome (summary padding,
   ::after chevron, body hairline). These rules only cover what the library
   misses: Firefox's ::marker and the maomao severity/status typography. */
details.finding > summary::-webkit-details-marker,
details.finding > summary::marker {
  display: none;
}
details.finding > summary {
  list-style: none;
}
.settled-findings-label {
  margin: 1rem 0 0.45rem;
  font-size: 0.82rem;
}
.finding-override {
  color: var(--plum);
  margin: 0.4rem 0 0.5rem;
}
.finding.is-resolved .finding-override {
  color: var(--jade);
}

pre, .log-panel {
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--code-bg);
  color: var(--code-fg);
  font-family: var(--font-mono);
  font-size: 0.8rem;
  line-height: 1.45;
  padding: 0.8rem;
  border: 1px solid var(--line);
  border-radius: var(--if-radius-sm, 7px);
  overflow: auto;
  max-height: 22rem;
}

.logs {
  list-style: none;
  margin: 0;
  padding: 0.6rem 0.8rem;
  background: var(--code-bg);
  color: var(--code-fg);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  border: 1px solid var(--line);
  max-height: 24rem;
  overflow: auto;
}
.logs li { margin: 0.2rem 0; }
.logs .lvl { text-transform: uppercase; letter-spacing: 0.04em; }

.empty {
  padding: 1.6rem 1.2rem;
  text-align: center;
  border-style: dashed;
  border-color: var(--line-strong, var(--line));
  color: var(--muted);
}

.empty strong { color: var(--ink); }
.empty p { margin: 0.3rem 0; }

details { margin: 0.45rem 0; }
details summary { cursor: pointer; color: var(--ink-muted); }

@keyframes breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Pancake easter egg: chip next to the home heading plus the
   "maomao earned a pancake" drop animation, played when a reload
   after an SSE event reveals a newly completed job. */
.pancake-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.15rem 0.6rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 0.8rem;
  color: var(--muted, inherit);
  vertical-align: middle;
}
.pancake-chip svg { width: 16px; height: 16px; flex: none; }
.pancake-chip.nom {
  border-color: var(--working);
  color: inherit;
}
@keyframes pancake-drop {
  0% { transform: translateY(-1.2em) scale(0.5); opacity: 0; }
  45% { transform: translateY(0.12em) scale(1.08); opacity: 1; }
  70% { transform: translateY(-0.22em) scale(1); }
  100% { transform: translateY(0) scale(1); opacity: 1; }
}
.pancake-chip.nom svg { animation: pancake-drop 0.9s ease-in-out; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  .specimen.is-live::before { animation: none; opacity: 1; }
  .tick.running,
  .state-preparing .mark,
  .state-reconciling .mark,
  .state-reviewing .mark,
  .state-aggregating .mark,
  .state-sniffing .mark,
  .state-publishing .mark,
  .state-running .mark,
  .state-routing .mark {
    animation: none !important;
    background: var(--working);
    border-color: var(--working);
  }
}

@media (max-width: 720px) {
  .top { padding: 0.65rem 0.8rem; }
  main { padding: 1rem 0.8rem 2.5rem; }
  .tag, .top-link { display: none; }
  .appearance button { padding: 0.22rem 0.38rem; font-size: 0.68rem; }
  .meta-grid { grid-template-columns: 1fr; }
  .account-name { max-width: 8rem; }
  /* A member row's fixed pieces (id label + state badge) already eat most
     of a phone-width card, crushing the nowrap title to a sliver — give
     the title a full line so it truncates readable instead. */
  .member-row { flex-wrap: wrap; }
  .member-row .member-title { order: -1; flex: 1 1 100%; }
  /* Same for dense reviewer runs: the title owns line one and the role,
     owner, mode, sha and state flow onto the following lines. */
}

@media (min-resolution: 1.4dppx) {
  body { -webkit-font-smoothing: antialiased; }
}

/* ---- Ask Maomao chat (island + no-JS fallback share these) ---- */
.chat-transcript { display: grid; gap: var(--space-3); margin: var(--space-4) 0; }
.chat-transcript[hidden] { display: none; }
.chat-bubble {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  padding: var(--space-2) var(--space-3);
  max-width: 60rem;
}
.chat-bubble p { margin: var(--space-1) 0 0; overflow-wrap: anywhere; }
.chat-bubble-user { border-left: 3px solid var(--if-info, var(--herb)); }
.chat-bubble-assistant { border-left: 3px solid var(--action); }
.chat-thread { display: grid; gap: var(--space-3); margin-top: var(--space-4); }
.chat-viewport {
  display: grid;
  gap: var(--space-3);
  max-height: 28rem;
  overflow-y: auto;
  padding: var(--space-2);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}
.chat-composer {
  display: flex;
  gap: var(--space-2);
  align-items: flex-end;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  padding: var(--space-2);
}
.chat-composer-input {
  flex: 1;
  resize: vertical;
  min-height: 2.4rem;
  background: var(--paper);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-2);
  font: inherit;
}
.chat-composer-input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.chat-send, .chat-cancel {
  cursor: pointer;
  font: inherit;
}
.chat-cancel {
  background: var(--paper);
  color: var(--ink);
  border: 1px solid var(--line-strong);
  padding: 0.45rem 0.85rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.chat-cancel:hover { color: var(--action); border-color: var(--action); }
.chat-send:disabled, .chat-cancel:disabled { opacity: 0.5; cursor: default; }
.chat-error { border: 1px solid var(--cinnabar); background: var(--cinnabar-soft); color: var(--ink); border-radius: var(--radius); padding: var(--space-2); }
.chat-suggestions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.chat-suggestion {
  appearance: none;
  border: 1px solid var(--line-strong);
  background: var(--paper);
  color: var(--ink);
  padding: var(--space-1) var(--space-2);
  cursor: pointer;
  font: inherit;
  font-size: 0.85rem;
  font-weight: 600;
}
.chat-suggestion:hover { color: var(--action); border-color: var(--action); }

/* ---- Operator chrome (header menu + secondary pages) ---- */
.account-menu { position: relative; }
.account-menu-summary {
  list-style: none;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
  font: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--if-radius-sm, 7px);
  padding: 0.22rem 0.6rem 0.22rem 0.35rem;
}
.account-menu-summary::-webkit-details-marker,
.account-menu-summary::marker { display: none; }
.account-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 12rem;
}
.account-menu-panel {
  position: absolute;
  right: 0;
  top: calc(100% + 0.35rem);
  min-width: 13rem;
  display: grid;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--if-radius-sm, 7px);
  box-shadow: var(--shadow);
  padding: 0.3rem;
  z-index: 8;
}
.account-who {
  margin: 0 0 0.2rem;
  padding: 0.25rem 0.55rem 0.4rem;
  border-bottom: 1px solid var(--line);
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--ink);
}
.account-menu-panel a,
.account-logout button {
  display: block;
  width: 100%;
  text-align: left;
  font: inherit;
  font-size: 0.9rem;
  color: var(--ink);
  background: transparent;
  border: 0;
  border-radius: var(--radius);
  padding: 0.4rem 0.55rem;
  text-decoration: none;
  cursor: pointer;
}
.account-menu-panel a:hover,
.account-logout button:hover {
  background: var(--action-soft);
  color: var(--ink);
}
.account-logout { margin: 0.15rem 0 0; padding: 0.15rem 0 0; border-top: 1px solid var(--line); }

.btn:not(.if-button), .btn-secondary:not(.if-button), .btn-danger:not(.if-button),
body.operator main form:not(.chat-composer) button:not(.if-button):not(.model-picker-btn) {
  font: inherit;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  padding: 0.45rem 0.85rem;
  border: 1px solid color-mix(in srgb, var(--action) 70%, var(--ink));
  background: var(--action);
  color: var(--btn-fg);
}
.btn-secondary:not(.if-button),
body.operator main form:not(.chat-composer) button.btn-secondary:not(.if-button):not(.model-picker-btn) {
  background: var(--paper);
  color: var(--ink);
  border: 1px solid var(--line-strong);
}
.btn-danger:not(.if-button),
body.operator main form:not(.chat-composer) button.btn-danger:not(.if-button):not(.model-picker-btn) {
  background: var(--cinnabar);
  color: var(--btn-fg);
  border: 1px solid color-mix(in srgb, var(--cinnabar) 70%, var(--ink));
}
.btn:not(.if-button):hover, body.operator main form:not(.chat-composer) button:not(.if-button):not(.model-picker-btn):hover { filter: brightness(1.05); }
.btn-secondary:not(.if-button):hover, body.operator main form:not(.chat-composer) button.btn-secondary:not(.if-button):hover {
  color: var(--action);
  border-color: var(--action);
  filter: none;
}

input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),
textarea,
select {
  border-radius: var(--if-radius-sm, 7px);
}

body.operator main input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not(.chat-composer-input),
body.operator main textarea:not(.chat-composer-input),
body.operator main select {
  width: 100%;
  margin-top: 0.3rem;
  padding: 0.45rem 0.6rem;
  background: var(--if-bg-raised, var(--paper));
  color: var(--ink);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
}
body.operator main fieldset {
  border: 1px solid var(--line);
  background: var(--surface);
  border-radius: var(--radius);
  margin: 0.8rem 0;
  padding: 0.75rem 0.9rem;
}
body.operator main legend {
  font-family: var(--font-display);
  font-weight: 600;
  padding: 0 0.3rem;
}
body.operator main table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--if-radius-sm, 7px);
  overflow: hidden;
}
body.operator main th,
body.operator main td {
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--line);
  font-size: 0.88rem;
}
body.operator main th {
  font-size: 0.7rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ash);
}

.connection-list { margin-top: var(--space-4); }
.connection-card { padding: 1rem 1.1rem; }
.connection-head {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  align-items: flex-start;
  flex-wrap: wrap;
}
.connection-chips { display: flex; flex-wrap: wrap; gap: 0.35rem; }

/* Alert-level role picks: chip checkboxes — the native input stays in the
   tree (opacity 0, still focusable) so keyboard + no-JS both work. */
.alert-level { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem; margin-top: 0.5rem; }
.alert-level-name { flex: 0 0 7rem; font-size: 0.82rem; color: var(--ink-muted); }
.role-check {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.2rem 0.6rem;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--surface);
  font-size: 0.82rem;
  color: var(--ink-muted);
  cursor: pointer;
  user-select: none;
}
.role-check::before {
  content: "";
  width: 0.55rem;
  height: 0.55rem;
  flex: none;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
}
.role-check:hover { border-color: var(--action); color: var(--ink); }
.role-check input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; }
.role-check:has(input:checked) { background: var(--action-soft); border-color: var(--action); color: var(--ink); font-weight: 600; }
.role-check:has(input:checked)::before { background: var(--action); border-color: var(--action); }
.role-check:has(input:focus-visible) { outline: 2px solid var(--focus); outline-offset: 2px; }
.alert-level[aria-invalid="true"] .role-check { border-color: var(--cinnabar); }
.connection-flags { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.6rem; }
.connection-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-top: 0.85rem;
  padding-top: 0.7rem;
  border-top: 1px dashed var(--line);
}
.connection-actions form { margin: 0; }
.provider-filter input { width: 100%; max-width: 22rem; }
.model-list { margin-top: 2rem; }
.model-list-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.model-list-head h2 { margin-bottom: 0.15rem; }
.model-list-head p { margin-top: 0; }
.model-refresh { margin: 0; align-self: center; }
.model-group-head {
  margin: 1.1rem 0 0.35rem;
  font-size: 0.95rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.model-group-count { font-weight: normal; }
.model-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  gap: 0.15rem 1rem;
}
.model-item {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.model-item .muted { font-family: var(--font-body, inherit); font-size: 0.72rem; }
.provider-help { margin: 0.35rem 0 0.6rem; }
.provider-key-form {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-top: 0.75rem;
  padding-top: 0.7rem;
  border-top: 1px dashed var(--line);
}
.provider-key-form input { flex: 1; min-width: 0; }
.telemetry-list { list-style: none; margin: var(--space-4) 0 0; padding: 0; display: grid; gap: var(--space-3); }
.telemetry-card { padding: 1rem 1.1rem; }
.telemetry-url { margin: 0.4rem 0 0; overflow-wrap: anywhere; }
.telemetry-form { margin-top: 0.75rem; padding-top: 0.7rem; border-top: 1px dashed var(--line); }
.telemetry-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.6rem 0.9rem;
}
.config-grid { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0.35rem 1rem; }
.config-grid dt { color: var(--ink-muted); font-size: 0.82rem; }
.config-grid dd { margin: 0; overflow-wrap: anywhere; }
.telemetry-field-wide { grid-column: 1 / -1; }
.telemetry-field span { display: block; color: var(--ink-muted); font-size: 0.8rem; margin-bottom: 0.2rem; }
.telemetry-field input, .telemetry-field select { width: 100%; }
.telemetry-actions { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-top: 0.7rem; }
.telemetry-inline-form { margin: 0; }
.telemetry-or {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 0.7rem;
  color: var(--ink-muted);
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.telemetry-or::before, .telemetry-or::after { content: ""; flex: 1; border-top: 1px dashed var(--line); }
.telemetry-auth-alt {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.6rem 0.9rem;
  max-width: 34rem;
}
.telemetry-auth-alt-note { grid-column: 1 / -1; display: block; }
.telemetry-help { margin-bottom: var(--space-3); }
.telemetry-help summary { cursor: pointer; font-weight: 600; }
.telemetry-steps { margin: 0.6rem 0; padding-left: 1.2rem; }
.telemetry-override { margin-top: 0.7rem; }
.telemetry-override summary { cursor: pointer; color: var(--ink-muted); font-size: 0.85rem; }
.endpoint-row {
  display: grid;
  grid-template-columns: 4.5rem 1fr auto;
  align-items: center;
  gap: 0.7rem;
  padding: 0.35rem 0;
}
.endpoint-label { font-weight: 600; }
.endpoint-value { overflow-wrap: anywhere; }
.endpoint-missing .endpoint-value { color: var(--ink-muted); font-style: italic; }
.endpoint-copy { padding: 0.15rem 0.55rem; font-size: 0.8rem; }
.probe-results { list-style: none; margin: var(--space-3) 0; padding: 0; display: grid; gap: 0.3rem; }
.probe-ok { color: var(--jade); }
.probe-fail { color: var(--cinnabar); }
.probe-results code { font-size: 0.8rem; color: var(--ink-muted); }
.operator-form label { display: block; color: var(--ink-muted); font-size: 0.88rem; }

.chat-thought { display: grid; gap: var(--space-2); }
.chat-reasoning {
  border: 1px dashed var(--line-strong);
  background: var(--surface-2);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
}
.chat-reasoning summary {
  cursor: pointer;
  font-size: 0.82rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--chat-thought, var(--plum));
}
.chat-reasoning-body, .chat-reasoning-text {
  margin: var(--space-2) 0 0;
  font-size: 0.88rem;
  color: var(--ink-muted);
  white-space: pre-wrap;
}
.chat-tools { display: grid; gap: var(--space-1); }
.chat-tool {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
}
.chat-action-bar { display: flex; gap: var(--space-2); margin-top: var(--space-2); }
.chat-action {
  appearance: none;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--ink);
  background: var(--paper);
  border: 1px solid var(--line-strong);
  padding: 0.22rem 0.65rem;
  cursor: pointer;
}
.chat-action:hover { color: var(--action); border-color: var(--action); }
.chat-action[data-copied] { color: var(--action); }
.chat-footer { display: grid; gap: var(--space-3); }
.chat-scroll-bottom {
  justify-self: center;
  appearance: none;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--ink);
  background: var(--paper);
  border: 1px solid var(--line-strong);
  padding: 0.22rem 0.65rem;
  cursor: pointer;
}
.chat-scroll-bottom:hover { color: var(--action); border-color: var(--action); }
.chat-indicator { margin: 0; }
.chat-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.65rem 1rem;
  margin: 0.85rem 0;
}
.chat-toolbar .meta-row { margin-top: 0; flex: 1 1 16rem; }
.chat-reset { margin: 0; margin-left: auto; }
.config-nav { margin: 0.35rem 0 1rem; }
.prompt-role-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.85rem;
}
.prompt-role-list > li {
  list-style: none;
  display: block;
  margin: 0;
  padding: 0;
}
.prompt-role-head {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  align-items: flex-start;
  flex-wrap: wrap;
}
.prompt-role h3 { margin: 0.15rem 0 0; }
.prompt-preview { margin: 0.55rem 0 0.35rem; }
.prompt-composed { margin: 0.35rem 0; }
.config-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-top: 0.55rem;
}
.inline-form { display: inline; margin: 0; }
.github-login {
  display: inline-block;
  margin: 0.35rem 0;
  font-weight: 600;
  background: var(--action);
  color: var(--btn-fg);
  border: 1px solid color-mix(in srgb, var(--action) 70%, var(--ink));
  padding: 0.45rem 0.85rem;
  text-decoration: none;
}

/* Guided Review human draft. */
.gd-human-draft { margin-block: var(--if-space-4, 1rem); }
.gd-human-draft textarea { width: 100%; box-sizing: border-box; }
.gd-draft-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(12rem, 18rem); gap: .75rem; align-items: start; }
.gd-save-state { font-size: .875rem; color: var(--if-color-success, #17803d); }
.gd-save-state[data-state="unsaved"], .gd-save-state[data-state="saving"] { color: var(--if-color-warning, #a16207); }
.gd-save-state[data-state="error"], .gd-save-state[data-state="conflict"] { color: var(--if-color-danger, #b91c1c); }
.gd-comment { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: .5rem; padding: .65rem; margin-block: .55rem; }
.gd-comment-head { display: flex; gap: .5rem; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.gd-comment-body { white-space: pre-wrap; margin-block: .45rem; }
.gd-inline-editor, .gd-general-form { border-top: 1px solid color-mix(in srgb, currentColor 16%, transparent); margin-top: .8rem; padding-top: .8rem; }
.gd-inline-fields { display: flex; flex-wrap: wrap; gap: .75rem; align-items: end; margin-block: .6rem; }
.gd-check { display: flex; gap: .35rem; align-items: center; }
.gd-comment-trigger { float: right; opacity: 0; border: 0; background: transparent; color: inherit; cursor: pointer; }
.gd-comment-trigger--pierre { opacity: 1; position: relative; z-index: 2; min-width: 1.25rem; min-height: 1.25rem; padding: 0 .15rem; border-radius: .25rem; background: var(--surface); color: var(--ink); }
.if-banner[hidden] { display: none; }
.if-button[hidden] { display: none; }
.gd-line:hover .gd-comment-trigger, .gd-line:focus-within .gd-comment-trigger { opacity: .85; }
.gd-preview-controls { display: flex; gap: .5rem; margin-top: 1rem; }
.gd-preview-payload { max-height: 28rem; overflow: auto; white-space: pre-wrap; }
.gd-walkthrough { margin-block: var(--if-space-4, 1rem); }
.gd-walkthrough-content h3 { margin-bottom: .2rem; }
.gd-walkthrough-controls { display: flex; gap: .5rem; margin-top: .75rem; }
.gd-spinner { display: inline-block; width: .8em; height: .8em; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: gd-spin .9s linear infinite; vertical-align: -.1em; }
@keyframes gd-spin { to { transform: rotate(360deg); } }
@media (max-width: 760px) { .gd-draft-grid { grid-template-columns: 1fr; } }
`.trim();

/** Embedding URL with the content fingerprint — see paths.ts. */
export const THEME_URL = versionedUrl(THEME_HREF, THEME_CSS);
