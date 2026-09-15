# Maomao

Self-hosted multi-agent pull request review service.

Maomao receives GitHub `pull_request` webhooks, checks out the **exact PR head SHA**, runs several constrained [OpenCode](https://opencode.ai) specialist reviewers, aggregates their evidence, and posts **one conservative GitHub `COMMENT` review**. It reviews code; it does not modify it, push branches, approve, or merge.

```text
GitHub pull_request webhook
        ↓
      Maomao (signature check → idempotent job)
        ↓
checkout exact PR head SHA into an isolated workspace
        ↓
reconcile prior Maomao findings (verify / bury) on this SHA
        ↓
risk route (poison-alert insertion point; currently the configured reviewer set)
        ↓
spawn N OpenCode reviewer runs (bounded concurrency)
        ↓
validate structured JSON + persist raw output
        ↓
one OpenCode aggregator over reviewer evidence
        ↓
post one GitHub COMMENT review for that SHA
```

## Architecture

The service is a single Node.js process:

- **HTTP** (Hono) for `/webhooks/github`, a small monitoring UI, JSON under `/api/jobs`, and SSE at `/events`
- **SQLite** for durable job / reviewer / log state (survives restarts)
- **in-process queue** with bounded job and reviewer concurrency (no Redis)
- **git fetch** of `refs/pull/<n>/head` plus the job SHA into a per-job workspace
- **OpenCode CLI** spawned as a worker (`opencode run`), not forked or vendored

Job states: `queued` → `preparing` → `reconciling` → `reviewing` → `aggregating` → `publishing` → `completed`, plus `failed`, `stale`, `cancelled`.

Every job is unique on `(repository, PR number, head SHA)`. A new `synchronize` SHA creates a new job and marks the previous one stale. Stale jobs never publish a review for the new commit.

Only the orchestrator talks to GitHub. Reviewers cannot post reviews or write into the repository.

## Requirements

- Docker with Compose v2 (self-host path below), **or** Node.js 22+ for local `npm` development
- git
- [OpenCode](https://opencode.ai/docs/cli/) — seeded onto a Docker volume by `scripts/install.sh` in the self-host path; on `PATH` (or `OPENCODE_BIN`) for local `npm`
- A GitHub App (see below)
- Provider credentials for whatever models you point OpenCode at

## Install (self-host)

On a host with Docker and git:

```bash
curl -fsSL https://raw.githubusercontent.com/Dragonshorn-Studios/maomao/main/scripts/install.sh | bash
```

From a local checkout of this repo, the same script:

```bash
./scripts/install.sh
```

The installer uses this checkout, or clones into `~/.maomao` (`MAOMAO_HOME` overrides). It prompts for GitHub App id / webhook secret / private key file, a UI password + session secret (either can be generated), and OpenCode provider keys / model ids. It writes `.env` (mode `600`) plus `github-app.pem`, bind-mounts the key, downloads the OpenCode CLI from GitHub releases onto the `maomao-opencode` volume, and runs `docker compose up -d`.

Create the GitHub App first (least-privilege table below). The installer does not create it in the browser.

Non-interactive (CI or already-exported env):

```bash
export GITHUB_APP_ID=123
export GITHUB_WEBHOOK_SECRET=...
export GITHUB_APP_PRIVATE_KEY_PATH=/path/to/app.pem
export UI_PASSWORD=...                 # generated if unset
export OPENCODE_REVIEWER_MODEL=anthropic/claude-sonnet-4-5
export ANTHROPIC_API_KEY=...           # or OPENAI_API_KEY / OPENROUTER_API_KEY / …
./scripts/install.sh --non-interactive
```

Then:

- UI: http://127.0.0.1:3000
- Health: `GET /health`
- Webhook: `POST /webhooks/github` — set this URL on the GitHub App

`--skip-start` writes `.env` and mounts only. `--upgrade-opencode` reinstalls the CLI into the OpenCode volume without rebuilding a derived Maomao image. `./scripts/install.sh --help` lists flags.

### Volumes and secrets

| Mount | Path in container | Purpose |
| --- | --- | --- |
| named volume `maomao-data` | `/data` | SQLite (`maomao.sqlite`) and PR workspaces |
| named volume `maomao-opencode` | `/opt/opencode` (`HOME`) | OpenCode CLI (`~/.opencode/bin`) plus its config/cache |
| bind `./github-app.pem` | `/run/secrets/github-app.pem` | GitHub App private key |

Provider API keys live in `.env` only (`env_file`). They are never copied into the image. `GITHUB_APP_PRIVATE_KEY_PATH` inside the container is `/run/secrets/github-app.pem`.

The container runs as `node` (uid **1000** in `node:22-bookworm-slim`). A `:ro` bind mount keeps the host file’s owner and mode, so `github-app.pem` must be readable by that uid (`chown 1000:1000 github-app.pem && chmod 400 github-app.pem`). Do not `chmod 644`. `EACCES: permission denied, open '/run/secrets/github-app.pem'` is host file mode/owner, not a wrong mount path — recreate Compose after fixing (`docker compose up -d --force-recreate`).

`docker compose down` and rebuilding the Maomao image leave both named volumes in place, so OpenCode and job data survive. `docker compose down -v` deletes them.

To bind-mount on the host instead of named volumes, put this in a `docker-compose.override.yml` (the installer already uses that file for the key):

```yaml
services:
  maomao:
    volumes:
      - ./data:/data
      - ./opencode:/opt/opencode
      - ./github-app.pem:/run/secrets/github-app.pem:ro
```

### Upgrades

Maomao app (keep OpenCode + SQLite):

```bash
cd ~/.maomao   # or your checkout
git pull
docker compose up -d --build
```

OpenCode CLI only (keep the Maomao image):

```bash
./scripts/install.sh --upgrade-opencode
# pin a release, then re-seed (recreating the container does not download a CLI):
# OPENCODE_VERSION=1.2.3 ./scripts/install.sh --upgrade-opencode
```

Pin `OPENCODE_VERSION` if you need a known-good CLI, then re-seed with `--upgrade-opencode`. See **OpenCode must honor the permission denies** before pointing Maomao at untrusted repositories.

### Manual Compose (no installer)

```bash
cp .env.example .env
# fill GitHub App + UI + OpenCode model / provider keys
cp /path/to/app.pem github-app.pem
chown 1000:1000 github-app.pem && chmod 400 github-app.pem
# uncomment the github-app.pem volume in docker-compose.yml, or copy the override the installer writes
./scripts/install.sh --upgrade-opencode
```

`--upgrade-opencode` downloads OpenCode on the **host** (GitHub releases) into `maomao-opencode` and starts Compose. Host seed is required for the first OpenCode install. The container entrypoint never downloads or executes a remote installer. Empty volume + bare `docker compose up` fails closed with instructions to run `./scripts/install.sh` / `--upgrade-opencode` (or mount a binary at `OPENCODE_BIN`). After a successful seed the binary lives on the volume; you do not rebuild a derived image just to keep OpenCode.

## Configure a GitHub App

Create a GitHub App for your user or org. Maomao needs **least privilege**:

| Permission | Access | Why |
| --- | --- | --- |
| Metadata | Read | Identify the installation / repository |
| Contents | **Read** | Fetch the PR head into a workspace |
| Pull requests | Read & write | Read the diff; post a `COMMENT` review |
| Issues | Write (optional) | Poison-alert mention/command comments on the PR conversation |

Do **not** grant Contents write, Actions write, Administration, Secrets, merge, or branch push. The strongest action Maomao can take is posting a pull request review.

Subscribe the app to **Pull request**, **Pull request review comment**, and **Issue comment** (for `@maomao escalate` in `manual` poison-alert policy). Set the webhook URL to:

```text
https://<your-host>/webhooks/github
```

Use a webhook secret and put it in `GITHUB_WEBHOOK_SECRET`. Download the app private key and set either `GITHUB_APP_PRIVATE_KEY` (PEM, `\n` newlines are fine) or `GITHUB_APP_PRIVATE_KEY_PATH`. Set `GITHUB_APP_ID` to the numeric app id.

Install the app on the repositories you want reviewed.

Events handled by default: `opened`, `reopened`, `synchronize`, `ready_for_review`. Draft PRs are ignored unless `REVIEW_DRAFTS=true`. Also subscribe the app to **Pull request review comment** so thread replies can bury or reopen findings.

## Configure OpenCode models

Maomao does not embed a model vendor. It runs:

```bash
opencode run --format json --dir <workspace/repo> --model <provider/model> --file pr.diff ...
```

Set:

```bash
OPENCODE_BIN=opencode
OPENCODE_REVIEWER_MODEL=anthropic/claude-sonnet-4-5
OPENCODE_AGGREGATOR_MODEL=anthropic/claude-opus-4-6   # optional; defaults to reviewer model
```

Use any `provider/model` string OpenCode understands (`opencode models`). Supply API keys the way OpenCode expects, for example `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`. Those are passed through to the child; GitHub App credentials are not.

Default specialist roles (override with `REVIEWER_ROLES`):

- `correctness` — regressions / broken logic
- `security` — trust boundaries
- `tests` — missing edge cases
- `architecture` — coupling / layering
- `api` — backwards compatibility
- `maintainer` — merge blockers

Each run has a timeout (`OPENCODE_TIMEOUT_MS`), retries (`OPENCODE_MAX_RETRIES`), and a concurrency cap (`OPENCODE_REVIEWER_CONCURRENCY`).

### Risk-aware specialist routing

By default Maomao runs a **pre-review router** before specialists. A deterministic scanner extracts cheap signals (file/line counts, languages, auth/secrets/billing/migrations/deploy, lockfiles, tests, PR title/body). An optional low-cost router model may refine the set. Output is a profile plus allowlisted role ids:

- `observation` — 1–2 specialists for trivial or narrow changes
- `diagnosis` — 3–4 relevant specialists for ordinary changes
- `poison-alert` — relevant specialists plus optional escalation for high-risk or large changes

Set `REVIEWER_ROUTING=fixed` to keep the previous always-on reviewer list. `deterministic` uses only the scanner; `model` uses the router model with hard-risk override; `hybrid` (default) uses both.

Hard-risk **file paths** (auth, secrets, billing, migrations, deploy) can escalate the profile. PR title and body are untrusted hints only and cannot force that escalate. The model cannot downgrade file/diff hard-risk triggers. Invalid or failed routing falls back to `diagnosis` and still runs a review.

Optional: `OPENCODE_ROUTER_MODEL`, `ROUTER_TIMEOUT_MS`, `ROUTER_MAX_DIFF_CHARS`, `ROUTER_MAX_REVIEWERS`.

### Poison-alert escalation

`poison-alert` can use two independent channels. Neither has a hardcoded model, provider, username, or bot.

Internal: a second, bounded pass with `POISON_ALERT_INTERNAL_MODEL` (any configured `provider/model`), separate cost/token/timeout/retry caps, and a distinct usage record. It verifies or refines first-pass findings. If the model is missing or over budget, Maomao keeps the first pass unless `POISON_ALERT_INTERNAL_FALLBACK=fail`. Over-budget is not retried.

External: fire-and-forget **after** Maomao publishes its own review. Targets are JSON in `POISON_ALERT_EXTERNAL_TARGETS_JSON` (`mention`, `command`, or signed `webhook`). Webhook URLs/secrets are env refs; HTTPS is required and private/loopback destinations are rejected. Mention/command fields are validated so configuration cannot inject comment content.

Policies: `internal_only`, `external_only`, `internal_then_external` (external only if the internal pass still meets `POISON_ALERT_EXTERNAL_MIN_SEVERITY`), `internal_and_external`, `manual` (`@maomao escalate` from write/maintain/admin collaborators, or a personal-repo OWNER when the collaborator API 404s, loop-safe against bot/marker comments). Partial target failure is stored as `dispatch_failed` and can be retried.

Maomao does not queue, claim, poll, or ingest external review results. The UI shows immediate dispatch status only.

Mention/command dispatch uses a GitHub issue comment and needs **Issues: Write** on the GitHub App. Webhook-only escalation does not.

Maomao records OpenCode `step_finish` usage across every unique agent step (including tool-call steps). Token totals include input, output, reasoning, and cache read/write when the CLI reports them. **These figures are provider/OpenCode-reported usage, not an independently calculated invoice.** If the JSON stream ends without a matching `step_finish` (see [opencode#26855](https://github.com/anomalyco/opencode/issues/26855)), the UI marks usage incomplete and treats the stored numbers as a minimum.

## Run locally

```bash
cp .env.example .env
# fill GitHub App + OpenCode settings; put `opencode` on PATH
npm install
npm run dev
```

Then:

- UI: http://127.0.0.1:3000
- Health: `GET /health`
- Webhook: `POST /webhooks/github`

```bash
npm test
npm run build
npm start
```

## Monitoring UI

The monitoring UI is a small server-rendered apothecary-notebook console (muted jade, parchment, ink). Visual tokens live in `src/ui/theme.ts` and are served at `/assets/maomao.css` — separate from job orchestration. Appearance is `light`, `dark`, or `system`, persisted in `localStorage`. Fonts are system stacks only.

`/` lists recent jobs as specimen cards: repo, PR, SHA, state, elapsed time, `n / m` reviewers, aggregator, model/provider, token/cost totals, and findings by severity.

`/jobs/:id` shows the immutable reviewed SHA, base/head refs, per-reviewer cards (role, state, duration, model, provider, token breakdown, cost, raw vs normalized output), aggregator diagnosis, findings, and a monospace log panel. Pages refresh over SSE. Token and cost figures are OpenCode/provider-reported usage, not an invoice.

To preview the UI with fixture jobs (no GitHub App or OpenCode required):

```bash
npm run demo
# open http://127.0.0.1:3000  password: demo
# MAOMAO_DEMO_EMPTY=1 npm run demo   # empty queue
```

The home page also has an operator form to paste a GitHub pull request URL (`https://github.com/owner/repo/pull/123`). Maomao resolves that PR through the GitHub App installation, then enqueues through the **same** job store and queue as webhooks (same `(repo, PR, head SHA)` idempotency and stale handling). Drafts follow `REVIEW_DRAFTS`. This is for testing before webhooks are wired; it is behind the same session gate as the rest of the UI.

### Session password (required in production)

`/`, `/jobs/*`, `/api/*`, and `/events` can be left open for local development. **If you expose Maomao beyond localhost, set both:**

```bash
UI_PASSWORD=a-long-password
UI_SESSION_SECRET=a-long-random-string   # e.g. openssl rand -hex 32
```

Aliases: `MAOMAO_UI_PASSWORD`, `MAOMAO_UI_SESSION_SECRET`. Setting only one of the two is a startup error.

With both set, GET/POST `/login` issues an **HttpOnly**, **SameSite=Lax** cookie (`maomao_session`), signed with `UI_SESSION_SECRET`. The cookie is **Secure** when the request is HTTPS (including `X-Forwarded-Proto: https`). Unauthenticated HTML pages redirect to `/login`; `/api/*` and `/events` return 401. `/webhooks/github`, `/health`, and `/assets/maomao.css` stay public (no cookie). This is a shared-password gate, not HTTP Basic Auth, OAuth, or a user database.

If both variables are unset, the UI stays open so `npm run dev` on loopback still works. Do not ship that configuration on a public address.

## Security / trust boundary

Checked-out PR code is **untrusted input**. For MVP, reviewers are for static inspection:

- git hooks are disabled (`core.hooksPath=/dev/null`); submodules are not fetched
- installation tokens authenticate `git fetch` as HTTP Basic (`x-access-token`, not Bearer), then `origin` is removed so the token never stays in the workspace remote URL
- GitHub private keys, webhook secrets, UI passwords, session secrets, and installation tokens are stripped from the OpenCode environment
- untrusted `opencode.json` / `.opencode` / `.claude` from the PR are deleted before review
- OpenCode is launched with permissions that **deny** `bash`, `edit`, `write`, `webfetch`, and related tools; `read` / `glob` / `grep` are allowed
- the repo tree is marked read-only after checkout
- Maomao never executes `npm install`, tests, or repo-defined agents

### OpenCode must honor the permission denies

Maomao passes those denies through `OPENCODE_PERMISSION` and `OPENCODE_CONFIG_CONTENT`. **The sandbox is only as strong as the OpenCode binary.** Operators must:

- run a **known-good OpenCode build** that actually enforces those env/config flags
- not assume a model “will behave” if the CLI ignores denies, auto-approves tools, or loads extra plugins
- treat a future OpenCode default or host-level plugin that re-enables `bash`/`edit` as a host compromise path: malicious PR code must not regain a shell that way

If you cannot pin and verify OpenCode’s permission behavior, do not point Maomao at untrusted repositories.

### Provider credentials in the process environment

OpenCode children inherit a **narrow allowlist** of env vars (provider API keys, `OPENCODE_*`, proxy, `PATH`/`HOME`, …) so BYO models keep working. That list includes broad prefixes such as `AWS_`, `BEDROCK_`, and `VERTEX_`. **Do not run Maomao on a host whose process environment already holds unrelated cloud credentials** — those keys would be visible to the reviewer process. Prefer a dedicated user/container whose env only contains the GitHub App material plus the model provider you intend.

OpenCode is still a powerful process. Keep Maomao on a locked-down host and do not run it as root.

## GitHub review policy

- Actionable findings → one `COMMENT` review, SHA-anchored (`commit_id` = job head SHA), with inline comments when GitHub accepts the locations
- No findings → silent unless `POST_EMPTY_REVIEW=true`
- **Never** `APPROVE` or `REQUEST_CHANGES` in this version
- Duplicate webhook deliveries reuse the existing job; publication also looks for a `<!-- maomao-review sha=... -->` marker
- Inline comments include `<!-- maomao-finding id=<fingerprint> sha=<reviewed-sha> -->` so later reviews can reconcile the same finding after the line moves

## Finding reconciliation and `@maomao bury`

When a later commit arrives, Maomao fetches its own **unresolved** review threads, applies any human overrides, and re-checks remaining findings against the **current head SHA** with a narrow verifier. Only then does it risk-route (the `poison-alert` insertion point) and run specialists.

Classifications:

| Status | Meaning | GitHub thread |
| --- | --- | --- |
| `resolved` | Verifier has enough evidence the problem is gone | Resolved after the job succeeds |
| `still_valid` | Same problem still applies | Left open |
| `moved` | Same problem at a new path/line | New inline comment, then the old thread is resolved |
| `uncertain` | Not enough evidence to close safely | Left open |
| `dismissed` | An authorized human buried it | Resolved when the command is accepted |

Model absence is non-evidence: a finding disappearing from a new generative review is **not** by itself proof it was fixed. Failed or stale jobs never close existing threads.

### Manual overrides

Reply **inside a Maomao review thread** (not on a human comment, and not as a reaction):

| Comment body | Effect |
| --- | --- |
| `@maomao ignore` | Dismiss this finding |
| `@maomao bury` | Same as ignore |
| `🌱` (nothing else in the comment) | Same as ignore |
| `@maomao reopen` | Clear the dismissal and unresolve the thread when GitHub allows it |

`dismissed` means “acknowledged and intentionally ignored”, not “fixed”. `resolved` and `dismissed` stay distinct in SQLite, logs, and the job Findings list. Open findings stay full cards; buried and resolved rows collapse under a muted count until you expand them (status badge, location, and title stay visible in the summary).

Dismissal is scoped to that **finding fingerprint on that pull request**, not the whole repository. The same fingerprint will not be re-reported on later SHAs of that PR unless someone `@maomao reopen`s it.

Who may issue commands: repository `write`, `maintain`, or `admin`. A personal-repository `OWNER` association is accepted only when the collaborator API reports `none` (GitHub 404s some owners); it never upgrades an explicit `read`/`triage` permission. Org members who 404 the collaborator API are ignored (fail closed). Webhook signatures are verified. Duplicate deliveries and repeated commands are no-ops.

The fingerprint is based on normalized path, category, and code identifiers (camelCase / snake_case) in the finding text — not solely the line number. When no code identifiers are present it falls back to normalized summary wording.

The verifier only receives the prior finding plus nearby current file/diff context, and it finishes before risk routing so a buried or already-fixed finding cannot inflate the next review into `poison-alert`.

## Configuration reference

See `.env.example`. Notable knobs: `REVIEW_DRAFTS`, `POST_EMPTY_REVIEW`, `JOB_CONCURRENCY`, `WORKSPACE_ROOT`, `DATABASE_PATH`, `MAX_INLINE_COMMENTS`, `PULL_REQUEST_ACTIONS`, `OPENCODE_VERIFIER_MODEL`, `RECONCILE_MIN_CONFIDENCE`, `UI_PASSWORD`, `UI_SESSION_SECRET`, `REVIEWER_ROUTING`, `POISON_ALERT_POLICY`.

## Follow-ups (not in this MVP)

- Automatic `APPROVE` / `REQUEST_CHANGES` once operators trust the aggregator
- CI / check-run status in reviewer prompts
- Submodule checkout
- Resume a reviewer run mid-job instead of re-running after process restart
- Forges other than GitHub
- Marller registration as a trusted review source

## License

MIT
