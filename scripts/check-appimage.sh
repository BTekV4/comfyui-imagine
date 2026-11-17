#!/usr/bin/env bash
#
# Start Imagine's AppImage **without a screen** and check what a person would
# see, not just that the process is alive.
#
#   scripts/check-appimage.sh release/Imagine-1.0.0-linux-x64.AppImage [work dir]
#
# What it proves, in order:
#
# 1. the window loads the studio — the app writes what it sees (address, title,
#    the page's own `#root` children) and a screenshot of the virtual screen is
#    kept, so a blank window is a failure and not a file nobody looked at;
# 2. a second launch does not start a second studio (single instance);
# 3. closing the window stops the server: the pid the app reported must be gone.
#
# Used by `.github/workflows/ci.yml` and by the release, so the package people
# download is the one this ran against. Needs Xvfb, ImageMagick's `import`,
# Node, and no FUSE (the AppImage unpacks itself).
set -euo pipefail
APP=$(readlink -f "${1:?"the AppImage is required"}")
WORK=${2:-$(mktemp -d "${TMPDIR:-/tmp}/imagine-check.XXXXXX")}
mkdir -p "$WORK"
say() { printf 'check: %s\n' "$*"; }
fail() { printf 'check: FAILED: %s\n' "$*" >&2; exit 1; }

[ -f "$APP" ] || fail "no AppImage at $APP"
chmod +x "$APP"
export IMAGINE_DATA="$WORK/data"
rm -rf -- "$IMAGINE_DATA"
mkdir -p "$IMAGINE_DATA"
# No FUSE on a CI runner: the AppImage unpacks itself and runs from /tmp.
export APPIMAGE_EXTRACT_AND_RUN=1
export IMAGINE_APP_SELFTEST="$WORK/selftest.json"
# The window closes itself after the checks: that is the path a person's click
# takes, and it must stop the server.
export IMAGINE_APP_SELFTEST_CLOSE_MS=15000

DISPLAY_NUMBER=${DISPLAY_NUMBER:-99}
Xvfb ":$DISPLAY_NUMBER" -screen 0 1440x900x24 > "$WORK/xvfb.log" 2>&1 &
XVFB_PID=$!
cleanup() {
  kill "$XVFB_PID" 2>/dev/null || true
  if [ -n "${APP_PID:-}" ]; then kill "$APP_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT
export DISPLAY=":$DISPLAY_NUMBER"
sleep 2

# The desktop entry and the icon are what put Imagine in the applications menu
# when the file is integrated: they are inside the image, so they are checked
# from the image (one file at a time: no need to unpack 450 MB).
for entry in imagine.desktop .DirIcon; do
  ( cd "$WORK" && "$APP" --appimage-extract "$entry" >/dev/null 2>&1 ) || fail "the image has no $entry"
done
grep -q "^Terminal=false" "$WORK/squashfs-root/imagine.desktop" || fail "the desktop entry asks for a terminal"
grep -q "^Name=Imagine$" "$WORK/squashfs-root/imagine.desktop" || fail "the desktop entry is not named Imagine"
[ -s "$WORK/squashfs-root/.DirIcon" ] || fail "the image has no icon"
say "menu entry and icon in the image"
rm -rf -- "$WORK/squashfs-root"

say "starting $(basename "$APP") on $DISPLAY"
"$APP" > "$WORK/app.log" 2>&1 &
APP_PID=$!
# A first start prepares the data folder and the server boots the studio.
for _ in $(seq 1 120); do
  [ -f "$IMAGINE_APP_SELFTEST" ] && break
  sleep 1
done
if [ ! -f "$IMAGINE_APP_SELFTEST" ]; then
  cat "$WORK/app.log" || true
  tail -80 "$IMAGINE_DATA/logs/imagine.log" 2>/dev/null || true
  fail "the window never loaded the studio"
fi
cat "$IMAGINE_APP_SELFTEST"
import -window root "$WORK/window.png"
[ -s "$WORK/window.png" ] || fail "the screenshot is empty"

node - "$IMAGINE_APP_SELFTEST" <<'CHECK'
const { readFileSync } = require('node:fs')
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const fail = (why) => { console.error(`check: FAILED: ${why}`); process.exit(1) }
if (report.studioLoaded !== true) fail('the studio did not report itself as loaded')
if (!/^http:\/\/127\.0\.0\.1:\d+/.test(report.url)) fail(`the window is not on the studio: ${report.url}`)
if (report.title !== 'Imagine') fail(`the window title is ${JSON.stringify(report.title)}, not Imagine`)
if (!(report.rootChildren > 0)) fail('the page rendered nothing: the studio did not draw')
if (report.visible !== true) fail('the window is not visible')
console.log(`check: window ok — ${report.url}, ${report.rootChildren} nodes in #root, ${report.node} on Electron ${report.electron}`)
CHECK

# A second double click must hand the window to the first one.
say "second launch"
export IMAGINE_APP_SELFTEST="$WORK/selftest-second.json"
if timeout 40 "$APP" > "$WORK/second.log" 2>&1; then :; else true; fi
if [ -f "$IMAGINE_APP_SELFTEST" ]; then fail "a second launch started a second studio"; fi
export IMAGINE_APP_SELFTEST="$WORK/selftest.json"
say "second launch kept the first window"

# Closing the window closes the studio with it.
SERVER_PID=$(node -e "console.log(JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).serverPid)" "$IMAGINE_APP_SELFTEST")
say "waiting for the window to close (${IMAGINE_APP_SELFTEST_CLOSE_MS} ms)"
# The self-test closes the window; `wait` returns when the app is gone.
WAITED=0
while kill -0 "$APP_PID" 2>/dev/null && [ "$WAITED" -lt 90 ]; do sleep 1; WAITED=$((WAITED + 1)); done
if kill -0 "$APP_PID" 2>/dev/null; then fail "the window never closed"; fi
APP_PID=
sleep 3
if kill -0 "$SERVER_PID" 2>/dev/null; then
  ps -o pid,args -p "$SERVER_PID" || true
  fail "the studio server (pid $SERVER_PID) outlived the window"
fi
say "window closed, server $SERVER_PID gone"
say "screenshot: $WORK/window.png"
say "log: $IMAGINE_DATA/logs/imagine.log"
