#!/bin/bash
# Publishes the extension to the VS Code Marketplace for macOS (Apple silicon and Intel; macOS only
# since 0.1.14, so Linux stays on 0.1.13).
#   scripts/publish.sh [--skip-build]
# Bump "version" in package.json first. Runs the release Warp build (unless --skip-build), packages
# one VSIX per platform (scripts/package.sh) and uploads them all with vsce, which reads the token
# saved by `npx @vscode/vsce login felixkrueckel` (or VSCE_PAT).
set -euo pipefail
cd "$(dirname "$0")/.."
TARGETS=(darwin-arm64 darwin-x64)
VERSION=$(node -p 'require("./package.json").version')

for target in "${TARGETS[@]}"; do
  [ -d "node_modules/node-pty/prebuilds/$target" ] || {
    echo "no node-pty prebuild for $target"
    exit 2
  }
done
[ -n "${VSCE_PAT:-}" ] || npx --yes @vscode/vsce ls-publishers 2>/dev/null | grep -qx felixkrueckel || {
  echo 'not logged in: run `npx @vscode/vsce login felixkrueckel` with a Marketplace (Manage) token'
  exit 2
}

[ "${1:-}" = --skip-build ] || scripts/build-warp.sh --release --note "Release build for $VERSION"

# Both at once: each one brotli-compresses ~200 MB.
rm -f panelwarp-*.vsix
for target in "${TARGETS[@]}"; do scripts/package.sh "$target" >"/tmp/panelwarp-package-$target.log" 2>&1 & done
wait
for target in "${TARGETS[@]}"; do
  [ -f "panelwarp-$target.vsix" ] || { tail -20 "/tmp/panelwarp-package-$target.log"; exit 1; }
done

# One upload per package, with retries: publishing all four in one call failed with EPIPE
# (2026-10-11), while single uploads went through.
for vsix in panelwarp-*.vsix; do
  for try in 1 2 3; do
    npx --yes @vscode/vsce publish --packagePath "$vsix" && break
    [ $try = 3 ] && { echo "upload of $vsix failed"; exit 1; }
    sleep 10
  done
done
echo "published $VERSION: https://marketplace.visualstudio.com/items?itemName=felixkrueckel.panelwarp"
