/** Visual tokens and CSS for the monitoring UI. Orchestration does not import this. */

export const THEME_HREF = "/assets/maomao.css";

export const THEME_CSS = `
:root {
  color-scheme: light;
  --paper: #f3efe3;
  --surface: #faf7ee;
  --surface-2: #ece6d6;
  --ink: #1a221c;
  --ink-muted: #5a6258;
  --jade: #1f6a4e;
  --jade-soft: #d5eadc;
  --herb: #4a6b58;
  --plum: #6b3a58;
  --plum-soft: #eadbe3;
  --cinnabar: #9c2432;
  --cinnabar-soft: #f3d6d6;
  --amber: #8a5a10;
  --amber-soft: #f1e4c4;
  --working: var(--plum);
  --working-soft: var(--plum-soft);
  --ash: #7a776b;
  --line: #cfc8b6;
  --line-strong: #b7b09c;
  --focus: #1f6a4e;
  --shadow: 0 1px 0 rgba(26, 34, 28, 0.04);
  --code-bg: #eae4d4;
  --code-fg: #1a221c;
  --live: var(--working);
  --btn-fg: #f3efe3;
  --chat-thought: var(--plum);
  --radius: 3px;
  --font-display: "Iowan Old Style", Palatino, "Palatino Linotype", "Book Antiqua", Georgia, "Times New Roman", serif;
  --font-ui: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, "SFMono-Regular", "Cascadia Mono", "Cascadia Code", "Liberation Mono", Menlo, Monaco, Consolas, monospace;
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2.25rem;
  --measure: 72rem;
}

html[data-theme="dark"] {
  color-scheme: dark;
  --paper: #121612;
  --surface: #1a1f1a;
  --surface-2: #232a23;
  --ink: #e8e4d6;
  --ink-muted: #a8a494;
  --jade: #7dcea0;
  --jade-soft: #1c3328;
  --herb: #9bb8a6;
  --plum: #d4a8c2;
  --plum-soft: #33232c;
  --cinnabar: #e88989;
  --cinnabar-soft: #3a2224;
  --amber: #e0b45c;
  --amber-soft: #3a3220;
  --working: var(--plum);
  --working-soft: var(--plum-soft);
  --ash: #8c8a7e;
  --line: #2e352e;
  --line-strong: #4a524a;
  --focus: #7dcea0;
  --shadow: 0 1px 0 rgba(0, 0, 0, 0.25);
  --code-bg: #0e120e;
  --code-fg: #d9d4c4;
  --live: var(--working);
  --btn-fg: #121612;
}

@media (prefers-color-scheme: dark) {
  html:not([data-theme="light"]):not([data-theme="dark"]) {
    color-scheme: dark;
    --paper: #121612;
    --surface: #1a1f1a;
    --surface-2: #232a23;
    --ink: #e8e4d6;
    --ink-muted: #a8a494;
    --jade: #7dcea0;
    --jade-soft: #1c3328;
    --herb: #9bb8a6;
    --plum: #d4a8c2;
    --plum-soft: #33232c;
    --cinnabar: #e88989;
    --cinnabar-soft: #3a2224;
    --amber: #e0b45c;
    --amber-soft: #3a3220;
    --working: var(--plum);
    --working-soft: var(--plum-soft);
    --ash: #8c8a7e;
    --line: #2e352e;
    --line-strong: #4a524a;
    --focus: #7dcea0;
    --shadow: 0 1px 0 rgba(0, 0, 0, 0.25);
    --code-bg: #0e120e;
    --code-fg: #d9d4c4;
    --live: var(--working);
    --btn-fg: #121612;
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
  background:
    repeating-linear-gradient(
      to bottom,
      transparent 0,
      transparent calc(1.4rem - 1px),
      color-mix(in srgb, var(--line) 32%, transparent) calc(1.4rem - 1px),
      color-mix(in srgb, var(--line) 32%, transparent) 1.4rem
    ),
    var(--paper);
  background-attachment: local;
  color: var(--ink);
}

a { color: var(--jade); text-underline-offset: 0.15em; }
a:hover { color: var(--herb); }

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
.brand svg { width: 1.15rem; height: 1.15rem; color: var(--jade); flex: none; }
.tag { color: var(--ink-muted); font-size: 0.82rem; }
.grow { flex: 1 1 6rem; }

.appearance {
  display: inline-flex;
  border: 1px solid var(--line);
  background: var(--surface);
  padding: 0.1rem;
  gap: 0.1rem;
}
.appearance button {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--ink-muted);
  font: inherit;
  font-size: 0.75rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 0.28rem 0.5rem;
  cursor: pointer;
}
.appearance button[aria-pressed="true"] {
  background: var(--jade-soft);
  color: var(--ink);
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
  border-radius: 0;
}

.btn, .login button, .trigger button, .logout button.primary, .chat-send {
  background: var(--jade);
  color: var(--btn-fg);
  border: 1px solid color-mix(in srgb, var(--jade) 70%, var(--ink));
  padding: 0.45rem 0.85rem;
  font-weight: 600;
  cursor: pointer;
  letter-spacing: 0.02em;
}
.btn:hover, .login button:hover, .trigger button:hover, .chat-send:hover {
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

.notice, .error, .warn {
  border: 1px solid var(--line);
  padding: 0.65rem 0.8rem;
  margin: 0.8rem 0;
  background: var(--surface);
}
.notice { border-color: var(--jade); background: var(--jade-soft); }
.error { border-color: var(--cinnabar); background: var(--cinnabar-soft); color: var(--ink); }
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
.login input, .trigger input {
  width: 100%;
  margin-top: 0.3rem;
  padding: 0.45rem 0.5rem;
  background: var(--paper);
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
  gap: 0.85rem;
}

.specimen {
  padding: 0.85rem 1rem 0.95rem;
  position: relative;
}
.specimen.is-live::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0.65rem;
  bottom: 0.65rem;
  width: 3px;
  background: var(--live);
  animation: breathe 2.6s ease-in-out infinite;
}

.specimen-head {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 0.8rem;
  align-items: baseline;
  justify-content: space-between;
}
.specimen-id {
  font-size: 0.7rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ash);
}
.specimen-title {
  margin: 0.25rem 0 0.15rem;
  font-size: 1.05rem;
  font-weight: 600;
}
.specimen-title a { color: var(--ink); text-decoration: none; }
.specimen-title a:hover { color: var(--jade); text-decoration: underline; }
.forge-mark {
  display: inline-flex;
  vertical-align: -0.2em;
  margin-right: 0.4rem;
  color: var(--ink);
}
.forge-mark svg { width: 1.15em; height: 1.15em; display: block; }
.forge-mark-text { font-size: 0.85em; color: var(--ink-muted); margin-right: 0.35rem; }
.forge-host { font-weight: 500; }

.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 1rem;
  align-items: center;
  margin-top: 0.45rem;
  font-size: 0.88rem;
}
.meta-row .pair { color: var(--ink-muted); }
.meta-row .pair strong { color: var(--ink); font-weight: 600; }

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
  gap: 0.3rem;
  padding: 0.08rem 0.45rem;
  border: 1px solid var(--line);
  background: var(--surface-2);
  font-size: 0.75rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ink);
  white-space: nowrap;
}
.state .mark { font-size: 0.7rem; }
.state-completed, .state-done { background: var(--jade-soft); border-color: var(--jade); }
.state-failed { background: var(--cinnabar-soft); border-color: var(--cinnabar); }
.state-stale, .state-cancelled { background: var(--amber-soft); border-color: var(--amber); }
.state-reviewing, .state-aggregating, .state-sniffing, .state-publishing, .state-running, .state-preparing, .state-routing, .state-reconciling {
  background: var(--working-soft);
  border-color: var(--working);
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
  font-size: 0.75rem;
  letter-spacing: 0.04em;
  padding: 0.05rem 0.4rem;
  border: 1px solid var(--line);
  background: var(--surface-2);
}
.sev-blocker, .sev-high { background: var(--cinnabar-soft); border-color: var(--cinnabar); }
.sev-medium { background: var(--amber-soft); border-color: var(--amber); }
.sev-low, .sev-info { background: var(--jade-soft); border-color: var(--herb); }

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
.retry button, .retry-job button, .dequeue button, a.cancel-review {
  background: var(--paper);
  color: var(--ink);
  border: 1px solid var(--line-strong);
  padding: 0.22rem 0.65rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.retry button:hover, .retry-job button:hover, .dequeue button:hover, a.cancel-review:hover {
  color: var(--jade);
  border-color: var(--jade);
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
.role svg { width: 1rem; height: 1rem; color: var(--herb); flex: none; }
.role-agg svg { color: var(--plum); }

.finding {
  padding: 0.85rem 1rem;
  margin: 0 0 0.75rem;
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
  padding: 0.5rem 0.75rem;
  overflow-x: auto;
  white-space: pre;
  max-height: 24rem;
  overflow-y: auto;
  position: relative;
}
/* Server-rendered line spans (no-JS fallback) share the panel pre's newlines —
   they must stay inline or every line renders double-spaced. */
.diff-panel .diff-add { color: var(--jade); }
.diff-panel .diff-del { color: var(--cinnabar); }
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
.typeahead-option[aria-selected="true"] { background: color-mix(in srgb, var(--herb) 26%, transparent); }
.typeahead-empty,
.typeahead-empty.is-active {
  cursor: default;
  color: var(--ink-muted);
  background: transparent;
}

.finding.is-buried,
.finding.is-resolved {
  border-style: dashed;
}
details.finding:not([open]) {
  opacity: 0.82;
}
details.finding {
  padding: 0.45rem 0.75rem;
  margin: 0 0 0.4rem;
}
details.finding > summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem 0.55rem;
  align-items: baseline;
  cursor: pointer;
  color: var(--ink);
  list-style: none;
}
details.finding > summary::-webkit-details-marker,
details.finding > summary::marker {
  display: none;
}
details.finding > summary::before {
  content: "▸";
  color: var(--ash);
  font-size: 0.72rem;
  width: 0.7rem;
  flex: none;
}
details.finding[open] > summary::before {
  content: "▾";
}
details.finding[open] > summary {
  margin-bottom: 0.35rem;
  padding-bottom: 0.35rem;
  border-bottom: 1px dashed var(--line);
}
details.finding .finding-title {
  flex: 1 1 10rem;
  font-family: var(--font-ui);
  font-weight: 600;
  font-size: 0.92rem;
}
details.finding .loc {
  margin: 0;
  font-size: 0.78rem;
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
  padding: 1.4rem 1.1rem;
  text-align: left;
}
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
}

@media (min-resolution: 1.4dppx) {
  body { -webkit-font-smoothing: antialiased; }
}

/* ---- Ask Maomao chat (island + no-JS fallback share these) ---- */
.chat-transcript { display: grid; gap: var(--space-3); margin: var(--space-4) 0; }
.chat-bubble {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  padding: var(--space-2) var(--space-3);
  max-width: 60rem;
}
.chat-bubble p { margin: var(--space-1) 0 0; overflow-wrap: anywhere; }
.chat-bubble-user { border-left: 3px solid var(--herb); }
.chat-bubble-assistant { border-left: 3px solid var(--jade); }
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
.chat-cancel:hover { color: var(--jade); border-color: var(--jade); }
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
.chat-suggestion:hover { color: var(--jade); border-color: var(--jade); }

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
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--line);
  padding: 0.1rem 0.5rem 0.1rem 0.28rem;
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
  background: var(--jade-soft);
  color: var(--ink);
}
.account-logout { margin: 0.15rem 0 0; padding: 0.15rem 0 0; border-top: 1px solid var(--line); }

.btn, .btn-secondary, .btn-danger,
body.operator main form:not(.chat-composer) button {
  font: inherit;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  padding: 0.45rem 0.85rem;
  border: 1px solid color-mix(in srgb, var(--jade) 70%, var(--ink));
  background: var(--jade);
  color: var(--btn-fg);
}
.btn-secondary,
body.operator main form:not(.chat-composer) button.btn-secondary {
  background: var(--paper);
  color: var(--ink);
  border: 1px solid var(--line-strong);
}
.btn-danger,
body.operator main form:not(.chat-composer) button.btn-danger {
  background: var(--cinnabar);
  color: var(--btn-fg);
  border: 1px solid color-mix(in srgb, var(--cinnabar) 70%, var(--ink));
}
.btn:hover, body.operator main form:not(.chat-composer) button:hover { filter: brightness(1.05); }
.btn-secondary:hover, body.operator main form:not(.chat-composer) button.btn-secondary:hover {
  color: var(--jade);
  border-color: var(--jade);
  filter: none;
}

body.operator main input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not(.chat-composer-input),
body.operator main textarea:not(.chat-composer-input),
body.operator main select {
  width: 100%;
  margin-top: 0.3rem;
  padding: 0.45rem 0.5rem;
  background: var(--paper);
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
  border-collapse: collapse;
  background: var(--surface);
  border: 1px solid var(--line);
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
.chat-action:hover { color: var(--jade); border-color: var(--jade); }
.chat-action[data-copied] { color: var(--jade); }
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
.chat-scroll-bottom:hover { color: var(--jade); border-color: var(--jade); }
.chat-indicator { margin: 0; }
.chat-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.65rem 1rem;
  margin: 0.85rem 0;
}
.chat-toolbar .meta-row { margin-top: 0; }
.chat-reset { margin: 0; }
.config-nav { margin: 0.35rem 0 1rem; }
.prompt-role-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.85rem;
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
  background: var(--jade);
  color: var(--btn-fg);
  border: 1px solid color-mix(in srgb, var(--jade) 70%, var(--ink));
  padding: 0.45rem 0.85rem;
  text-decoration: none;
}
`.trim();
