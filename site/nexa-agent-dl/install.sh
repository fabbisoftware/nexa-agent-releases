#!/usr/bin/env bash
#
# NEXA Agent installer for macOS and Linux. Install and update are the same run.
#
#   curl -fsSL https://downloads.agilekit.cc/nexa-agent-dl/install.sh | bash
#
# Options (pass after `| bash -s --`):
#   --version <v>      install a specific release, e.g. 3.7.1 (default: latest)
#   --no-modify-path   do not add the bin directory to your shell profile
#   --help             show this help
#
# Environment:
#   NEXA_AGENT_HOME     install root (default: ~/.nexa-agent)
#   NEXA_AGENT_REPO     GitHub repo that holds the builds (default below)
#   NEXA_AGENT_DL_BASE  releases base URL (default: https://github.com/$NEXA_AGENT_REPO/releases)
#
set -euo pipefail

REPO="${NEXA_AGENT_REPO:-fabbisoftware/nexa-agent-releases}"
DL_BASE="${NEXA_AGENT_DL_BASE:-https://github.com/${REPO}/releases}"
INSTALL_ROOT="${NEXA_AGENT_HOME:-$HOME/.nexa-agent}"
BIN_NAME="nexa-agent"
KEEP_VERSIONS=3          # installed versions kept for rollback

if [ -t 1 ]; then
  c_reset=$'\033[0m'; c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_dim=$'\033[2m'
else
  c_reset=""; c_red=""; c_grn=""; c_ylw=""; c_dim=""
fi
info() { printf '%s\n' "$*"; }
dim()  { printf '%s%s%s\n' "$c_dim" "$*" "$c_reset"; }
ok()   { printf '%s✓%s %s\n' "$c_grn" "$c_reset" "$*"; }
warn() { printf '%s⚠%s %s\n' "$c_ylw" "$c_reset" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "$c_red" "$c_reset" "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
NEXA Agent installer (macOS, Linux)

  curl -fsSL https://downloads.agilekit.cc/nexa-agent-dl/install.sh | bash
  curl -fsSL https://downloads.agilekit.cc/nexa-agent-dl/install.sh | bash -s -- --version 3.7.1

  --version <v>      install a specific release (default: latest)
  --no-modify-path   do not add the bin directory to your shell profile
  NEXA_AGENT_HOME    install root (default: ~/.nexa-agent)
USAGE
}

VERSION="${NEXA_AGENT_VERSION:-}"
MODIFY_PATH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --version)        [ $# -ge 2 ] || die "--version needs a value, e.g. --version 3.7.1"; VERSION="$2"; shift 2 ;;
    --version=*)      VERSION="${1#*=}"; shift ;;
    --no-modify-path) MODIFY_PATH=0; shift ;;
    --update)         shift ;;  # a re-run is an update
    --help|-h)        usage; exit 0 ;;
    *)                die "unknown option: $1 (see --help)" ;;
  esac
done
VERSION="${VERSION#v}"

# --- platform --------------------------------------------------------------
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  MINGW*|MSYS*|CYGWIN*) die "On Windows run in PowerShell: irm https://downloads.agilekit.cc/nexa-agent-dl/install.ps1 | iex" ;;
  *) die "unsupported OS: $(uname -s). Supported: macOS, Linux, Windows." ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) die "unsupported CPU: $(uname -m). Supported: x64, arm64." ;;
esac
# An x64 shell under Rosetta on Apple silicon should still get the native build.
if [ "$OS" = darwin ] && [ "$ARCH" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  ARCH=arm64
fi
ASSET="${BIN_NAME}-${OS}-${ARCH}.tar.gz"

command -v curl >/dev/null 2>&1 || die "curl not found. Install curl and retry."
command -v tar  >/dev/null 2>&1 || die "tar not found. Install tar and retry."
if command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum  >/dev/null 2>&1; then sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else die "neither sha256sum nor shasum found; cannot verify the download."
fi

# --- resolve the release ---------------------------------------------------
# Resolve "latest" to a tag once, so the checksum file and the archive always
# come from the same release even if a new one is published mid-install.
if [ -z "$VERSION" ]; then
  case "$DL_BASE" in
    http://*|https://*)
      # GitHub answers latest/download/<file> with a 302 to download/<tag>/<file>.
      TAG_URL="$(curl -sSI -o /dev/null -w '%{redirect_url}' "$DL_BASE/latest/download/SHA256SUMS" 2>/dev/null || true)"
      case "$TAG_URL" in */download/*/SHA256SUMS) TAG="${TAG_URL%/SHA256SUMS}"; VERSION="${TAG##*/}"; VERSION="${VERSION#v}" ;; esac ;;
  esac
fi
if [ -n "$VERSION" ]; then
  REL_URL="$DL_BASE/download/v${VERSION}"
  LABEL="$VERSION"
else
  REL_URL="$DL_BASE/latest/download"
  LABEL="latest"
fi
info "${c_dim}Installing NEXA Agent ${LABEL} for ${OS}-${ARCH}${c_reset}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() { curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1"; }

fetch "$REL_URL/SHA256SUMS" "$TMP/SHA256SUMS" \
  || die "no release found at $REL_URL (check the version, or your network/proxy)."

