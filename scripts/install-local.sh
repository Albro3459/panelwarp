#!/bin/bash
# Quick local test install (not for publishing): builds Warp with the fast wasm-fast profile,
# packages it without brotli and installs it over the current extension. ~1.5 min instead of
# ~15 min for the release build + compressed package. Reload the VS Code window afterwards.
#   scripts/install-local.sh [--no-build]   (--no-build: reuse the last wasm-fast bundle)
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
[ "${1:-}" = --no-build ] || scripts/build-warp.sh --note "local test install"
NO_BROTLI=1 scripts/package.sh darwin-arm64 wasm-fast
code --install-extension panelwarp-darwin-arm64.vsix --force 2>&1 | grep -iv deprecat || true
echo "installed; reload the VS Code window to use it"
