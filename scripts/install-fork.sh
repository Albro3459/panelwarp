#!/bin/bash
# Installs this fork into VS Code under its fork version (scripts/fork-version.sh), from the
# release Warp bundle already built in the Warp checkout. Doesn't build Warp: run
# scripts/build-warp.sh --release first when the Warp source changed. Packages without brotli like
# scripts/install-local.sh. Reload the VS Code window afterwards.
#   scripts/install-fork.sh
#   WARP_SRC: the Warp checkout (default ~/GitHub/warp); WARP_TARGET_DIR: its build output
#   (default $WARP_SRC/target)
set -euo pipefail
cd "$(dirname "$0")/.."
export WARP_SRC="${WARP_SRC:-$HOME/GitHub/warp}"
export WARP_TARGET_DIR="${WARP_TARGET_DIR:-$WARP_SRC/target}"
VERSION=$(scripts/fork-version.sh)
# package.sh exports warp-patches/ again, and a checkout made with git am gives every patch new
# commit hashes and counters. Put the tracked patches back, so only new patches show up in git.
PATCHES="$(mktemp -d)"
trap 'cp "$PATCHES"/* warp-patches/; rm -rf "$PATCHES"' EXIT
cp warp-patches/* "$PATCHES/"
PACKAGE_VERSION=$VERSION NO_BROTLI=1 scripts/package.sh darwin-arm64 release-wasm
code --install-extension panelwarp-darwin-arm64.vsix --force 2>&1 | grep -iv deprecat || true
echo "installed $VERSION; reload the VS Code window to use it"
