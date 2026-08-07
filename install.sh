#!/usr/bin/env bash
# tradwife — one-command install.
#   curl -fsSL https://raw.githubusercontent.com/ma-nucho-pro/tradwife/main/install.sh | bash
# or, from a clone:
#   bash install.sh
set -euo pipefail

REPO="https://github.com/ma-nucho-pro/tradwife.git"
green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1" >&2; }

command -v node >/dev/null 2>&1 || { red "Node is required. Install Node 18.17 or newer, then run this again."; exit 1; }

MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 18 ]; then
  red "Node $(node -v) is too old. tradwife needs 18.17 or newer."
  exit 1
fi

# Running from a clone, or bootstrapping from curl?
#
# Detect by the presence of the entry point, not by grepping the package name.
# Matching on a name string broke silently the moment the package was renamed:
# the check failed, the script decided it was running from curl, and it tried to
# clone a repo that did not exist yet — in a directory that already held the
# whole project.
SELF_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/bin/tradwife.js" ] && [ -f "$SELF_DIR/package.json" ]; then
  DIR="$SELF_DIR"
else
  DIR="${TRADWIFE_DIR:-$HOME/.local/share/tradwife}"
  echo "Cloning into $DIR"
  rm -rf "$DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 "$REPO" "$DIR" >/dev/null
fi

cd "$DIR"
echo "Linking the tradwife command"
npm link >/dev/null 2>&1 || npm install -g . >/dev/null 2>&1 || {
  red "Could not install globally. Try: sudo npm link   (or add npm's global bin to your PATH)"
  exit 1
}

command -v tradwife >/dev/null 2>&1 || {
  red "Installed, but 'tradwife' is not on your PATH. Add this to your shell profile:"
  red "  export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
  exit 1
}

tradwife init
echo
green "Done. Open a new Claude Code session and it will already know you."
echo "  tradwife status     see the wiring"
echo "  tradwife show       see what gets injected"
