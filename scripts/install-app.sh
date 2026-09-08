#!/usr/bin/env bash
# Install "<App> Composer.app" into ~/Applications: a real macOS app that Spotlight finds and
# the Dock can hold. Launching it runs `emu-composer run` for one project. Re-run after
# moving the repo or the emu-composer checkout.
#   env: APP_NAME, CONFIG_PATH (the project's emu-composer.json), EMU_COMPOSER_ROOT, ICON_SRC
set -euo pipefail
ROOT="${EMU_COMPOSER_ROOT:?}"
NAME="${APP_NAME:-Emu Composer}"
CONFIG="${CONFIG_PATH:?}"
APP="$HOME/Applications/$NAME.app"
ICON_SRC="${ICON_SRC:-}"
# Default icon: the project's own launcher icon when it can be found next to the config.
if [ -z "$ICON_SRC" ]; then
  ICON_SRC="$(find "$(dirname "$CONFIG")" -path '*/build' -prune -o \( -name 'icon-1024.png' -o -name 'ic_launcher-playstore.png' -o -name 'ic_launcher*.png' \) -print 2>/dev/null | sort | tail -1 || true)"
fi

rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>dev.emu-composer.launcher.$(echo "$NAME" | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]')</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>
PLIST
# A Dock app has no terminal: everything goes to ~/Library/Logs. The login zsh makes
# ANDROID_HOME / node / adb resolve as they do in Terminal.
cat > "$APP/Contents/MacOS/launch" <<LAUNCH
#!/bin/bash
LOG="\$HOME/Library/Logs/emu-composer.log"; mkdir -p "\$(dirname "\$LOG")"
echo "=== \$(date) launch ===" >> "\$LOG"
exec /bin/zsh -lc 'node "$ROOT/bin/emu-composer.js" run --config "$CONFIG"' >> "\$LOG" 2>&1
LAUNCH
chmod +x "$APP/Contents/MacOS/launch"
if [ -n "$ICON_SRC" ] && [ -f "$ICON_SRC" ]; then
  SET="$(mktemp -d)/AppIcon.iconset"; mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ICON_SRC" --out "$SET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$ICON_SRC" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns"
fi
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
touch "$APP"
echo "installed: $APP"
echo "  • Spotlight: ⌘Space → \"$NAME\"   • Dock: drag it from ~/Applications once   • log: ~/Library/Logs/emu-composer.log"
