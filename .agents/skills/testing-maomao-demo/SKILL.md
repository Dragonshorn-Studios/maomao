---
name: testing-maomao-demo
description: How to run maomao locally for UI/E2E testing — demo server, login gate, seeding the SQLite DB, and sending signed GitHub webhook POSTs.
---

# Testing maomao locally

## Devin Secrets Needed

None for local testing — the demo server uses placeholder credentials.

## Demo server (fastest path to a working UI)

```
DATABASE_PATH=/tmp/maomao-test/demo.sqlite PORT=3100 npm run demo
```

- `src/demo/serve.ts` starts the full `createApp` server with fixture jobs (12) and a stub queue — no GitHub API calls are made.
- Defaults: `UI_PASSWORD=demo`, `UI_SESSION_SECRET=demo-session-secret-not-for-production`, `GITHUB_WEBHOOK_SECRET=demo-webhook`, `DATABASE_PATH=:memory:`.
- IMPORTANT: set `DATABASE_PATH` to a real file if you need to seed/inspect DB rows from another process; the `:memory:` default makes that impossible.
- `MAOMAO_DEMO_OPEN=1` disables the UI gate entirely — but gated pages like `/config/*` then 302 to `/` (`gateOn` checks), so do NOT use open mode when testing config pages.
- `MAOMAO_DEMO_EMPTY=1` skips job seeding.

## UI login

- Any protected path redirects to `/login?next=<path>`. Password form fields: `password`, `csrf_token` (hidden), `next`. Password is `demo`.
- The login POST needs the `maomao_csrf` cookie + matching `csrf_token` field — use the browser, or for curl: GET /login with a cookie jar, extract `csrf_token` from the form HTML, then POST it back.

## Seeding / inspecting the DB

Tables are migrated on `openDb`. Seed with better-sqlite3 from the repo's node_modules (script must run with the repo as resolution root — e.g. `createRequire('/home/ubuntu/repos/maomao/package.json')` or run the script from the repo dir). SQLite allows concurrent access from the script while the server runs; new rows appear on next page load.

`webhook_deliveries` columns: `provider`, `provider_instance` (e.g. `github`/`github.com` or `gitlab`/`gitlab.example.com`), `delivery_id`, `event`, `action`, `repo_full_name`, `actor`, `result`, `created_at` (ISO string).

## Signed GitHub webhook POSTs

`POST /webhooks/github` is a public path (no session, CSRF-exempt). Required headers:

- `x-github-event` — e.g. `ping`, `pull_request`, `check_run`, `issue_comment`
- `x-github-delivery` — unique delivery id
- `x-hub-signature-256` — `sha256=` + hex HMAC-SHA256 of the raw body with secret `demo-webhook`

Useful payload outcomes: `ping` → `ok: ping` recorded; `check_run` → `ignored: event check_run`; `pull_request` `action=edited` → `ignored: ignored action edited`; bad signature → 401 and nothing recorded. Payload context (`repository.full_name`, `action`, `sender.login`) lands in the new Repo/Actor columns.
