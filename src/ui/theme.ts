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
  --ash: #7a776b;
  --line: #cfc8b6;
  --line-strong: #b7b09c;
  --focus: #1f6a4e;
  --shadow: 0 1px 0 rgba(26, 34, 28, 0.04);
  --code-bg: #eae4d4;
  --code-fg: #1a221c;
  --live: #1f6a4e;
  --btn-fg: #f3efe3;
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
  --ash: #8c8a7e;
  --line: #2e352e;
  --line-strong: #4a524a;
  --focus: #7dcea0;
  --shadow: 0 1px 0 rgba(0, 0, 0, 0.25);
  --code-bg: #0e120e;
  --code-fg: #d9d4c4;
  --live: #7dcea0;
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
    --ash: #8c8a7e;
    --line: #2e352e;
    --line-strong: #4a524a;
    --focus: #7dcea0;
    --shadow: 0 1px 0 rgba(0, 0, 0, 0.25);
    --code-bg: #0e120e;
    --code-fg: #d9d4c4;
    --live: #7dcea0;
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

.btn, .login button, .trigger button, .logout button.primary, .retry-job button {
  background: var(--jade);
  color: var(--btn-fg);
  border: 1px solid color-mix(in srgb, var(--jade) 70%, var(--ink));
  padding: 0.45rem 0.85rem;
  font-weight: 600;
  cursor: pointer;
  letter-spacing: 0.02em;
}
.btn:hover, .login button:hover, .trigger button:hover, .retry-job button:hover {
  filter: brightness(1.05);
}

.notice, .error, .warn {
  border: 1px solid var(--line);
  padding: 0.65rem 0.8rem;
  margin: 0.8rem 0;
  background: var(--surface);
}
.notice { border-color: var(--jade); background: var(--jade-soft); }
.error { border-color: var(--cinnabar); background: var(--cinnabar-soft); color: var(--ink); }
.warn { border-color: var(--amber); background: var(--amber-soft); }

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
.tick.running { background: var(--amber); border-color: var(--amber); animation: breathe 1.8s ease-in-out infinite; }
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
.state-reviewing, .state-aggregating, .state-publishing, .state-running, .state-preparing {
  background: color-mix(in srgb, var(--herb) 16%, var(--surface));
  border-color: var(--herb);
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
.run-actions {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  flex-wrap: wrap;
}
form.retry, form.retry-job {
  margin: 0;
  background: none;
  border: none;
  box-shadow: none;
  padding: 0;
  display: inline-flex;
}
.retry button {
  background: var(--paper);
  color: var(--ink);
  border: 1px solid var(--line-strong);
  padding: 0.22rem 0.6rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}
.retry button:hover { color: var(--jade); border-color: var(--jade); }
.retry-job { margin: 0.35rem 0 0.85rem; }
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

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  .specimen.is-live::before { animation: none; opacity: 1; }
}

@media (max-width: 720px) {
  .top { padding: 0.65rem 0.8rem; }
  main { padding: 1rem 0.8rem 2.5rem; }
  .tag, .top-link { display: none; }
  .appearance button { padding: 0.22rem 0.38rem; font-size: 0.68rem; }
  .meta-grid { grid-template-columns: 1fr; }
}

@media (min-resolution: 1.4dppx) {
  body { -webkit-font-smoothing: antialiased; }
}
`.trim();
