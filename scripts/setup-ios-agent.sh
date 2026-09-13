#!/usr/bin/env bash
# Build the iOS on-device agent once. Needs Xcode and XcodeGen (`brew install xcodegen`).
# Products land in ~/.config/emu-composer/ios-agent-dd; the server starts the runner from the
# .xctestrun there with `xcodebuild test-without-building`, no rebuild per run.
set -euo pipefail
HOME_DIR="${EMU_COMPOSER_HOME:-$HOME/.config/emu-composer}"
ROOT="${EMU_COMPOSER_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DD="$HOME_DIR/ios-agent-dd"
command -v xcodegen >/dev/null || { echo "xcodegen is required: brew install xcodegen" >&2; exit 2; }
command -v xcodebuild >/dev/null || { echo "Xcode command line tools are required" >&2; exit 2; }
# A booted simulator, or the first available iPhone, is the build destination.
UDID="${1:-}"
if [ -z "$UDID" ]; then
  UDID=$(xcrun simctl list devices booted -j | python3 -c 'import sys,json;d=json.load(sys.stdin);print(next((x["udid"] for l in d["devices"].values() for x in l if x["state"]=="Booted"),""))')
fi
if [ -z "$UDID" ]; then
  UDID=$(xcrun simctl list devices available -j | python3 -c 'import sys,json;d=json.load(sys.stdin);print(next((x["udid"] for r,l in d["devices"].items() for x in l if "iPhone" in x["name"]),""))')
fi
[ -n "$UDID" ] || { echo "no iPhone simulator found — create one in Xcode (Devices and Simulators)" >&2; exit 2; }
cd "$ROOT/ios/agent"
xcodegen generate >/dev/null
mkdir -p "$DD"
echo "▶ building the iOS agent for simulator $UDID (one-time, a few minutes)…"
xcodebuild build-for-testing -project EmuAgent.xcodeproj -scheme EmuAgent \
  -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath "$DD" CODE_SIGNING_ALLOWED=NO -quiet
RUN=$(ls "$DD"/Build/Products/*.xctestrun 2>/dev/null | head -1)
[ -n "$RUN" ] || { echo "build finished but no .xctestrun was produced" >&2; exit 1; }
echo "✔ iOS agent built → $RUN"
