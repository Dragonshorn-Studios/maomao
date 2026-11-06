# UI workbench

A dev-only, fail-closed gallery of Maomao's **real** server-rendered HTML and its React island. Every preview renders the production component with a deterministic fixture — no markup is copied, no rendering path is duplicated, no job is started, and no model is ever called.

The workbench is the second adopter of the Sumomo UI workbench pattern ([sumomo#232](https://github.com/Dragonshorn-Studios/sumomo/issues/232); Sumomo's docs: [README](https://github.com/Dragonshorn-Studios/sumomo/blob/main/docs/ui-workbench/README.md), [adoption guide](https://github.com/Dragonshorn-Studios/sumomo/blob/main/docs/ui-workbench/adoption-guide.md)). Laravel/Livewire → Node/Hono/React. The shared contract and the deviations are recorded in [portability-findings.md](portability-findings.md).

## Startup

```bash
npm run ui:dev        # one command: builds the vendor bundles, then serves the workbench
npm run ui:validate   # checks the story registry, the catalog schema, and every preview
```

Then open <http://127.0.0.1:4310/dev/ui>.

The workbench needs **no** `.env` credentials, **no** GitHub App, **no** database, **no** OpenCode binary, **no** queue, **no** workers, and **no** Docker. `npm run ui:dev` boots the workbench routes plus the app's static assets only — Maomao's normal service initialization never runs.

The server watches the sources, so an edit to a renderer or a story is picked up on the next refresh of the browser. (The React chat bundle is built once at startup — re-run `npm run build:vendor` after editing `src/ui/chat-entry.tsx`.)

The host and port are overridable:

```bash
MAOMAO_UI_WORKBENCH_HOST=127.0.0.1 MAOMAO_UI_WORKBENCH_PORT=4310 npm run ui:dev
```

By default the server binds to loopback only. `npm run ui:dev` refuses to start with `NODE_ENV=production`.

## Routes

All routes are relative to the mount prefix `/dev/ui`.

| Route | Method | What it returns |
| --- | --- | --- |
| `/dev/ui` | `GET` | The gallery: every story, grouped by category, searchable in the browser. Shows family, variants, and source files. |
| `/dev/ui/catalog.json` | `GET` | The machine-readable catalog (see below). |
| `/dev/ui/{story}` | `GET` | The story page for the story's first variant. |
| `/dev/ui/{story}/{variant}` | `GET` | The story page: variant links, viewport presets, theme toggle, and an iframe of the frame. |
| `/dev/ui/{story}/{variant}/frame` | `GET` | The iframe document that contains the production markup. This is the URL a screenshot is taken of. |
| `/dev/ui/tokens` | `GET` | The app's design tokens, parsed from the theme stylesheet, with a swatch per theme. |
| `/dev/ui/fake/chat/stream` | `POST` | The fake in-process SSE endpoint the chat island talks to. |

An unregistered story id, an unknown variant id, and a path outside the registry all answer `404`. Nothing is loaded from a URL: the registry is the only place where a component becomes reachable.

### Query parameters

| Parameter | Values | Effect |
| --- | --- | --- |
| `?viewport=` | `mobile` (390×844), `tablet` (834×1112), `desktop` (1440×900) | The size of the preview frame. An unknown value falls back to the story's `defaultViewport`. |
| `?theme=` | `light`, `dark` | The color scheme of the frame and of the workbench chrome. `dark` is used only when the value is exactly `dark`; everything else is `light`. |
| `?frozen=1` | — | Pauses animations and hides the caret, so screenshots are deterministic. |

Both the story page and the frame accept them; the story page propagates them into the iframe URL.

## Catalog contract

`GET /dev/ui/catalog.json` is the machine-readable surface a browser agent uses: it reads the catalog, picks a story and a variant, opens the variant's `frameUrl`, and screenshots it.

```json
{
  "generatedBy": "maomao-ui-workbench",
  "viewports": {
    "mobile": { "width": 390, "height": 844 },
    "tablet": { "width": 834, "height": 1112 },
    "desktop": { "width": 1440, "height": 900 }
  },
  "stories": [
    {
      "id": "job-card",
      "title": "Job / status card",
      "category": "Jobs",
      "family": "ssr",
      "defaultViewport": "desktop",
      "sourceFiles": ["src/ui/pages.ts", "src/ui/metrics.ts", "src/ui/copy.ts"],
      "uses": [],
      "notes": "The dashboard queue card — the same markup the home page renders.",
      "variants": [
        {
          "id": "completed",
          "title": "Completed with findings",
          "url": "/dev/ui/job-card/completed",
          "frameUrl": "/dev/ui/job-card/completed/frame"
        }
      ]
    }
  ]
}
```

- `id` — a lowercase slug (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), for the story and for every variant.
- `family` — `ssr` or `react`.
- `sourceFiles` — repository-relative paths. `npm run ui:validate` checks that each one resolves inside the repository and points at an existing file.
- `uses` — the ids of the stories this one composes. Maomao **declares** the edges on the story (see [Composition](#composition)); the key and its type stay as Sumomo publishes them.
- `url` / `frameUrl` — the story page and the frame document of that variant.

The schema is declared with Zod in `src/ui-workbench/contract.ts` (`catalogSchema`) and is enforced at boot, in the tests, and in `npm run ui:validate`.

## Registered stories

| Story id | Family | Variants | What it renders |
| --- | --- | --- | --- |
| `job-card` | `ssr` | `completed`, `reviewing`, `failed`, `long-text` | The dashboard queue card — the real `renderQueueCard` markup, wrapped in the production `<ol class="queue">`. |
| `job-detail` | `ssr` | `completed-with-findings`, `failed`, `stale` | The per-job page: state, findings summary, reviewer runs, usage. |
| `finding-card` | `ssr` | `blocker`, `high`, `info`, `with-diff`, `unconfirmed` | One finding as the job page renders it: severity, location, reason, and the diff panel. |
| `reviewer-run` | `ssr` | `done`, `running`, `failed`, `stale` | One specialist run as the job page renders it: model, usage, and the reported findings. |
| `severity-chips` | `ssr` | `mixed`, `empty` | The severity chips a job card counts its findings with. |
| `stack-strip` | `ssr` | `members`, `empty` | The miniature stack rail a queue card shows for a stack review. |
| `reviewer-board` | `ssr` | `mixed`, `empty` | The `/reviewers` board of specialist runs. |
| `config-form` | `ssr` | `valid`, `invalid` | The structured profile editor with its field errors. |
| `model-picker` | `ssr` | `selected`, `empty` | The model dropdown every model field uses: the input, the button, and the grouped options. |
| `audit-table` | `ssr` | `populated`, `empty` | The configuration audit trail — who changed which profile revision, and when. |
| `deliveries-table` | `ssr` | `delivered`, `failed`, `empty` | The webhook delivery log — what maomao saw, what it did with it, and what it ignored. |
| `prompt-role-card` | `ssr` | `default`, `custom` | One reviewer role on the prompt page: the built-in instructions or the active override. |
| `empty-state` | `ssr` | `empty-queue`, `error-notice` | The dashboard with no jobs, and the dashboard after a failed request. |
| `brand-marks` | `ssr` | `all-marks` | Every inline mark the chrome draws: the role glyphs, the brand, the forge marks, the utility marks. |
| `forge-badge` | `ssr` | `github`, `gitlab`, `other` | The forge mark beside a change title: the provider mark, the repository, and the native change id. |
| `chat` | `react` | `empty`, `conversation`, `failed` | The assistant-ui "Ask Maomao" island, served from the real production bundle `/assets/chat.js`. |

The story book lives in `src/ui-workbench/stories.ts`. It is the only file that knows Maomao's UI exists.

## Composition

A story can declare the stories it composes:

```ts
{
  id: "job-detail",
  // …
  uses: ["finding-card", "reviewer-run", "severity-chips"],
}
```

The catalog publishes those ids, the story page lists them as **Uses** and **Used by**, and `npm run ui:validate` rejects an edge that points at an unknown story or at the story itself.

Sumomo derives the edges from the markup of a Blade view. Maomao's renderers are plain functions that never name the components they render — the composition lives at the call site, in the preview — so the story declares it. An explicit edge is reviewable in a diff.

## Design tokens

`GET /dev/ui/tokens` renders the app's design tokens, parsed from the theme stylesheet (`src/ui/theme.ts`), with a swatch per theme. The gallery header links to it.

Maomao's tokens are semantic rather than prefixed (`--paper`, `--ink`, `--jade`), so the parser classifies a token by what it holds — a colour, a font, a spacing step, or anything else — and resolves `var()` aliases per theme (`--working: var(--plum)` shows the plum of that theme). The swatches carry their own token set, so the light and the dark value render side by side without touching the production stylesheet.

## Adding a story

A story is an entry in `STORIES` (`src/ui-workbench/stories.ts`). It needs a slug id, a title, a category, a family, at least one variant, the source files it renders from, and a `preview` function that returns the HTML fragment shown inside the frame.

### An SSR story

SSR previews call the production renderers directly. The frame shows the component body without the app chrome, so wrap a full page in `layoutBody()` — it extracts the `<main id="main">` body of a page rendered by `layout()`.

```ts
import { layoutBody } from "../ui/layout.js";
import { renderJob } from "../ui/pages.js";
import { jobFixture, runClean } from "./fixtures.js";
import type { WorkbenchStory } from "./contract.js";

/** Previews never submit anything; the token only has to be a non-empty string. */
const WORKBENCH_CSRF = "workbench-csrf-token";

const DETAIL_JOB = jobFixture({ id: 500, state: "completed", aggregator_state: "done" });
const DETAIL_RUNS = [runClean({ id: 501, job_id: 500, role: "security", title: "Security" })];

export const JOB_SUMMARY: WorkbenchStory = {
  id: "job-summary",
  title: "Job summary",
  category: "Jobs",
  family: "ssr",
  sourceFiles: ["src/ui/pages.ts", "src/ui/metrics.ts"],
  defaultViewport: "desktop",
  notes: "One line about what this preview shows.",
  variants: [
    { id: "completed", title: "Completed" },
    { id: "failed", title: "Failed" },
  ],
  preview: (variant) => {
    const job = variant.id === "failed" ? { ...DETAIL_JOB, state: "failed" as const } : DETAIL_JOB;
    // layoutBody() drops the app chrome so the frame shows the component.
    return layoutBody(renderJob(job, DETAIL_RUNS, [], { csrfToken: WORKBENCH_CSRF }));
  },
};
```

A component that the production page renders inside a list keeps that wrapper, so the preview looks like the page it came from:

```ts
import { jobMetricsFromRuns } from "../ui/metrics.js";
import { renderQueueCard } from "../ui/pages.js";

preview: (variant) => {
  const job = variant.id === "failed" ? { ...CARD_JOB, state: "failed" as const } : CARD_JOB;
  const metrics = jobMetricsFromRuns(job, CARD_RUNS);
  // The card is an <li>; the production list wraps it.
  return `<ol class="queue">${renderQueueCard(job, metrics, "apothecary", WORKBENCH_CSRF)}</ol>`;
},
```

### A React story

React stories serve the **production bundle** — the same `/assets/chat.js` the app ships — mounted through the same `<script id="maomao-chat-config">` JSON contract. There is no second React entry point. The only thing that changes is the stream endpoint: it is repointed at the workbench's fake handler, so the island exercises its real client code path without a model in the loop.

```ts
import { layoutBody } from "../ui/layout.js";
import { renderChatPage, type ChatPageData } from "../ui/chat-page.js";
import { FAKE_CHAT_STREAM_URL } from "./stories.js";

const CHAT_CONFIG_PATTERN = /(<script id="maomao-chat-config" type="application\/json">)([\s\S]*?)(<\/script>)/;

/** The production chat page, framed: only the stream endpoint is repointed. */
function chatPreview(data: ChatPageData): string {
  const body = layoutBody(renderChatPage(data));
  const match = CHAT_CONFIG_PATTERN.exec(body);
  if (!match) return body;

  const config = JSON.parse(match[2]) as { streamUrl?: string };
  config.streamUrl = FAKE_CHAT_STREAM_URL;
  const json = JSON.stringify(config).replaceAll("</", "<\\/");
  return body.replace(match[0], `${match[1]}${json}${match[3]}`);
}
```

Then register it. `chatData()` is a local helper that builds the `ChatPageData` for a variant — see the `chat` story in `src/ui-workbench/stories.ts` for a worked example:

```ts
{
  id: "chat",
  title: "Ask Maomao chat island",
  category: "React islands",
  family: "react",
  sourceFiles: ["src/ui/chat-entry.tsx", "src/ui/chat-page.ts", "src/ui/chat-stream.ts"],
  defaultViewport: "desktop",
  notes: "The assistant-ui island. Its stream endpoint is a fake in-process handler.",
  variants: [
    { id: "empty", title: "No messages yet" },
    { id: "conversation", title: "Existing conversation" },
  ],
  preview: (variant) => chatPreview(chatData(variant.id)),
}
```

### Rules the registry enforces

`npm run ui:validate` fails with a nonzero exit code and an explanation when:

- a story id or variant id is not a lowercase slug, or a story repeats an id;
- a story has no title, no category, no variants, or an unknown default viewport;
- a variant has no title;
- a `sourceFiles` entry is absolute, contains `..`, resolves outside the repository, or points at a file that does not exist;
- the catalog does not match the published schema;
- a variant renders an empty fragment or throws.

## Adding a fixture

Fixtures live in `src/ui-workbench/fixtures.ts`. Every value is a literal: no clock, no database rows, no network, no filesystem. The same story therefore renders byte-identical markup on every run, which is what makes DOM assertions and screenshots stable.

```ts
import { T, jobFixture, runFixture } from "./fixtures.js";

const FAILED_JOB = jobFixture({
  id: 520,
  state: "failed",
  failure_reason: "opencode exited with code 1 after 3 attempts",
  aggregator_state: "failed",
  started_at: T.started,
  finished_at: T.finished,
  pr_title: "Retry the reviewer set after a transport failure",
});

const FAILED_RUNS = [
  runFixture({ id: 521, job_id: 520, role: "correctness", title: "Correctness", state: "failed", exit_code: 1 }),
];
```

Helpers available:

| Helper | What it builds |
| --- | --- |
| `T` | The frozen timestamps (`created`, `started`, `finished`). Fixtures never read the clock. |
| `jobFixture(overrides)` | A complete `JobRow` with only the interesting fields overridden. |
| `runFixture(overrides)` | A complete `ReviewerRunRow`. |
| `runWithFindings(severity, summary, overrides)` | A specialist run whose `normalized_json` carries one finding. |
| `runClean(overrides)` | A specialist run with no findings. |
| `aggregatorNormalized(findings, summary)` | The aggregator result stored on the job row. |
| `boardRow(run, job, overrides)` | A reviewer-board row: a run joined to the job that owns it. |
| `profileValuesFixture(overrides)` | The profile editor's values, filled in from the production defaults. |
| `PROFILE_FIELD_ERRORS` | The field errors shown next to the controls of the invalid variant. |

Fixtures contain invented data only — no secrets and no private PR content.

## Fake services

The workbench never calls anything external. Two mechanisms keep it that way.

**The fake chat endpoint.** `POST /dev/ui/fake/chat/stream` is an in-process SSE responder. It streams a fixed sequence of frames (a reasoning frame, a tool frame, a text delta, and a done frame) shaped like the production stream, so the island's real client code path runs without a model.

**The frame sandbox.** Every frame loads a script that:

1. replaces `window.fetch` so that only `/dev/ui/fake/chat/stream` can succeed — every other call rejects;
2. blocks every form submission (capture phase, before any island handler runs);
3. blocks navigation away from the preview (links are inert).

The consequence: job actions (retry, cancel, dequeue) render as inert markup. Their submissions never leave the browser.

## Safety model

The workbench fails closed. It answers only when **all** of the following hold:

| Condition | Detail |
| --- | --- |
| Explicit opt-in | `MAOMAO_UI_WORKBENCH_ENABLED=1`. Off unless the value is exactly `1`. `npm run ui:dev` is itself the opt-in: it enables the gate in-process instead of reading the flag. |
| Not production | `NODE_ENV` must not be `production`. |
| Loopback peer | The socket peer address must be loopback (`127.0.0.0/8` or `::1`). |
| No forwarding headers | A request that carries `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, or `X-Forwarded-Proto` is refused. |

- `X-Forwarded-For` is deliberately ignored — only the socket address counts, so a spoofed header can never pose as loopback.
- A request with a forwarding header is refused outright. Behind a same-host reverse proxy the socket peer is the proxy's address, so the loopback rule would prove nothing: refusing the header keeps "loopback only" true instead of silently degrading to "the proxy only", which would expose the previews and their CSRF-exempt fake endpoint to every remote visitor. Reach the workbench through an SSH tunnel or the standalone server instead of a proxy.
- A denial is a hard `404` (never a redirect, never a partial page), produced before any other middleware runs.
- The workbench routes are **not** behind the operator login: they are protected by the gate, like Sumomo's.
- In the production server the routes are mounted with the same gate (`src/server.ts`), so a deployed Maomao answers `404` for every `/dev/ui` path unless the flag is on, the process is not production, and the peer is on loopback.
- Enabling the workbench prints a startup warning naming the proxy caveat.

## Verification

```bash
npm run typecheck     # tsc over the app, the chat island, and the browser suite
npm test              # vitest: registry, catalog schema, gating, fake I/O, rendering
npm run ui:validate   # registry + the published catalog + every preview renders non-empty
npm run test:e2e      # playwright: the catalog → frame → screenshot flow
```

- `npm test` covers registry and validation, the catalog schema and URL stability, the 404 gating (flag off, production, non-loopback peer, and in the real production server), fake-I/O enforcement, and rendering assertions for every variant.
- `npm run test:e2e` runs two Playwright projects — desktop (1440×900) and mobile (390×844). It walks catalog → frame → screenshot, filters the gallery, renders the design tokens, checks the composition edges, asserts no console errors, and performs one safe interaction: the chat island answers with the deterministic fake reply. Screenshots land in `test-results/`; there are no pixel-perfect assertions.

The browser suite starts its own workbench on port **4311** (override with `MAOMAO_UI_WORKBENCH_PORT`), so it never collides with a workbench open in another terminal. It boots the server in `tests/e2e/global-setup.ts` rather than through Playwright's `webServer`: Playwright probes the URL before it starts anything, and on hosts where a closed port stops answering, that probe waits for a TCP timeout. The setup binds the port first and waits for the server's own readiness line.

## What cannot be previewed

- **Only presentation.** The workbench renders components, not multi-step flows. Auth, database state, and background workers are out of scope.
- **No app chrome.** A frame shows the component body, not the surrounding top bar and account menu of `src/ui/layout.ts`.
- **No model in the loop.** The chat island's transcript can be shown, but the reply only ever comes from the fake endpoint.
- **No actions.** Job actions render as inert markup; the sandbox blocks their submissions.
- **Smoke-level screenshots.** `?frozen=1` freezes animations, but font and network variance remains.

## Files

| File | Role |
| --- | --- |
| `src/ui-workbench/contract.ts` | Zod schemas and types for the shared contract: slug ids, viewport presets, catalog JSON shape. |
| `src/ui-workbench/catalog.ts` | Builds the catalog document. The server serves it and `npm run ui:validate` checks it, so the two cannot drift. |
| `src/ui-workbench/registry.ts` | The explicit allowlist (`WorkbenchRegistry`): only registered ids resolve, `problems()` reports malformed registries, source paths are validated to stay inside the repository. |
| `src/ui-workbench/stories.ts` | The app-specific seam: the story allowlist and the fixtures each story renders. |
| `src/ui-workbench/fixtures.ts` | Deterministic fixtures (literal timestamps, literal job/run/profile rows). |
| `src/ui-workbench/render.ts` | Gallery, story chrome, and the sandboxed frame. |
| `src/ui-workbench/app.ts` | The Hono routes. |
| `src/ui-workbench/gate.ts` | The fail-closed gate. |
| `src/ui-workbench/mount.ts` | Mounts the routes and the gate into a Hono app. |
| `src/ui-workbench/dev.ts` | The standalone dev server (`npm run ui:dev`). |
| `src/ui-workbench/validate.ts` | The checks `npm run ui:validate` runs, callable from a test. |
| `src/ui-workbench/validate-cli.ts` | The `npm run ui:validate` command-line entry point. |
| `src/ui-workbench/assets.ts` | Which built bundles exist on disk. |
| `src/ui-workbench/tokens.ts` | Parses the theme stylesheet into the design tokens the `/dev/ui/tokens` page renders. |
| `src/ui/layout.ts` | Production. Owns `layoutBody()`, the helper that extracts a page's `<main>` body. |
