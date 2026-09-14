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

Job states: `queued` → `preparing` → `reviewing` → `aggregating` → `publishing` → `completed`, plus `failed`, `stale`, `cancelled`.

Every job is unique on `(repository, PR number, head SHA)`. A new `synchronize` SHA creates a new job and marks the previous one stale. Stale jobs never publish a review for the new commit.

Only the orchestrator talks to GitHub. Reviewers cannot post reviews or write into the repository.

## Requirements

- Node.js 22+
- git
- [OpenCode](https://opencode.ai/docs/cli/) on `PATH` (or `OPENCODE_BIN`)
- A GitHub App (see below)
- Provider credentials for whatever models you point OpenCode at

## Configure a GitHub App

Create a GitHub App for your user or org. Maomao needs **least privilege**:

| Permission | Access | Why |
| --- | --- | --- |
| Metadata | Read | Identify the installation / repository |
| Contents | **Read** | Fetch the PR head into a workspace |
| Pull requests | Read & write | Read the diff; post a `COMMENT` review |

Do **not** grant Contents write, Actions write, Administration, Secrets, merge, or branch push. The strongest action Maomao can take is posting a pull request review.

Subscribe the app to the **Pull request** webhook event. Set the webhook URL to:

```text
https://<your-host>/webhooks/github
```

Use a webhook secret and put it in `GITHUB_WEBHOOK_SECRET`. Download the app private key and set either `GITHUB_APP_PRIVATE_KEY` (PEM, `\n` newlines are fine) or `GITHUB_APP_PRIVATE_KEY_PATH`. Set `GITHUB_APP_ID` to the numeric app id.

Install the app on the repositories you want reviewed.

Events handled by default: `opened`, `reopened`, `synchronize`, `ready_for_review`. Draft PRs are ignored unless `REVIEW_DRAFTS=true`.

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

## Run locally

```bash
cp .env.example .env
# fill GitHub App + OpenCode settings
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

## Docker

```bash
cp .env.example .env
docker compose up --build
```

SQLite and workspaces live in the `maomao-data` volume (`/data` in the container). Mount `github-app.pem` and set `GITHUB_APP_PRIVATE_KEY_PATH=/run/secrets/github-app.pem` if you prefer a file over an env var.

The image boots the Maomao process. Install OpenCode in a derived image or bind-mount the binary, and pass provider keys via `.env`. Example derived image:

```dockerfile
FROM ghcr.io/your-org/maomao:latest
USER root
RUN apt-get update && apt-get install -y curl && curl -fsSL https://opencode.ai/install | bash
USER node
```

## Monitoring UI

`/` lists recent jobs (repo, PR, SHA, state, `n / m` reviewers, aggregator, elapsed time).

`/jobs/:id` shows per-reviewer state, models, findings, raw/normalized JSON, stdout/stderr, aggregator output, and logs. The pages refresh over SSE.

Optional `UI_BASIC_AUTH_USER` / `UI_BASIC_AUTH_PASSWORD` protect the UI. `/webhooks/github` and `/health` stay public.

## Security / trust boundary

Checked-out PR code is **untrusted input**. For MVP, reviewers are for static inspection:

- git hooks are disabled (`core.hooksPath=/dev/null`); submodules are not fetched
- installation tokens are used as a one-shot HTTP header, then the `origin` remote is removed
- GitHub private keys, webhook secrets, and installation tokens are stripped from the OpenCode environment
- untrusted `opencode.json` / `.opencode` / `.claude` from the PR are deleted before review
- OpenCode is launched with permissions that **deny** `bash`, `edit`, `write`, `webfetch`, and related tools; `read` / `glob` / `grep` are allowed
- the repo tree is marked read-only after checkout
- Maomao never executes `npm install`, tests, or repo-defined agents

OpenCode is still a powerful process. A model that ignores instructions, a future OpenCode default, or a host-level plugin can widen the sandbox. Keep Maomao on a locked-down host, do not run it as root, and do not put unrelated secrets in the process environment.

## GitHub review policy

- Actionable findings → one `COMMENT` review, SHA-anchored (`commit_id` = job head SHA), with inline comments when GitHub accepts the locations
- No findings → silent unless `POST_EMPTY_REVIEW=true`
- **Never** `APPROVE` or `REQUEST_CHANGES` in this version
- Duplicate webhook deliveries reuse the existing job; publication also looks for a `<!-- maomao-review sha=... -->` marker

## Configuration reference

See `.env.example`. Notable knobs: `REVIEW_DRAFTS`, `POST_EMPTY_REVIEW`, `JOB_CONCURRENCY`, `WORKSPACE_ROOT`, `DATABASE_PATH`, `MAX_INLINE_COMMENTS`, `PULL_REQUEST_ACTIONS`.

## Follow-ups (not in this MVP)

- Automatic `APPROVE` / `REQUEST_CHANGES` once operators trust the aggregator
- CI / check-run status in reviewer prompts
- Submodule checkout
- Resume a reviewer run mid-job instead of re-running after process restart
- Forges other than GitHub
- Marller registration as a trusted review source

## License

MIT
