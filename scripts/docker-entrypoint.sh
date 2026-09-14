#!/bin/sh
# Install OpenCode into the persisted volume if missing, then start Maomao.
# The binary and OpenCode's own config/cache live under $HOME (/opt/opencode
# by default) so `docker compose down` / image rebuilds do not wipe them.
set -eu

OPENCODE_HOME="${OPENCODE_HOME:-/opt/opencode}"
OPENCODE_BIN="${OPENCODE_BIN:-$OPENCODE_HOME/.opencode/bin/opencode}"
export HOME="$OPENCODE_HOME"
# shellcheck disable=SC2123
export PATH="$(dirname "$OPENCODE_BIN"):${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

mkdir -p "$HOME" "$(dirname "$OPENCODE_BIN")" /data/workspaces

wanted_version() {
  printf '%s' "${OPENCODE_VERSION:-}" | sed 's/^v//'
}

installed_version() {
  if [ -x "$OPENCODE_BIN" ]; then
    "$OPENCODE_BIN" --version 2>/dev/null || true
  fi
}

need_install=0
if [ "${OPENCODE_SKIP_INSTALL:-}" = "1" ]; then
  echo "Maomao: OPENCODE_SKIP_INSTALL=1; not installing OpenCode"
elif [ "${OPENCODE_FORCE_INSTALL:-}" = "1" ]; then
  echo "Maomao: OPENCODE_FORCE_INSTALL=1; reinstalling OpenCode into $HOME"
  rm -f "$OPENCODE_BIN"
  need_install=1
elif [ ! -x "$OPENCODE_BIN" ]; then
  echo "Maomao: OpenCode not found at $OPENCODE_BIN"
  need_install=1
else
  current="$(installed_version)"
  wanted="$(wanted_version)"
  if [ -n "$wanted" ] && [ "$current" != "$wanted" ]; then
    echo "Maomao: OpenCode $current != OPENCODE_VERSION=$wanted; reinstalling"
    need_install=1
  else
    echo "Maomao: using persisted OpenCode ${current:-at $OPENCODE_BIN}"
  fi
fi

if [ "$need_install" = "1" ]; then
  echo "Maomao: installing OpenCode into persisted volume $HOME"
  if [ ! -d "$HOME" ] || [ ! -w "$HOME" ]; then
    echo "Maomao: cannot write OpenCode volume $HOME" >&2
    exit 1
  fi
  installer="${TMPDIR:-/tmp}/opencode-install.sh"
  if ! curl -fsSL --connect-timeout 20 --max-time 180 -o "$installer" https://opencode.ai/install; then
    echo "Maomao: could not download the OpenCode installer (no outbound HTTPS from the container?)." >&2
    echo "Maomao: run scripts/install.sh to seed OpenCode from the host, or mount a binary at $OPENCODE_BIN." >&2
    exit 1
  fi
  if [ -n "${OPENCODE_VERSION:-}" ]; then
    bash "$installer" --no-modify-path --version "$OPENCODE_VERSION"
  else
    bash "$installer" --no-modify-path
  fi
  rm -f "$installer"
  if [ ! -x "$OPENCODE_BIN" ]; then
    echo "Maomao: OpenCode install finished but $OPENCODE_BIN is missing" >&2
    exit 1
  fi
  echo "Maomao: OpenCode $(installed_version) ready at $OPENCODE_BIN"
fi

exec "$@"
