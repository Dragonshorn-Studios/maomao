#!/usr/bin/env bash
# Maomao installer: clone or use this checkout, write .env + key mount, start Compose.
# One-liner: curl -fsSL https://raw.githubusercontent.com/Dragonshorn-Studios/maomao/main/scripts/install.sh | bash
set -euo pipefail

REPO_URL="${MAOMAO_REPO_URL:-https://github.com/Dragonshorn-Studios/maomao.git}"
REPO_REF="${MAOMAO_REPO_REF:-main}"
DEFAULT_HOME="${MAOMAO_HOME:-$HOME/.maomao}"

NON_INTERACTIVE=0
SKIP_START=0
UPGRADE_OPENCODE=0
FORCE_ENV=0
REUSE_ENV=0

usage() {
  cat <<'EOF'
Maomao installer — guided .env + Docker Compose with persistent OpenCode.

Usage:
  curl -fsSL https://raw.githubusercontent.com/Dragonshorn-Studios/maomao/main/scripts/install.sh | bash
  ./scripts/install.sh
  ./scripts/install.sh --non-interactive

The script writes .env and github-app.pem, downloads the OpenCode CLI from
GitHub releases onto a named Docker volume, and starts Compose. OpenCode and
SQLite survive compose down / Maomao image rebuilds.

Options:
  --non-interactive, -y   No prompts; read GitHub / UI / OpenCode values from env
  --skip-start            Write .env and mounts only; do not run Docker Compose
  --upgrade-opencode      Reinstall OpenCode into the named volume, then restart
  --force                 Overwrite an existing .env
  -h, --help              Show this help

Environment (non-interactive, or pre-fills interactive prompts):
  MAOMAO_HOME                 Clone destination when not run from a checkout
                              (default: ~/.maomao)
  MAOMAO_REPO_URL / MAOMAO_REPO_REF
  MAOMAO_PORT                 Host port (default: 3000)
  MAOMAO_PUBLIC_URL           Printed webhook / UI URL
  GITHUB_APP_ID
  GITHUB_WEBHOOK_SECRET
  GITHUB_APP_PRIVATE_KEY_PATH Path to the App PEM (copied to ./github-app.pem)
  GITHUB_APP_PRIVATE_KEY      PEM contents if you do not have a file
  GITHUB_APP_SLUG
  UI_PASSWORD                 Generated if unset
  UI_SESSION_SECRET           Generated if unset
  OPENCODE_REVIEWER_MODEL
  OPENCODE_AGGREGATOR_MODEL
  OPENCODE_VERSION            Optional pinned OpenCode CLI version
  ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, ...
EOF
}

die() {
  echo "install.sh: $*" >&2
  exit 1
}

