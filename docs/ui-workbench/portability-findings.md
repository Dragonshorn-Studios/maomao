# Portability findings — Sumomo's UI workbench → Maomao

Maomao is the **second adopter** of the UI workbench pattern. The first was [Sumomo](https://github.com/Dragonshorn-Studios/sumomo) ([issue #232](https://github.com/Dragonshorn-Studios/sumomo/issues/232), docs: [README](https://github.com/Dragonshorn-Studios/sumomo/blob/main/docs/ui-workbench/README.md), [adoption guide](https://github.com/Dragonshorn-Studios/sumomo/blob/main/docs/ui-workbench/adoption-guide.md)). The port crosses a framework boundary: **Laravel/Blade/Livewire → Node.js/Hono/React**.

This document records what transferred unchanged, what needed an adapter and why, what did not transfer at all, and the smallest contract a third project and a central gallery could agree on.

Operator documentation for Maomao's workbench: [README.md](README.md).

## 1. What was reused unchanged

The story / catalog / preview contract is framework-agnostic and moved verbatim. Only the implementation differs.

| Contract element | Rule | Maomao |
| --- | --- | --- |
| Story id | Lowercase slug, `^[a-z0-9]+(?:-[a-z0-9]+)*$` | Same pattern, enforced by Zod (`slugSchema`) |
| Variant id | Lowercase slug, same rule | Same pattern |
| Story metadata | `title`, `category`, `family`, `sourceFiles`, `defaultViewport`, `notes` | Same keys, same meanings |
| Source-file references | Repository-relative paths, shown in the gallery and checked by the validator | Same, plus a check that each path resolves inside the repository |
| Viewport presets | `mobile`, `tablet`, `desktop` | Same names, same sizes (390×844, 834×1112, 1440×900) |
| Catalog JSON | `generatedBy`, `viewports`, `stories[]` with `id`, `title`, `category`, `family`, `defaultViewport`, `sourceFiles`, `uses`, `notes`, `variants[]` (`id`, `title`, `url`, `frameUrl`) | Same key names, same types; `generatedBy` is `"maomao-ui-workbench"` |
| Gallery | Grouped by category, searchable | Same shape |
| Story page | Variant links, viewport presets, theme toggle, iframe of the frame | Same |
| Frame URL | A separate document that holds the production markup | Same |
| `?frozen=1` | Freezes animations for deterministic screenshots | Same semantics |
| Design tokens | The app's tokens rendered at `/dev/ui/tokens` | Same URL; the tokens are parsed from Maomao's theme stylesheet |
| Composition | `uses` / `used-by` edges between stories | Same shape, but **declared** rather than derived — see §2 |

### URL semantics

The four URL shapes are unchanged, so a browser agent written against Sumomo's workbench works against Maomao's without changes:

| Shape | Purpose |
| --- | --- |
| `/dev/ui` | The gallery |
| `/dev/ui/catalog.json` | The machine-readable catalog |
| `/dev/ui/{story}/{variant}` | The story page |
| `/dev/ui/{story}/{variant}/frame` | The frame document — the document that contains the production markup |

Sumomo's workbench also serves a design-token page at `/dev/ui/tokens`; Maomao does too, at the same URL.

Query parameters carried over unchanged: `?viewport=` (preset name), `?theme=`, and `?frozen=1`.

## 2. What required an adapter

### SSR framework

| | Sumomo | Maomao |
| --- | --- | --- |
| Rendering | Blade / Livewire views | TypeScript template-string renderers (`src/ui/pages.ts`) |
| Output | A rendered view | A **full HTML document** (the renderer returns the whole page) |

Maomao's `layout()` wraps a body in the app shell (top bar, account menu). A workbench frame must show *one component*, not the shell. The adapter is `layoutBody()` in `src/ui/layout.ts`: it extracts the `<main id="main">` body of a page rendered by `layout()`, so a frame shows the component body alone.

**Production files were only touched additively.** `src/ui/layout.ts` gained the `MAIN_OPEN` / `MAIN_CLOSE` markers and the exported `layoutBody()` helper next to them; `layout()` now interpolates those constants, so the production output is byte-identical. `src/ui/pages.ts` gained an `export` on `renderQueueCard`, so the workbench can frame the real component instead of a copy of it — no behaviour change. `src/auth.ts` marks the workbench prefix as public and CSRF-exempt (the workbench has its own gate), and `src/server.ts` mounts the routes with that gate.

The `layoutBody()` adapter is the one place where the workbench reaches into production rendering, and it is a pure addition next to the marker that writes it — a change to the shell cannot silently break the frames.

### Story runtime

| | Sumomo | Maomao |
| --- | --- | --- |
| Server-rendered story | Blade / Livewire renders on the server | A production renderer produces the fragment on the server |
| Client story | React mounts client-side | React mounts client-side — **from the production bundle** |

In Maomao the React island is the *production* bundle, served at `/assets/chat.js`, mounted through the same `<script id="maomao-chat-config">` JSON contract the app itself uses. The workbench therefore has **no second React entry point**: the preview runs the same bundle a user runs. The only thing the adapter rewrites is the island's `streamUrl` (see below).

### Assets

| | Sumomo | Maomao |
| --- | --- | --- |
| Styles | Vite asset graph (plus Flux / Livewire assets) | One hand-written theme stylesheet, `src/ui/theme.ts` → `/assets/maomao.css` |
| Scripts | Vite-built bundles | esbuild bundles (`npm run build:vendor`) |

Because Maomao has no bundler graph, the workbench serves the assets at their **production paths** — the frame loads `/assets/maomao.css` and the chat bundle from `/assets/chat.js`, so a preview looks exactly like the page it came from. A frame only references a bundle that exists on disk (`src/ui-workbench/assets.ts`), so a fresh checkout without `npm run build:vendor` does not produce a broken script tag.

### Validation

| | Sumomo | Maomao |
| --- | --- | --- |
| Command | `php artisan ui:workbench:validate` | `npm run ui:validate` |
| Checks | Unique ids, slug format, non-empty variants, existing source files | The same checks |
| Implementation | — | Expressed in Zod against the same schemas the catalog is served from |

Maomao's validator additionally checks that the assembled catalog matches the published schema, that every variant renders a non-empty fragment — a story that throws is worse than no story at all — and that every composition edge points at a registered story.

### Browser suite

| | Sumomo | Maomao |
| --- | --- | --- |
| Runner | Playwright | Playwright |
| Projects | Desktop and mobile | Desktop (1440×900) and mobile (390×844) |
| Server | Started by the runner | Started by `tests/e2e/global-setup.ts` |

One adapter: Playwright's `webServer` probes the URL **before** it starts anything. On a host where a port that has just closed stops answering instead of rejecting, that probe waits for a TCP timeout — minutes, with no failure to show for it. Maomao's global setup binds the port first and waits for the server's own readiness line, so the suite never probes a port that has no listener. The suite also uses its own port so it never collides with a workbench open in another terminal.

### Safety middleware

| | Sumomo | Maomao |
| --- | --- | --- |
| Mechanism | Laravel middleware | A Hono middleware (`src/ui-workbench/gate.ts`, `mount.ts`) |
| Placement | Guard the workbench routes | Placed **before every other middleware**, so a denied request is a hard `404` produced before the operator login, the session gate, or any route handler runs |
| Conditions | Workbench disabled outside development | Flag on **and** not production **and** loopback peer |
| Failure mode | — | Hard `404` — never a redirect, never a partial page |

The peer check reads the **socket** address only. `X-Forwarded-For` is deliberately ignored: a spoofed header must never pose as loopback. Maomao's `127.0.0.0/8` acceptance is broader than a literal `127.0.0.1` match, but `::ffff:127.0.0.1` is normalized to `127.0.0.1` so both spellings match.

### Family vocabulary (the one intentional difference)

| | Families |
| --- | --- |
| Sumomo | `blade`, `livewire`, `react` |
| Maomao | `ssr`, `react` |

Maomao has no Livewire, and it has exactly one server-rendered rendering path: TypeScript functions that return HTML strings. Splitting that path into two families (`blade` and `livewire`) would name a distinction Maomao's renderer does not make. `ssr` therefore covers both of Sumomo's server-rendered families, and `react` keeps its name.

This is a deliberate vocabulary deviation, and it is the only one. A third project that has both Blade and Livewire should keep its own families rather than inherit `ssr` — the family vocabulary is **not** part of the common contract (see §4).

### Composition edges are declared, not derived

Sumomo derives `uses` / `used-by` edges by scanning a story's view for `<x-…>` component tags and Livewire mounts, then resolving those tags back to the stories that own the referenced files. The derivation is possible because a Blade view names its components in its own markup.

Maomao's renderers are plain TypeScript functions that return HTML strings. A function that renders a finding card does not name the finding card in its own source — the composition lives at the call site, in the preview. Maomao therefore **declares** the edges on the story:

```ts
{
  id: "job-detail",
  // …
  uses: ["finding-card", "reviewer-run", "severity-chips"],
}
```

The catalog publishes the same ids, the story page shows them as *Uses* and *Used by*, and `npm run ui:validate` rejects an edge that points at an unknown story or at the story itself. The trade-off is deliberate: an explicit edge is reviewable in a diff, while a derived one is only as good as the parser behind it.

The key name, its type (`slug[]`), and its position in the catalog JSON stay exactly as Sumomo publishes them, so a browser agent parses both catalogs with one schema.

### The chat island's fake endpoint

| | Sumomo | Maomao |
| --- | --- | --- |
| Why a fake is needed | The story would otherwise reach a live service | Maomao's chat route is a **real streaming route to OpenCode** |
| Adapter | A mock-fetch interceptor | A fetch interceptor that allows **one** URL — the workbench's own fake endpoint — and rejects everything else |
| The fake | — | An in-process SSE handler (`POST /dev/ui/fake/chat/stream`) that streams a fixed sequence of frames shaped like the production stream |

Maomao's production chat route streams from OpenCode. Pointing the island at it would call a model, so the workbench repoints the island's `streamUrl` to `/dev/ui/fake/chat/stream`. The client's real code path still runs — it consumes real SSE frames — but the answer is a literal. Sumomo's mock-fetch interceptor became a fetch interceptor that only allows the workbench's own fake URL; the frames are deterministic, so screenshots stay stable.

### Design tokens

| | Sumomo | Maomao |
| --- | --- | --- |
| Source | `resources/css/app.css` on disk | `THEME_CSS` — a TypeScript string in `src/ui/theme.ts` |
| Parser | Reads the `@theme`, `:root`, and `.dark` blocks | Reads the `:root` and `html[data-theme="dark"]` blocks of the theme string |
| Page | `/dev/ui/tokens` | `/dev/ui/tokens` |

Maomao's tokens are semantic rather than prefixed (`--paper`, `--ink`, `--jade` instead of `--color-*`), so the parser classifies a token by what it *holds*: a colour, a font, a spacing step, or anything else. `var()` aliases (`--working: var(--plum)`) are resolved per theme, so a swatch shows the value the token actually stands for in that theme.

The swatches carry their own token set — the page emits the light and the dark declarations as scoped classes — so both values render side by side whatever the page's own theme is, with no change to the production stylesheet.

## 3. What did not transfer

| Sumomo feature | Why it did not transfer | What Maomao does instead |
| --- | --- | --- |
| `@livewire` directives | Livewire is a Laravel/Livewire concern; Maomao has no Livewire | React islands mount from the production bundle through a JSON config script tag |
| Flux components | A Laravel component library | Maomao's own renderers in `src/ui/pages.ts` |
| Vite asset graph | Maomao does not use Vite | One hand-written stylesheet plus esbuild bundles, served at their production paths |
| `REMOTE_ADDR` middleware semantics | Laravel exposes the peer through a server variable; the Node adapter has to reach for the socket address | The gate reads the TCP socket address and ignores `X-Forwarded-For` |
| Container fakes bound app-wide | Maomao has no DI container to bind fakes into | The fake lives inside the workbench route table (`fakeChatStream()`), and the frame sandbox blocks every other request |
| Alpine `x-data` gallery filtering | Alpine is not a Maomao dependency, and the workbench ships no framework | A small vanilla script filters the gallery cards by a `data-search` attribute |
| The "uses / used-by" composition graph | Sumomo derives the edges from Blade markup; Maomao's renderers are plain functions that never name the components they render | Maomao declares the edges on the story and validates them — see §2 |

## 4. Proposed minimal common contract

The smallest stable surface a third project and a central gallery should agree on. Everything else is project knowledge.

### In the contract

| Item | Rule |
| --- | --- |
| Story id | Lowercase slug: `^[a-z0-9]+(?:-[a-z0-9]+)*$`, unique across the registry |
| Variant id | Lowercase slug, same rule, unique within its story |
| Catalog JSON | `generatedBy` (string), `viewports` (record of `{ width: int, height: int }`), `stories[]` |
| Story object | `id` (slug), `title` (non-empty string), `category` (non-empty string), `family` (string), `defaultViewport` (one of the preset names), `sourceFiles` (string[]), `uses` (slug[]), `notes` (string or null), `variants[]` (at least one) |
| Variant object | `id` (slug), `title` (non-empty string), `url` (string), `frameUrl` (string) |
| URL shapes | `/dev/ui`, `/dev/ui/catalog.json`, `/dev/ui/{story}/{variant}`, `/dev/ui/{story}/{variant}/frame` |
| Viewport presets | `mobile` 390×844, `tablet` 834×1112, `desktop` 1440×900 |
| `?frozen=1` | Pauses animations and hides the caret so a screenshot is deterministic |
| Gate | Workbench answers only when the explicit flag is on **and** the process is not production **and** the peer is loopback; every denial is a hard `404` |
| Network | Previews never touch the network. Anything a story needs is a local, deterministic fake |
| Fixtures | Deterministic: literal values, no clock, no database, no network, no filesystem |
| Source references | Repository-relative paths that resolve inside the project repository |

### Deliberately not in the contract

- **Story implementation details** — how a story renders, and what its fixtures look like.
- **Fixture formats** — every project has its own row types and helper vocabulary.
- **The family vocabulary** — `blade`/`livewire`/`react` vs `ssr`/`react` is a project decision; the contract fixes only that `family` is a string.
- **The workbench UI itself** — the gallery layout, the chrome, the styles, and the search behaviour are each project's own.
- **The `uses` graph** — the key is kept for catalog compatibility, but the contract does not require a project to have a composition graph.

## 5. Open questions and follow-ups

- **Where the shared contract should live.** Today the contract is duplicated per project — Zod schemas in `src/ui-workbench/contract.ts` here, the equivalent on the Sumomo side. A future shared package would own the schemas, the slug rules, the viewport presets, and the catalog builder, and each project would keep its registry and fixtures.
- **Catalog versioning.** `generatedBy` identifies the producer but not a schema version. A central gallery aggregating several projects would need one before it can rely on the shape.
- **Central gallery discovery.** A gallery that lists several projects' workbenches needs a way to find them (a registry file, a static index, or a discovery endpoint). Nothing in the current contract covers that.
- **Family vocabulary across projects.** `ssr` vs `blade`/`livewire` is resolved per project. A central gallery would have to map them or display them verbatim.
- **Frame theming.** The `?theme=` parameter is part of the URL semantics; how a project maps it onto its own appearance is not.
- **Screenshot stability.** `?frozen=1` freezes animations, but font and network variance remains, and Maomao's browser tests are smoke-level (no pixel comparisons). A shared screenshot baseline would need a font policy.

**No cross-repo package is published by this ticket.** Maomao's workbench is self-contained: the contract, the registry, the renderer, the gate, and the validator all live in this repository. Nothing is extracted, versioned, or published for third-party consumption yet, and the two repositories share only the documented contract, not code.
