#!/usr/bin/env bash
#
# Imagine's "portable" package: the app, Node and ffmpeg inside, a launcher and
# no questions asked. It is the shape people who use ComfyUI already know (the
# official portable zip), and on Windows it is the only possible one: there is
# no bash, no Node and no ffmpeg there.
#
#   scripts/package-portable.sh linux-x64     → release/Imagine-<ver>-linux-x64.zip
#   scripts/package-portable.sh windows-x64   → release/Imagine-<ver>-windows-x64.zip
#   scripts/package-portable.sh macos-arm64   → release/Imagine-<ver>-macos-arm64.zip
#   scripts/package-portable.sh macos-x64
#
# The app tree is built first (scripts/release-tarball.sh), then the platform
# binaries are added in runtime/ together with the launcher.
#
# About the binaries: Node comes from nodejs.org and its digest is checked
# against SHASUMS256.txt; ffmpeg comes from a pinned static build and the check
# is functional (`ffmpeg -version` must answer), because those builds do not
# publish per-file digests. Both checks run in CI.
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET=${1:?"the platform is required: linux-x64 | windows-x64 | macos-arm64 | macos-x64"}
VERSION=${VERSION:-$(node -p "require('./package.json').version")}
OUT=${OUT_DIR:-$PWD/release}
CACHE=${CACHE_DIR:-${TMPDIR:-/tmp}/imagine-runtime-cache}
mkdir -p "$OUT" "$CACHE"

NODE_VERSION=${NODE_VERSION:-24.22.3}
# johnvansickle: static, 79 MB per binary against the 176 of BtbN's full
# builds — half the package, with what is needed (filters, libx264, aac). The
# site answers a CI runner with an HTML page instead of the archive now and
# then (`xz: File format not recognized`, seen on 2026-11-16 and again on
# 2026-11-17): an invalid answer is fetched again before anything else, because
# the next one is usually the file. Only after the retries does the fallback
# run — and it is **the same size**: ffbinaries publishes the same static
# builds from GitHub. BtbN's full GPL build is not used as the fallback: its
# binaries are 176 MB each, and that is why the 0.3.0 zip went out at 195 MB
# instead of 113.
FFMPEG_LINUX_URL=${FFMPEG_LINUX_URL:-https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz}
FFMPEG_LINUX_FALLBACK_FFMPEG=https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/ffmpeg-6.1-linux-64.zip
FFMPEG_LINUX_FALLBACK_FFPROBE=https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/ffprobe-6.1-linux-64.zip
FFMPEG_WIN_URL=${FFMPEG_WIN_URL:-https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip}

PYTHON=${PYTHON:-$(command -v python3 || command -v python)}
[ -n "$PYTHON" ] || die "Python (3) is needed for the zip files"
say() { printf '%s\n' "$*"; }
die() { printf 'package: %s\n' "$*" >&2; exit 3; }

# The cache is keyed by URL, not by name: two different ffmpeg builds with the
# same file name already cost a 186 MB package that seemed not to change.
fetch() { # url → file in the cache, downloaded once
  local url=$1 out=$2
  [ -s "$out" ] && [ "$(cat "$out.url" 2>/dev/null)" = "$url" ] && return 0
  say "  downloading $(basename "$out")"
  curl -fsSL --retry 3 -o "$out" "$url"
  printf '%s' "$url" > "$out.url"
}

# 0. The version is printed by the BUILD: a dist/ built before bumping the
#    number in package.json ends up in the package with the old version
#    (happened on 2026-11-16: an AppImage 0.1.1 that said 0.1.0 inside). When
#    dist/ is missing or older than the manifest, it is rebuilt: it costs
#    seconds.
if [ ! -f dist/server.mjs ] || [ package.json -nt dist/server.mjs ]; then
  say "app: dist/ is missing or older than package.json — rebuilding"
  npm run build >/dev/null
fi

# 1. the app tree: the same as the tarball, so the two shapes do not diverge
say "app: building the tree"
VERSION="$VERSION" bash scripts/release-tarball.sh >/dev/null
APP="$OUT/Imagine-$VERSION-$TARGET"
rm -rf -- "$APP"
mkdir -p -- "$APP"
tar xzf "$OUT/comfyui-imagine-$VERSION.tar.gz" -C "$APP" --strip-components=1
# The tarball carries the version in the folder name: here the name is another one.
rm -f -- "$OUT/comfyui-imagine-$VERSION.tar.gz" "$OUT/comfyui-imagine-$VERSION.tar.gz.sha256" 2>/dev/null || true