log() {
  echo "=> $*"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

is_maomao_checkout() {
  local dir=$1
  [[ -f "$dir/docker-compose.yml" && -f "$dir/Dockerfile" && -f "$dir/.env.example" && -f "$dir/package.json" ]] || return 1
  grep -q '"name": "maomao"' "$dir/package.json" 2>/dev/null
}

rand_hex() {
  local bytes=${1:-32}
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    dd if=/dev/urandom bs="$bytes" count=1 2>/dev/null | od -An -tx1 | tr -d ' \n'
  fi
}

input_tty() {
  if [[ -r /dev/tty ]]; then
    echo /dev/tty
  elif [[ -t 0 ]]; then
    echo /dev/stdin
  else
    echo ""
  fi
}

prompt() {
  local __var=$1
  local __msg=$2
  local __default=${3:-}
  local __silent=${4:-0}
  local __current="${!__var:-}"
  local __value=""
  local __tty

  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    if [[ -z "$__current" ]]; then
      printf -v "$__var" '%s' "$__default"
    fi
    return 0
  fi

  local __shown=""
  if [[ -n "$__current" ]]; then
    __shown=$__current
  else
    __shown=$__default
  fi

  __tty=$(input_tty)
  [[ -n "$__tty" ]] || die "No TTY for prompts; re-run with --non-interactive and env vars"

  local __suffix=""
  if [[ -n "$__shown" ]]; then
    if [[ "$__silent" == "1" ]]; then
      __suffix=" [set]"
    else
      __suffix=" [$__shown]"
    fi
  fi

  if [[ "$__silent" == "1" ]]; then
    printf '%s%s: ' "$__msg" "$__suffix" > /dev/tty 2>/dev/null || printf '%s%s: ' "$__msg" "$__suffix"
    IFS= read -r -s __value < "$__tty"
    printf '\n' > /dev/tty 2>/dev/null || printf '\n'
  else
    printf '%s%s: ' "$__msg" "$__suffix" > /dev/tty 2>/dev/null || printf '%s%s: ' "$__msg" "$__suffix"
    IFS= read -r __value < "$__tty"
  fi

  if [[ -z "$__value" ]]; then
    __value=${__current:-$__default}
  fi
  printf -v "$__var" '%s' "$__value"
}

prompt_required() {
  local __var=$1
  while true; do
    prompt "$@"
    if [[ -n "${!__var:-}" ]]; then
      return 0
    fi
    if [[ "$NON_INTERACTIVE" == "1" ]]; then
      die "Missing required $__var"
    fi
    echo "This value is required." > /dev/tty 2>/dev/null || echo "This value is required."
  done
}

confirm() {
  local __msg=$1
  local __default=${2:-Y}
  local __reply=""
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    [[ "$__default" == "Y" || "$__default" == "y" ]]
    return
  fi
  prompt __reply "$__msg" "$__default"
  case $(printf '%s' "$__reply" | tr '[:upper:]' '[:lower:]') in
    y|yes|"") return 0 ;;
    *) return 1 ;;
  esac
}

expand_path() {
  local p=$1
  case "$p" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s\n' "$HOME/${p#~/}" ;;
    *) printf '%s\n' "$p" ;;
  esac
}

env_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\$/\\$/g'
}

