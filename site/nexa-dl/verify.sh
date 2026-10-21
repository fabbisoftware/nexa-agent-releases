#!/usr/bin/env bash
#
# NEXA CLI verifier - installs the published tarball into a throwaway prefix and
# runs a full smoke cycle WITHOUT touching your global npm install.
#
#   curl -fsSL https://downloads.agilekit.cc/nexa-dl/verify.sh | bash
#
# Options: --version <v>   verify a specific version (default: latest)
#
set -euo pipefail

BASE_URL="${NEXA_DL_BASE_URL:-https://downloads.agilekit.cc/nexa-dl}"   # Pages: small files
TGZ_BASE="${NEXA_DL_TGZ_BASE:-https://dl.agilekit.cc}"                 # R2: tarball
DEFAULT_VERSION="3.8.0"

c_reset=$'\033[0m'; c_red=$'\033[31m'; c_grn=$'\033[32m'; c_dim=$'\033[2m'
pass() { printf '%s✓%s %s\n' "$c_grn" "$c_reset" "$*"; }
fail() { printf '%s✗%s %s\n' "$c_red" "$c_reset" "$*" >&2; exit 1; }

VERSION="${DEFAULT_VERSION}"
[ "${1:-}" = "--version" ] && VERSION="${2:?version}"

command -v node >/dev/null || fail "node not found (need 22.19+)"
command -v npm  >/dev/null || fail "npm not found"

if [ -z "${1:-}" ]; then
  V="$(curl -fsSL "$BASE_URL/versions.json" 2>/dev/null \
    | sed -n 's/.*"latest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true)"
  [ -n "$V" ] && VERSION="$V"
fi

PREFIX="$(mktemp -d)"; WORK="$(mktemp -d)"
cleanup() { rm -rf "$PREFIX" "$WORK"; }
trap cleanup EXIT
printf '%sVerifying NEXA CLI %s in a throwaway prefix…%s\n' "$c_dim" "$VERSION" "$c_reset"

NPM_CONFIG_PREFIX="$PREFIX" npm i -g "$TGZ_BASE/nexa-${VERSION}.tgz" >/dev/null 2>&1 \
  || fail "npm install failed"
pass "installed into $PREFIX"

export PATH="$PREFIX/bin:$PATH"
GOT="$(nexa --version 2>/dev/null || true)"
[ "$GOT" = "$VERSION" ] || fail "version mismatch: expected $VERSION, got '${GOT:-none}'"
pass "nexa --version = $GOT"

nexa --help >/dev/null 2>&1 || fail "nexa --help failed"
pass "nexa --help OK"

CLIROOT="$PREFIX/lib/node_modules/@fabbi-product-nexa/nexa-cli"
if node -e "const D=require('$CLIROOT/node_modules/better-sqlite3');new D(':memory:').exec('create table t(x)')" >/dev/null 2>&1; then
  pass "better-sqlite3 KB engine loads"
else
  printf '%s… better-sqlite3 not loadable on this Node/platform - KB features disabled, core CLI OK%s\n' "$c_dim" "$c_reset"
fi

( cd "$WORK" && NEXA_LICENSE_DEV=1 nexa init >/dev/null 2>&1 ) || fail "nexa init failed"
FILES="$(find "$WORK" -type f | wc -l | tr -d ' ')"
[ "$FILES" -gt 100 ] || fail "nexa init produced too few files ($FILES)"
pass "nexa init scaffolded $FILES files"

( cd "$WORK" && NEXA_LICENSE_DEV=1 nexa status >/dev/null 2>&1 ) || fail "nexa status failed"
pass "nexa status OK"

printf '\n%sAll checks passed for NEXA CLI %s%s\n' "$c_grn" "$VERSION" "$c_reset"