# 2. the platform binaries
mkdir -p "$APP/runtime/node" "$APP/runtime/ffmpeg"
case "$TARGET" in
  linux-x64)   NODE_OS=linux-x64;   NODE_EXE=node;       FFMPEG_KIND=linux ;;
  windows-x64) NODE_OS=win-x64;     NODE_EXE=node.exe;   FFMPEG_KIND=win ;;
  macos-arm64) NODE_OS=darwin-arm64; NODE_EXE=node;      FFMPEG_KIND=mac ;;
  macos-x64)   NODE_OS=darwin-x64;  NODE_EXE=node;       FFMPEG_KIND=mac ;;
  *) die "unknown platform: $TARGET" ;;
esac

# Node for Windows is downloaded as a .zip (and the exe sits at the root,
# without bin/): a single "tar.gz + bin/" scheme here costs a 404 and no package.
case "$TARGET" in
  windows-*) NODE_EXT=zip ;;
  *) NODE_EXT=tar.gz ;;
esac
NODE_ARCHIVE="$CACHE/node-v$NODE_VERSION-$NODE_OS.$NODE_EXT"
NODE_URL="https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$NODE_OS.$NODE_EXT"
if [ "$FFMPEG_KIND" = mac ]; then
  # evermeet.cx publishes the single binaries for macOS.
  fetch "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip" "$CACHE/ffmpeg-mac.zip"
  fetch "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip" "$CACHE/ffprobe-mac.zip"
fi
case "$FFMPEG_KIND" in
  linux)
    # The archive is checked before it is used: `xz -t` costs nothing and says
    # right away whether what arrived really is a .tar.xz. A page instead of
    # the file is what the site does when it is busy, and that answer is
    # transient — on 2026-11-17 the portable job got the page and the desktop
    # job got the file from the same URL minutes later. Fetch it again before
    # reaching for anything else.
    FFMPEG_LINUX_LAYOUT=tar
    attempt=1
    while :; do
      # A failed download and an HTML page are the same thing here: no archive
      # to unpack. Both are retried, and only then does the fallback run.
      if fetch "$FFMPEG_LINUX_URL" "$CACHE/ffmpeg-linux.tar.xz" \
        && xz -t "$CACHE/ffmpeg-linux.tar.xz" 2>/dev/null; then break; fi
      say "  the archive is not usable (attempt $attempt of 3)"
      rm -f "$CACHE/ffmpeg-linux.tar.xz" "$CACHE/ffmpeg-linux.tar.xz.url"
      if [ "$attempt" -ge 3 ]; then
        say "  falling back to ffbinaries' static builds (same size)"
        FFMPEG_LINUX_LAYOUT=zip
        fetch "$FFMPEG_LINUX_FALLBACK_FFMPEG" "$CACHE/ffmpeg-linux-fallback-ffmpeg.zip" \
          || die "ffbinaries did not give ffmpeg"
        fetch "$FFMPEG_LINUX_FALLBACK_FFPROBE" "$CACHE/ffmpeg-linux-fallback-ffprobe.zip" \
          || die "ffbinaries did not give ffprobe"
        "$PYTHON" -m zipfile -t "$CACHE/ffmpeg-linux-fallback-ffmpeg.zip" >/dev/null 2>&1 \
          || die "ffbinaries' ffmpeg archive is not a zip"
        "$PYTHON" -m zipfile -t "$CACHE/ffmpeg-linux-fallback-ffprobe.zip" >/dev/null 2>&1 \
          || die "ffbinaries' ffprobe archive is not a zip"
        break
      fi
      attempt=$((attempt + 1))
      sleep "$attempt"
    done
    ;;
  win)   fetch "$FFMPEG_WIN_URL"   "$CACHE/ffmpeg-win.zip" ;;
esac

say "runtime: Node $NODE_VERSION ($NODE_OS)"
fetch "$NODE_URL" "$NODE_ARCHIVE"
fetch "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" "$CACHE/SHASUMS256-$NODE_VERSION.txt"
( cd "$CACHE" && grep " node-v$NODE_VERSION-$NODE_OS.$NODE_EXT\$" "SHASUMS256-$NODE_VERSION.txt" | sha256sum -c --quiet - ) \
  || die "Node's digest does not match: not packaging it"
