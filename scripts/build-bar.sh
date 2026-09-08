#!/usr/bin/env bash
# Build the floating bar (mac/Banner/main.swift) into ~/Applications/Emu Composer Bar.app.
# Skipped when the built binary is newer than the source.
set -euo pipefail
ROOT="${EMU_COMPOSER_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SRC="$ROOT/mac/Banner/main.swift"
APP="$HOME/Applications/Emu Composer Bar.app"
BIN="$APP/Contents/MacOS/EmuComposerBar"
[ "$(uname)" = "Darwin" ] || { echo "the floating bar is macOS-only" >&2; exit 1; }
if [ -x "$BIN" ] && [ "$BIN" -nt "$SRC" ]; then exit 0; fi
command -v xcrun >/dev/null || { echo "Xcode command line tools are required: xcode-select --install" >&2; exit 1; }
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Emu Composer Bar</string>
  <key>CFBundleIdentifier</key><string>dev.emu-composer.bar</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>EmuComposerBar</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
echo "building the floating bar…"
xcrun swiftc -O -framework AppKit -o "$BIN" "$SRC"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "built: $APP"
