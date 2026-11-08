#!/bin/bash
# Builds the macOS notifier app (notifier/main.swift) into notifier/Panelwarp.app, ad-hoc signed,
# with the extension's icon. scripts/package.sh runs it for darwin targets.
#   scripts/build-notifier.sh [arm64|x86_64] [output .app]   (default: arm64, notifier/Panelwarp.app)
set -euo pipefail
cd "$(dirname "$0")/.."
ARCH="${1:-arm64}"
APP="${2:-notifier/Panelwarp.app}"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp notifier/Info.plist "$APP/Contents/"
swiftc -O -target "$ARCH-apple-macos12" notifier/main.swift -o "$APP/Contents/MacOS/panelwarp-notifier"

ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size media/icon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) media/icon.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns"
rm -rf "$(dirname "$ICONSET")"

codesign --force --sign - "$APP"
echo "built $APP ($ARCH)"