rm -rf "$CACHE/node-v$NODE_VERSION-$NODE_OS"
mkdir -p "$CACHE/node-v$NODE_VERSION-$NODE_OS"
if [ "$NODE_EXT" = zip ]; then
  "$PYTHON" -m zipfile -e "$NODE_ARCHIVE" "$CACHE/node-v$NODE_VERSION-$NODE_OS"
  cp "$CACHE/node-v$NODE_VERSION-$NODE_OS/node-v$NODE_VERSION-$NODE_OS/$NODE_EXE" "$APP/runtime/node/$NODE_EXE"
else
  tar xzf "$NODE_ARCHIVE" -C "$CACHE/node-v$NODE_VERSION-$NODE_OS" --strip-components=1
  cp "$CACHE/node-v$NODE_VERSION-$NODE_OS/bin/$NODE_EXE" "$APP/runtime/node/$NODE_EXE"
fi
chmod +x "$APP/runtime/node/$NODE_EXE" 2>/dev/null || true

say "runtime: ffmpeg ($FFMPEG_KIND)"
case "$FFMPEG_KIND" in
  linux)
    rm -rf "$CACHE/ffmpeg-linux" && mkdir -p "$CACHE/ffmpeg-linux"
    if [ "$FFMPEG_LINUX_LAYOUT" = zip ]; then
      # ffbinaries ships one binary per zip, at its root.
      "$PYTHON" -m zipfile -e "$CACHE/ffmpeg-linux-fallback-ffmpeg.zip" "$CACHE/ffmpeg-linux"
      "$PYTHON" -m zipfile -e "$CACHE/ffmpeg-linux-fallback-ffprobe.zip" "$CACHE/ffmpeg-linux"
      chmod +x "$CACHE/ffmpeg-linux/ffmpeg" "$CACHE/ffmpeg-linux/ffprobe"
      cp "$CACHE/ffmpeg-linux/ffmpeg" "$CACHE/ffmpeg-linux/ffprobe" "$APP/runtime/ffmpeg/"
    else
      tar xf "$CACHE/ffmpeg-linux.tar.xz" -C "$CACHE/ffmpeg-linux" --strip-components=1
      # Two layouts out there: `bin/ffmpeg` (BtbN) and the binaries at the root
      # (johnvansickle). The one that is there is taken.
      FF_BIN="$CACHE/ffmpeg-linux/bin"; [ -d "$FF_BIN" ] || FF_BIN="$CACHE/ffmpeg-linux"
      cp "$FF_BIN/ffmpeg" "$FF_BIN/ffprobe" "$APP/runtime/ffmpeg/"
    fi
    ;;
  win)
    rm -rf "$CACHE/ffmpeg-win" && mkdir -p "$CACHE/ffmpeg-win"
    "$PYTHON" -m zipfile -e "$CACHE/ffmpeg-win.zip" "$CACHE/ffmpeg-win"
    WINDIR=$(find "$CACHE/ffmpeg-win" -maxdepth 3 -type d -name bin | head -1)
    cp "$WINDIR/ffmpeg.exe" "$WINDIR/ffprobe.exe" "$APP/runtime/ffmpeg/"
    ;;
  mac)
    ( cd "$APP/runtime/ffmpeg" && unzip -qo "$CACHE/ffmpeg-mac.zip" && unzip -qo "$CACHE/ffprobe-mac.zip" )
    ;;
esac
chmod +x "$APP/runtime/ffmpeg/"* 2>/dev/null || true
# The check that matters: the binary, on this machine, answers.
if [ "$FFMPEG_KIND" = linux ] || [ "$FFMPEG_KIND" = mac ]; then
  [ "$TARGET" = "$(uname -s | tr 'A-Z' 'a-z')-$(uname -m | sed 's/x86_64/x64/')" ] \
    && { "$APP/runtime/ffmpeg/ffmpeg" -version >/dev/null || die "ffmpeg does not start"; } || true
fi

