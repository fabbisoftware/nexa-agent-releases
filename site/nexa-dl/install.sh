#!/usr/bin/env bash
#
# NEXA CLI installer — self-contained, install/update over curl.
#
#   curl -fsSL https://downloads.agilekit.cc/nexa-dl/install.sh | bash
#
# Options (pass after `| bash -s --`):
#   --version <v>   install a specific version (default: latest from versions.json)
#   --update        alias for a normal run (install is idempotent = update)
#   --help          show this help
#
set -euo pipefail

BASE_URL="${NEXA_DL_BASE_URL:-https://downloads.agilekit.cc/nexa-dl}"   # Pages: small files
TGZ_BASE="${NEXA_DL_TGZ_BASE:-https://dl.agilekit.cc}"                 # R2: tarball (>25MiB)
DEFAULT_VERSION="3.7.1"   # fallback if versions.json is unreachable
REQ_NODE_MAJOR=22

c_reset=$'\033[0m'; c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_dim=$'\033[2m'
info()  { printf '%s\n' "$*"; }
ok()    { printf '%s✓%s %s\n' "$c_grn" "$c_reset" "$*"; }
warn()  { printf '%s⚠%s %s\n' "$c_ylw" "$c_reset" "$*" >&2; }
die()   { printf '%s✗%s %s\n' "$c_red" "$c_reset" "$*" >&2; exit 1; }

VERSION=""
for arg in "$@"; do
  case "$arg" in
    --version=*) VERSION="${arg#*=}" ;;
    --version)   shift; VERSION="${1:-}" ;;
    --update)    : ;;  # install is idempotent; a re-run upgrades in place
    --help|-h)
      sed -n '2,11p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
      exit 0 ;;
  esac
  shift || true
done

# --- preflight -------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node not found. Install Node ${REQ_NODE_MAJOR}+ from https://nodejs.org and retry."
command -v npm  >/dev/null 2>&1 || die "npm not found. It ships with Node ${REQ_NODE_MAJOR}+ — reinstall Node and retry."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt "$REQ_NODE_MAJOR" ]; then
  die "Node ${REQ_NODE_MAJOR}+ required, found $(node -v). Upgrade Node and retry."
fi
ok "node $(node -v), npm $(npm -v)"

# --- resolve version -------------------------------------------------------
if [ -z "$VERSION" ]; then
  VERSION="$(curl -fsSL "$BASE_URL/versions.json" 2>/dev/null \
    | sed -n 's/.*"latest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true)"
  [ -z "$VERSION" ] && VERSION="$DEFAULT_VERSION"
fi
TGZ_URL="$TGZ_BASE/nexa-${VERSION}.tgz"
info "${c_dim}Installing NEXA CLI ${VERSION} from ${TGZ_URL}${c_reset}"

# already installed?
# already installed? → uninstall-then-install (#229): `npm i -g` OVER an existing
# global install of this self-contained bundle (bundledDependencies, 370+ pkgs)
# crashes some npm versions with "Cannot read properties of null (reading 'package')"
# while arborist diffs the old tree. Removing first avoids the diff entirely.
# Ordering is safe: we only uninstall AFTER confirming the new tarball is reachable,
# so a dead link can never leave the machine without a CLI.
if command -v nexa >/dev/null 2>&1; then
  CUR="$(nexa --version 2>/dev/null || echo '?')"
  info "${c_dim}Found existing nexa ${CUR} → updating to ${VERSION}${c_reset}"
  if ! curl -fsIL -o /dev/null "$TGZ_URL"; then
    die "new tarball unreachable ($TGZ_URL) — keeping existing install untouched. Retry shortly."
  fi
  if npm rm -g @fabbi-product-nexa/nexa-cli >/dev/null 2>&1; then
    ok "removed existing install (pre-clean for npm global-update quirk, #229)"
  else
    warn "pre-clean 'npm rm -g' failed — continuing with in-place install"
  fi
fi

# --- install ---------------------------------------------------------------
# All native addons (better-sqlite3, koffi, …) ship prebuilt and bundled, and their
# install/postinstall scripts are stripped at pack time — so a plain install just works.
if ! npm install -g "$TGZ_URL"; then
  die "npm install failed. If it is a permissions error, retry with sudo or set a user prefix:
  npm config set prefix ~/.npm-global && export PATH=\"\$HOME/.npm-global/bin:\$PATH\""
fi

# --- verify ----------------------------------------------------------------
if ! command -v nexa >/dev/null 2>&1; then
  warn "nexa installed but not on PATH. Add your npm global bin to PATH:"
  warn "  export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
  exit 0
fi

INSTALLED="$(nexa --version 2>/dev/null || echo '?')"
ok "NEXA CLI ${INSTALLED} installed"
cat <<EOF

Next steps:
  ${c_dim}# scaffold a project in the current directory${c_reset}
  nexa init
  ${c_dim}# check environment + gates${c_reset}
  nexa doctor
  ${c_dim}# see all commands${c_reset}
  nexa --help

Docs: ${BASE_URL}/
EOF