upsert_env() {
  local file=$1 key=$2 value=$3
  local line="${key}=\"$(env_escape "$value")\""
  local tmp
  tmp=$(mktemp)
  awk -v key="$key" -v line="$line" '
    BEGIN { done = 0 }
    {
      pat = "^[# ]*" key "="
      if ($0 ~ pat) {
        if (!done) { print line; done = 1 }
        next
      }
      print
    }
    END { if (!done) print line }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

load_env_value() {
  local file=$1 key=$2
  [[ -f "$file" ]] || return 0
  local line
  line=$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1 || true)
  [[ -n "$line" ]] || return 0
  local val=${line#*=}
  val=${val#\"}
  val=${val%\"}
  val=${val#\'}
  val=${val%\'}
  printf '%s' "$val"
}

provider_key_for_model() {
  local model=$1
  local prefix=${model%%/*}
  prefix=$(printf '%s' "$prefix" | tr '[:upper:]' '[:lower:]')
  case "$prefix" in
    anthropic) echo ANTHROPIC_API_KEY ;;
    openai) echo OPENAI_API_KEY ;;
    openrouter) echo OPENROUTER_API_KEY ;;
    google|gemini) echo GOOGLE_API_KEY ;;
    xai) echo XAI_API_KEY ;;
    mistral) echo MISTRAL_API_KEY ;;
    groq) echo GROQ_API_KEY ;;
    together) echo TOGETHER_API_KEY ;;
    deepseek) echo DEEPSEEK_API_KEY ;;
    cohere) echo COHERE_API_KEY ;;
    azure|azure-openai) echo AZURE_OPENAI_API_KEY ;;
    ollama|"") echo "" ;;
    *) echo "" ;;
  esac
}

# node:22-bookworm-slim USER node is uid 1000 / gid 1000. Compose bind-mounts
# github-app.pem :ro, which preserves host ownership and mode — chmod 600 as the
# installing user is EACCES inside the container even when the path is correct.
secure_key_file() {
  local dest=$1
  local name
  name=$(basename "$dest")
  if ! chown 1000:1000 "$dest" 2>/dev/null; then
    echo "install.sh: could not chown $name to 1000:1000 (container USER node)." >&2
    echo "install.sh: EACCES on /run/secrets/github-app.pem is host file mode/owner, not a wrong mount path." >&2
    echo "install.sh: fix with: chown 1000:1000 github-app.pem && chmod 400 github-app.pem" >&2
    echo "install.sh: then recreate Compose (docker compose up -d --force-recreate)." >&2
  fi
  chmod 400 "$dest"
}

write_key_file() {
  local dest=$1 src=$2 pem_contents=$3
  if [[ -n "$src" ]]; then
    src=$(expand_path "$src")
    [[ -f "$src" ]] || die "GitHub App private key not found: $src"
    cp "$src" "$dest"
  elif [[ -n "$pem_contents" ]]; then
    printf '%s' "$pem_contents" | sed 's/\\n/\n/g' > "$dest"
    if [[ -s "$dest" ]] && ! grep -q $'\n' "$dest"; then
      # single-line PEM with literal \n already expanded by sed; ensure trailing newline
      printf '\n' >> "$dest"
    fi
  else
    die "Provide GITHUB_APP_PRIVATE_KEY_PATH or GITHUB_APP_PRIVATE_KEY"
  fi
  if ! grep -q "BEGIN .*PRIVATE KEY" "$dest"; then
    die "github-app.pem does not look like a PEM private key"
  fi
  secure_key_file "$dest"
}

write_override() {
  cat > "$ROOT/docker-compose.override.yml" <<'EOF'
# Generated by scripts/install.sh. Local bind mounts; do not commit.
services:
  maomao:
    volumes:
      - ./github-app.pem:/run/secrets/github-app.pem:ro
EOF
}

opencode_filename() {
  local arch extra=""
  arch=$(docker info --format '{{.Architecture}}' 2>/dev/null || uname -m)
  case "$arch" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "Unsupported Docker architecture: $arch" ;;
  esac
  if [[ "$arch" == "x64" ]] && ! grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then
    extra="-baseline"
  fi
  printf '%s\n' "opencode-linux-${arch}${extra}.tar.gz"
}

seed_opencode() {
  need_cmd curl
  need_cmd tar
  local filename url tmp ver=""
  filename=$(opencode_filename)
  if [[ -n "${OPENCODE_VERSION:-}" ]]; then
    ver="${OPENCODE_VERSION#v}"
    url="https://github.com/anomalyco/opencode/releases/download/v${ver}/${filename}"
  else
    url="https://github.com/anomalyco/opencode/releases/latest/download/${filename}"
  fi
  tmp=$(mktemp -d)
  log "Downloading OpenCode into the maomao-opencode volume ($filename)"
  curl -fsSL --connect-timeout 20 --max-time 180 -o "$tmp/$filename" "$url" \
    || die "Failed to download OpenCode from $url"
  tar -xzf "$tmp/$filename" -C "$tmp"
  [[ -f "$tmp/opencode" ]] || die "OpenCode archive did not contain an 'opencode' binary"
  chmod 755 "$tmp/opencode"
  docker compose build
  docker compose run -T --rm --no-deps \
    -v "$tmp/opencode:/tmp/opencode-bin:ro" \
    --entrypoint sh maomao -c \
    'mkdir -p /opt/opencode/.opencode/bin && cp /tmp/opencode-bin /opt/opencode/.opencode/bin/opencode && chmod 755 /opt/opencode/.opencode/bin/opencode && /opt/opencode/.opencode/bin/opencode --version'
  rm -rf "$tmp"
}

wait_health() {
  local port=$1
  local i=0
  local max=90
  log "Waiting for http://127.0.0.1:${port}/health"
  while [[ $i -lt $max ]]; do
    if command -v curl >/dev/null 2>&1; then
      if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
        log "Health check passed"
        return 0
      fi
    else
      if docker compose exec -T maomao node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
        log "Health check passed"
        return 0
      fi
    fi
    i=$((i + 1))
    sleep 2
  done
  echo "Timed out waiting for /health. Recent logs:" >&2
  docker compose logs --tail 120 >&2 || true
  return 1
}

ensure_checkout() {
  if is_maomao_checkout "$PWD"; then
    ROOT=$PWD
    log "Using checkout $ROOT"
    return 0
  fi

  if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
    local script_dir candidate
    script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    candidate=$(cd "$script_dir/.." && pwd)
    if is_maomao_checkout "$candidate"; then
      ROOT=$candidate
      log "Using checkout $ROOT"
      return 0
    fi
  fi

  need_cmd git
  ROOT=$DEFAULT_HOME
  if [[ -d "$ROOT/.git" ]] && is_maomao_checkout "$ROOT"; then
    log "Updating $ROOT ($REPO_REF)"
    git -C "$ROOT" fetch --depth 1 origin "$REPO_REF"
    git -C "$ROOT" checkout "$REPO_REF"
    git -C "$ROOT" pull --ff-only origin "$REPO_REF" || true
    return 0
  fi
  if [[ -e "$ROOT" && ! -d "$ROOT/.git" ]]; then
    die "$ROOT exists and is not a Maomao git checkout. Set MAOMAO_HOME or run from a clone."
  fi
  log "Cloning $REPO_URL ($REPO_REF) into $ROOT"
  mkdir -p "$(dirname "$ROOT")"
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$ROOT"
}

for _arg in "$@"; do
  case "$_arg" in
    -h|--help) usage; exit 0 ;;
  esac
done

ensure_checkout
cd "$ROOT"

self_is_checkout_script=0
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  self_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  if [[ "$self_dir" == "$(cd "$ROOT/scripts" && pwd)" ]]; then
    self_is_checkout_script=1
  fi
fi
if [[ "$self_is_checkout_script" != "1" ]]; then
  exec bash "$ROOT/scripts/install.sh" "$@"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --non-interactive|-y) NON_INTERACTIVE=1; shift ;;
    --skip-start) SKIP_START=1; shift ;;
    --upgrade-opencode) UPGRADE_OPENCODE=1; shift ;;
    --force) FORCE_ENV=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

if [[ "$SKIP_START" != "1" || "$UPGRADE_OPENCODE" == "1" ]]; then
  need_cmd docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose)"
  docker info >/dev/null 2>&1 || die "Docker daemon is not running, or this user cannot access it"
fi

if [[ "$UPGRADE_OPENCODE" == "1" ]]; then
  [[ -f "$ROOT/.env" ]] || die "No .env yet; run the installer without --upgrade-opencode first"
  OPENCODE_VERSION="${OPENCODE_VERSION:-$(load_env_value "$ROOT/.env" OPENCODE_VERSION)}"
  seed_opencode
  docker compose up -d --force-recreate
  upgrade_port=$(load_env_value "$ROOT/.env" MAOMAO_PORT)
  wait_health "${upgrade_port:-3000}"
  log "OpenCode reinstall finished. Confirm with: docker compose logs maomao | grep OpenCode"
  exit 0
fi

GITHUB_APP_ID="${GITHUB_APP_ID:-$(load_env_value "$ROOT/.env" GITHUB_APP_ID)}"
GITHUB_WEBHOOK_SECRET="${GITHUB_WEBHOOK_SECRET:-$(load_env_value "$ROOT/.env" GITHUB_WEBHOOK_SECRET)}"
GITHUB_APP_SLUG="${GITHUB_APP_SLUG:-$(load_env_value "$ROOT/.env" GITHUB_APP_SLUG)}"
GITHUB_APP_PRIVATE_KEY_PATH="${GITHUB_APP_PRIVATE_KEY_PATH:-}"
GITHUB_APP_PRIVATE_KEY="${GITHUB_APP_PRIVATE_KEY:-}"
UI_PASSWORD="${UI_PASSWORD:-$(load_env_value "$ROOT/.env" UI_PASSWORD)}"
UI_SESSION_SECRET="${UI_SESSION_SECRET:-$(load_env_value "$ROOT/.env" UI_SESSION_SECRET)}"
OPENCODE_REVIEWER_MODEL="${OPENCODE_REVIEWER_MODEL:-$(load_env_value "$ROOT/.env" OPENCODE_REVIEWER_MODEL)}"
OPENCODE_AGGREGATOR_MODEL="${OPENCODE_AGGREGATOR_MODEL:-$(load_env_value "$ROOT/.env" OPENCODE_AGGREGATOR_MODEL)}"
OPENCODE_VERSION="${OPENCODE_VERSION:-$(load_env_value "$ROOT/.env" OPENCODE_VERSION)}"
MAOMAO_PORT="${MAOMAO_PORT:-$(load_env_value "$ROOT/.env" MAOMAO_PORT)}"
MAOMAO_PORT="${MAOMAO_PORT:-3000}"
MAOMAO_PUBLIC_URL="${MAOMAO_PUBLIC_URL:-}"

if [[ -f "$ROOT/.env" && "$FORCE_ENV" != "1" ]]; then
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    REUSE_ENV=1
    log "Reusing existing $ROOT/.env (pass --force to overwrite)"
  elif confirm "Found $ROOT/.env. Reuse it without rewriting" Y; then
    REUSE_ENV=1
  fi
fi

if [[ "$REUSE_ENV" != "1" ]]; then
  cat <<'EOF'

Create a GitHub App first if you have not (least privilege):
  Metadata: Read
  Contents: Read
  Pull requests: Read & write
  Subscribe to Pull request events
See README "Configure a GitHub App". This installer does not create the App.

EOF

  prompt_required GITHUB_APP_ID "GitHub App ID (numeric)"
  prompt_required GITHUB_WEBHOOK_SECRET "GitHub webhook secret"
  prompt GITHUB_APP_SLUG "GitHub App slug (optional)"
  if [[ -z "$GITHUB_APP_PRIVATE_KEY_PATH" && -z "$GITHUB_APP_PRIVATE_KEY" && -f "$ROOT/github-app.pem" ]]; then
    GITHUB_APP_PRIVATE_KEY_PATH="$ROOT/github-app.pem"
  fi
  if [[ -z "$GITHUB_APP_PRIVATE_KEY" ]]; then
    prompt_required GITHUB_APP_PRIVATE_KEY_PATH "Path to GitHub App private key (.pem)"
  fi

  generated_password=0
  prompt UI_PASSWORD "UI password (empty = generate)"
  if [[ -z "$UI_PASSWORD" ]]; then
    UI_PASSWORD=$(rand_hex 16)
    generated_password=1
  fi
  if [[ -z "$UI_SESSION_SECRET" ]]; then
    UI_SESSION_SECRET=$(rand_hex 32)
  fi
  prompt UI_SESSION_SECRET "UI session secret (empty = keep generated)"

  prompt_required OPENCODE_REVIEWER_MODEL "OpenCode reviewer model (provider/model)" "anthropic/claude-sonnet-4-5"
  prompt OPENCODE_AGGREGATOR_MODEL "Aggregator model (empty = same as reviewer)"
  prompt OPENCODE_VERSION "Pin OpenCode CLI version (empty = latest GitHub release)"

  provider_key=$(provider_key_for_model "$OPENCODE_REVIEWER_MODEL")
  if [[ -n "$provider_key" ]]; then
    current_pk=""
    eval "current_pk=\${$provider_key:-}"
    if [[ -z "$current_pk" ]]; then
      current_pk=$(load_env_value "$ROOT/.env" "$provider_key")
    fi
    printf -v "$provider_key" '%s' "$current_pk"
    prompt_required "$provider_key" "Provider key $provider_key"
  else
    log "No default provider key mapping for that model id; set keys in .env if OpenCode needs them"
  fi

  prompt MAOMAO_PORT "Host port" "$MAOMAO_PORT"
  prompt MAOMAO_PUBLIC_URL "Public base URL (for printed webhook URL)" "http://127.0.0.1:${MAOMAO_PORT}"

  cp "$ROOT/.env.example" "$ROOT/.env"
  upsert_env "$ROOT/.env" GITHUB_APP_ID "$GITHUB_APP_ID"
  upsert_env "$ROOT/.env" GITHUB_WEBHOOK_SECRET "$GITHUB_WEBHOOK_SECRET"
  upsert_env "$ROOT/.env" GITHUB_APP_SLUG "$GITHUB_APP_SLUG"
  upsert_env "$ROOT/.env" GITHUB_APP_PRIVATE_KEY ""
  upsert_env "$ROOT/.env" GITHUB_APP_PRIVATE_KEY_PATH "/run/secrets/github-app.pem"
  upsert_env "$ROOT/.env" UI_PASSWORD "$UI_PASSWORD"
  upsert_env "$ROOT/.env" UI_SESSION_SECRET "$UI_SESSION_SECRET"
  upsert_env "$ROOT/.env" OPENCODE_REVIEWER_MODEL "$OPENCODE_REVIEWER_MODEL"
  upsert_env "$ROOT/.env" OPENCODE_AGGREGATOR_MODEL "$OPENCODE_AGGREGATOR_MODEL"
  upsert_env "$ROOT/.env" OPENCODE_BIN "/opt/opencode/.opencode/bin/opencode"
  upsert_env "$ROOT/.env" HOST "0.0.0.0"
  upsert_env "$ROOT/.env" PORT "3000"
  upsert_env "$ROOT/.env" MAOMAO_PORT "$MAOMAO_PORT"
  if [[ -n "$OPENCODE_VERSION" ]]; then
    upsert_env "$ROOT/.env" OPENCODE_VERSION "$OPENCODE_VERSION"
  fi
  if [[ -n "$MAOMAO_PUBLIC_URL" ]]; then
    upsert_env "$ROOT/.env" MAOMAO_PUBLIC_URL "$MAOMAO_PUBLIC_URL"
  fi

  for key in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GOOGLE_API_KEY GEMINI_API_KEY \
    XAI_API_KEY MISTRAL_API_KEY GROQ_API_KEY TOGETHER_API_KEY DEEPSEEK_API_KEY COHERE_API_KEY \
    AZURE_OPENAI_API_KEY; do
    val="${!key:-}"
    if [[ -n "$val" ]]; then
      upsert_env "$ROOT/.env" "$key" "$val"
    fi
  done

  chmod 600 "$ROOT/.env"
  write_key_file "$ROOT/github-app.pem" "$GITHUB_APP_PRIVATE_KEY_PATH" "$GITHUB_APP_PRIVATE_KEY"
  write_override
  log "Wrote $ROOT/.env (mode 600) and $ROOT/github-app.pem (mode 400, uid 1000 when chown succeeds)"
  if [[ "$generated_password" == "1" ]]; then
    echo
    echo "Generated UI password (save this; it is also in .env): $UI_PASSWORD"
    echo
  fi
else
  [[ -f "$ROOT/github-app.pem" ]] || die "Reusing .env but $ROOT/github-app.pem is missing"
  secure_key_file "$ROOT/github-app.pem"
  [[ -f "$ROOT/docker-compose.override.yml" ]] || write_override
  MAOMAO_PORT=$(load_env_value "$ROOT/.env" MAOMAO_PORT)
  MAOMAO_PORT=${MAOMAO_PORT:-3000}
  MAOMAO_PUBLIC_URL=$(load_env_value "$ROOT/.env" MAOMAO_PUBLIC_URL)
  UI_PASSWORD=$(load_env_value "$ROOT/.env" UI_PASSWORD)
fi

MAOMAO_PUBLIC_URL="${MAOMAO_PUBLIC_URL:-http://127.0.0.1:${MAOMAO_PORT}}"

if [[ "$SKIP_START" == "1" ]]; then
  log "Skipping docker compose (--skip-start)"
  echo "Next: cd $ROOT && ./scripts/install.sh --upgrade-opencode"
  echo "(seeds OpenCode from GitHub releases, then starts Compose;"
  echo " bare docker compose up with an empty maomao-opencode volume fails closed)"
  exit 0
fi

log "Building Maomao and seeding OpenCode into volume maomao-opencode"
export MAOMAO_PORT
seed_opencode
docker compose up -d
wait_health "$MAOMAO_PORT"

cat <<EOF

Maomao is up.

  UI:      ${MAOMAO_PUBLIC_URL}/
  Health:  ${MAOMAO_PUBLIC_URL}/health
  Webhook: ${MAOMAO_PUBLIC_URL}/webhooks/github

Set the GitHub App webhook URL to the last of those. Install the App on the
repos you want reviewed. Data lives in Docker volumes:

  maomao-data      → /data           (SQLite + workspaces)
  maomao-opencode  → /opt/opencode   (OpenCode CLI + config)

Secrets: $ROOT/.env and $ROOT/github-app.pem (not baked into the image).
Upgrade Maomao:  git pull && docker compose up -d --build
Upgrade OpenCode only:  ./scripts/install.sh --upgrade-opencode

EOF