# 3. the launcher: double-click, no questions, the browser opens by itself
write_linux() {
  cat > "$APP/Imagine.sh" <<'SH'
#!/usr/bin/env bash
# Starts Imagine: double-click (or ./Imagine.sh). Opens the browser when the page answers.
cd "$(dirname "$0")" || exit 1
export IMAGINE_CONFIG="$PWD/config.yaml"
export IMAGINE_HOME="$PWD/data"
export PATH="$PWD/runtime/node:$PWD/runtime/ffmpeg:$PATH"
PORT=$(node -e "try{const y=require('yaml');console.log(y.parse(require('fs').readFileSync('config.yaml','utf8')).port||3090)}catch{console.log(3090)}" 2>/dev/null || echo 3090)
# Second launch: Imagine is already running, only the page is opened. Without
# this, double-clicking twice ended in EADDRINUSE with a stack trace.
if command -v curl >/dev/null && curl -fsS --max-time 2 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  echo "Imagine is already running: opening the page."
  command -v xdg-open >/dev/null && xdg-open "http://127.0.0.1:$PORT/" >/dev/null 2>&1
  exit 0
fi
(
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
      command -v xdg-open >/dev/null && xdg-open "http://127.0.0.1:$PORT/" >/dev/null 2>&1
      break
    fi
    sleep 1
  done
) &
exec "$PWD/runtime/node/node" dist/server.mjs
SH
  chmod +x "$APP/Imagine.sh"
  cat > "$APP/Imagine.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Imagine
Comment=A local studio for ComfyUI
Exec=sh -c 'cd "$APP" && ./Imagine.sh'
Terminal=true
Icon=$APP/web/favicon-512.png
DESK
}
write_windows() {
  cat > "$APP/Start Imagine.bat" <<'BAT'
@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "IMAGINE_CONFIG=%CD%\config.yaml"
set "IMAGINE_HOME=%CD%\data"
set "PATH=%CD%\runtime\node;%CD%\runtime\ffmpeg;%PATH%"
rem The port the config names, read with the bundled Node: the fixed 3090
rem below made a second copy start (EADDRINUSE) for anyone who changed it.
set "PORTFILE=%TEMP%\imagine-port-%RANDOM%.txt"
"runtime\node\node.exe" -e "const y=require('./node_modules/yaml'),fs=require('fs');try{fs.writeFileSync(process.argv[1],String(y.parse(fs.readFileSync('config.yaml','utf8')).port||3090))}catch{fs.writeFileSync(process.argv[1],'3090')}" "%PORTFILE%" >nul 2>&1
set "PORT="
set /p PORT=<"%PORTFILE%" 2>nul
del "%PORTFILE%" >nul 2>&1
if not defined PORT set "PORT=3090"
echo.
echo   Imagine: the browser opens in a few seconds.
echo   Leave this window open while you use it; close it to stop Imagine.
echo.
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:%PORT%).StatusCode|Out-Null; exit 0}catch{exit 1}" >nul 2>&1
if %errorlevel%==0 (
  echo Imagine is already running: opening the page.
  start "" http://127.0.0.1:%PORT%
  exit /b 0
)
start "" cmd /c "timeout /t 4 >nul & start http://127.0.0.1:%PORT%"
"runtime\node\node.exe" dist\server.mjs
echo.
echo   Imagine has stopped. Press a key to close.
pause >nul
BAT
  printf 'Imagine %s: double-click "Start Imagine.bat".\r\n' "$VERSION" > "$APP/README.txt"
  printf 'ComfyUI must already be running (port 8188). If it is not, the page says so.\r\n' >> "$APP/README.txt"
}
write_macos() {
  cat > "$APP/Imagine.command" <<'SH'
#!/bin/bash
cd "$(dirname "$0")" || exit 1
export IMAGINE_CONFIG="$PWD/config.yaml"
export IMAGINE_HOME="$PWD/data"
export PATH="$PWD/runtime/node:$PWD/runtime/ffmpeg:$PATH"
if curl -fsS --max-time 2 "http://127.0.0.1:3090/" >/dev/null 2>&1; then
  echo "Imagine is already running: opening the page."
  open "http://127.0.0.1:3090"; exit 0
fi
( sleep 4; open "http://127.0.0.1:3090" ) &
exec "$PWD/runtime/node/node" dist/server.mjs
SH
  chmod +x "$APP/Imagine.command"
}
case "$TARGET" in
  linux-*) write_linux ;;
  windows-*) write_windows ;;
  macos-*) write_macos ;;
esac

# 4. the zip
ZIP="$OUT/Imagine-$VERSION-$TARGET.zip"
rm -f -- "$ZIP"
"$PYTHON" - "$OUT" "$(basename "$APP")" "$(basename "$ZIP")" <<'ZIPPER'
import os, sys, zipfile
out, folder, name = sys.argv[1:4]
with zipfile.ZipFile(os.path.join(out, name), "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
    for root, _dirs, files in os.walk(os.path.join(out, folder)):
        for f in sorted(files):
            full = os.path.join(root, f)
            zf.write(full, os.path.relpath(full, out))
ZIPPER
( cd "$OUT" && sha256sum "$(basename "$ZIP")" > "$(basename "$ZIP").sha256" )
say "package: $ZIP ($(du -h "$ZIP" | cut -f1))"