verify() { # verify <file> <asset-name>
  local want got
  want="$(awk -v f="$2" '{n=$2; sub(/^\*/,"",n)} n==f {print $1; exit}' "$TMP/SHA256SUMS")"
  [ -n "$want" ] || die "$2 is not listed in SHA256SUMS; refusing to install an unverified file."
  got="$(sha256 "$1")"
  [ "$want" = "$got" ] || die "checksum mismatch for $2 (expected $want, got $got). Download again; if it repeats, report it."
  ok "sha256 verified ($2)"
}

if ! grep -qE "[[:space:]]\*?${ASSET}\$" "$TMP/SHA256SUMS"; then
  die "release ${LABEL} has no build for ${OS}-${ARCH}. On another platform, install the NEXA CLI with npm (Node 22.19+): https://downloads.agilekit.cc/nexa-dl/"
fi

# --- download, verify, unpack ---------------------------------------------
fetch "$REL_URL/$ASSET" "$TMP/$ASSET" || die "download failed: $REL_URL/$ASSET"
verify "$TMP/$ASSET" "$ASSET"

mkdir -p "$TMP/x"
tar -xzf "$TMP/$ASSET" -C "$TMP/x" || die "could not unpack $ASSET"
# The archive holds one top-level folder with agent.json and bin/ (nexa-agent, nexa).
INFO="$(cd "$TMP/x" && find . -maxdepth 2 -name agent.json -type f | head -1)"
[ -n "$INFO" ] || die "$ASSET has no agent.json; it is not a NEXA Agent archive."
ROOT_REL="$(dirname "${INFO#./}")"
[ -x "$TMP/x/$ROOT_REL/bin/$BIN_NAME" ] || die "$ASSET has no executable bin/$BIN_NAME."
if [ -z "$VERSION" ]; then
  VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP/x/$INFO" | head -1)"
  [ -n "$VERSION" ] || VERSION="unknown-$(date +%Y%m%d%H%M%S)"
fi

# --- install: versions/<v>, `current` link, one bin/ link per launcher -------
mkdir -p "$INSTALL_ROOT/versions" "$INSTALL_ROOT/bin"
DEST="$INSTALL_ROOT/versions/$VERSION"
rm -rf "$DEST.new"
mv "$TMP/x" "$DEST.new"
rm -rf "$DEST"
mv "$DEST.new" "$DEST"
ln -sfn "versions/$VERSION" "$INSTALL_ROOT/current"
LINKED=""
for launcher in "$DEST/$ROOT_REL/bin/"*; do
  name="$(basename "$launcher")"
  ln -sfn "../current/$ROOT_REL/bin/$name" "$INSTALL_ROOT/bin/$name"
  LINKED="$LINKED $name"
done
ok "installed $VERSION into $DEST (commands:$LINKED)"

# keep the newest $KEEP_VERSIONS versions for rollback
# shellcheck disable=SC2012
ls -1t "$INSTALL_ROOT/versions" 2>/dev/null | tail -n +$((KEEP_VERSIONS + 1)) | while read -r old; do
  [ "$old" = "$VERSION" ] || rm -rf "${INSTALL_ROOT:?}/versions/$old"
done

# --- PATH -------------------------------------------------------------------
BIN_DIR="$INSTALL_ROOT/bin"
case ":$PATH:" in
  *":$BIN_DIR:"*) ON_PATH=1 ;;
  *) ON_PATH=0 ;;
esac
if [ "$ON_PATH" = 0 ] && [ "$MODIFY_PATH" = 1 ]; then
  case "${SHELL##*/}" in
    zsh)  RC="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) if [ "$OS" = darwin ]; then RC="$HOME/.bash_profile"; else RC="$HOME/.bashrc"; fi ;;
    fish) RC="" ;;
    *)    RC="$HOME/.profile" ;;
  esac
  LINE="export PATH=\"$BIN_DIR:\$PATH\""
  if [ -n "$RC" ]; then
    if ! grep -qsF "$BIN_DIR" "$RC"; then
      printf '\n# NEXA Agent\n%s\n' "$LINE" >> "$RC"
      ok "added $BIN_DIR to PATH in $RC"
    fi
    info "Open a new terminal, or run:  ${LINE}"
  else
    info "Add to PATH:  fish_add_path $BIN_DIR"
  fi
elif [ "$ON_PATH" = 0 ]; then
  info "Add to PATH:  export PATH=\"$BIN_DIR:\$PATH\""
fi

OTHER="$(command -v nexa 2>/dev/null || true)"
case "$OTHER" in
  ""|"$BIN_DIR/nexa") ;;
  *) info "Another nexa is on PATH at $OTHER (the npm-based NEXA CLI?). New shells use NEXA Agent's when $BIN_DIR comes first in PATH." ;;
esac

GOT="$("$BIN_DIR/$BIN_NAME" --version 2>/dev/null || true)"
if [ -n "$GOT" ]; then ok "$BIN_NAME --version → $GOT"; else warn "$BIN_NAME is installed but --version printed nothing."; fi
dim "Uninstall: rm -rf \"$INSTALL_ROOT\" (and remove the NEXA Agent line from your shell profile)"
