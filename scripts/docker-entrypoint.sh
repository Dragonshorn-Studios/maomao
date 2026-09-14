#!/bin/sh
# Require a host-seeded OpenCode binary on the persisted volume, then start Maomao.
# Seed with scripts/install.sh (or --upgrade-opencode). This entrypoint never
# downloads or executes a remote installer.
set -eu

OPENCODE_HOME="${OPENCODE_HOME:-/opt/opencode}"
OPENCODE_BIN="${OPENCODE_BIN:-$OPENCODE_HOME/.opencode/bin/opencode}"
export HOME="$OPENCODE_HOME"
# shellcheck disable=SC2123
export PATH="$(dirname "$OPENCODE_BIN"):${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

mkdir -p "$HOME" "$(dirname "$OPENCODE_BIN")" "${WORKSPACE_ROOT:-/data/workspaces}"

seed_hint() {
  echo "Maomao: seed OpenCode from the host with ./scripts/install.sh or ./scripts/install.sh --upgrade-opencode," >&2
  echo "Maomao: or mount an executable at $OPENCODE_BIN." >&2
}

wanted_version() {
  printf '%s' "${OPENCODE_VERSION:-}" | sed 's/^v//'
}

installed_version() {
  if [ -x "$OPENCODE_BIN" ]; then
    "$OPENCODE_BIN" --version 2>/dev/null || true
  fi
}

if [ ! -x "$OPENCODE_BIN" ]; then
  echo "Maomao: OpenCode not found or not executable at $OPENCODE_BIN" >&2
  seed_hint
  exit 1
fi

current="$(installed_version)"
wanted="$(wanted_version)"
if [ -n "$wanted" ] && [ "$current" != "$wanted" ]; then
  echo "Maomao: OpenCode ${current:-unknown} does not match OPENCODE_VERSION=$wanted" >&2
  echo "Maomao: re-seed volume maomao-opencode from the host; the container will not install OpenCode." >&2
  seed_hint
  exit 1
fi

echo "Maomao: using persisted OpenCode ${current:-at $OPENCODE_BIN}"

exec "$@"
