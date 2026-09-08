#!/usr/bin/env bash
# One-time: fetch the on-device accessibility agent (uiautomator2's u2.jar) into
# $EMU_COMPOSER_HOME/u2.jar (default ~/.config/emu-composer). The server pushes and runs it.
#
# Why: `uiautomator dump` costs 2.5 s per call (a fresh JVM each time — measured, fixed);
# the agent answers in 0.2 s, serves JPEG frames in 0.05 s, and is the only Unicode input
# path an emulator has. Nothing is downloaded by the server on its own — only by this script,
# from PyPI, into an isolated venv that is not used at runtime.
set -euo pipefail
DIR="${EMU_COMPOSER_HOME:-$HOME/.config/emu-composer}"
VENV="$DIR/u2venv"
VER="${U2_VERSION:-3.7.0}"
mkdir -p "$DIR"
command -v python3 >/dev/null || { echo "python3 is required to fetch the agent (it is not used at runtime)" >&2; exit 1; }
[ -x "$VENV/bin/python" ] || { echo "creating venv at $VENV"; python3 -m venv "$VENV"; }
"$VENV/bin/pip" install -q "uiautomator2==$VER"
JAR="$("$VENV/bin/python" -c 'import uiautomator2, os; print(os.path.join(os.path.dirname(uiautomator2.__file__), "assets", "u2.jar"))')"
cp "$JAR" "$DIR/u2.jar"
echo "u2.jar → $DIR/u2.jar ($(wc -c < "$DIR/u2.jar" | tr -d ' ') bytes, sha256 $(shasum -a 256 "$DIR/u2.jar" | cut -c1-16)…)"
"$VENV/bin/python" -c 'import uiautomator2, os; print("version.json:", open(os.path.join(os.path.dirname(uiautomator2.__file__), "assets", "version.json")).read().strip())'
echo "done — the next `emu-composer` run uses the fast path (or click the AGENT pill)."
