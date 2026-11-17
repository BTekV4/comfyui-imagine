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
# against SHASUMS256.txt; ffmpeg and ffprobe come from an exact version whose
# SHA-256 is written in this file (`ffmpeg: every build is pinned` below), and
# a download that does not match is never packaged. The binary is also started
# once (`ffmpeg -version` must answer) so a wrong executable cannot pass on the
# digest of a right archive. All of it runs in CI.
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET=${1:?"the platform is required: linux-x64 | windows-x64 | macos-arm64 | macos-x64"}
VERSION=${VERSION:-$(node -p "require('./package.json').version")}
OUT=${OUT_DIR:-$PWD/release}
CACHE=${CACHE_DIR:-${TMPDIR:-/tmp}/imagine-runtime-cache}
mkdir -p "$OUT" "$CACHE"

NODE_VERSION=${NODE_VERSION:-24.22.3}

# --- ffmpeg: every build is pinned, and every download is checked ----------
# Nothing here follows a `latest`: the mirror's "current release" changed
# between two builds of the same commit, and a package nobody can reproduce is
# not a package. Each file below has an exact version and the SHA-256 of the
# exact bytes; a download whose digest does not match is discarded, retried,
# and finally refused (never packaged). The fallback is pinned the same way.
#
# WHY this file is the only place to update ffmpeg: `package-portable.sh` is
# the only script that downloads it, and `package-electron.sh` takes its
# `runtime/ffmpeg` from the portable tree — so the AppImage and the Windows
# installer are pinned by the same set of digests. Bumping ffmpeg therefore means
# one edit here:
#
#   1. Linux (johnvansickle, static, about 80 MB per binary): pick the version
#      from https://johnvansickle.com/ffmpeg/releases/ (files are named
#      `ffmpeg-<version>-amd64-static.tar.xz`; the site also publishes a `.md5`
#      beside the "release" alias, which is how the file below was confirmed —
#      it publishes no per-file SHA-256, so the digest is computed from the
#      official archive and written here).
#   2. Windows (BtbN): pick an `autobuild-<date>-<time>` release tag and the
#      asset inside it; BtbN ships a `checksums.sha256` in every release, use
#      it (the line for the chosen `.zip`).
#   3. Fallbacks (ffbinaries `v6.1`): the four zips under
#      https://github.com/ffbinaries/ffbinaries-prebuilt/releases/tag/v6.1.
#      They are the same small static builds johnvansickle publishes; BtbN's
#      full GPL build is 176 MB per binary and doubled the 0.3.0 zip, so it is
#      not the fallback.
#   4. Download the file, check `sha256sum <file>` against the publisher's
#      checksum (or compute it when there is none), update the version, URL and
#      digest below, then prove both paths in one run:
#
#        FFMPEG_LINUX_URL=https://example.invalid/ffmpeg.tar.xz \
#          OUT_DIR=release bash scripts/package-portable.sh linux-x64
#        OUT_DIR=release bash scripts/package-portable.sh windows-x64
#
#      The first command forces the fallback (`example.invalid` answers
#      nothing); CI's `release-rehearsal` job runs exactly that and checks the
#      package is the small one. `scripts/check-windows.ps1` then proves on a
#      real Windows runner that the packaged binary starts.
FFMPEG_LINUX_VERSION=7.0.2
FFMPEG_LINUX_SHA256=abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67
FFMPEG_LINUX_URL=${FFMPEG_LINUX_URL:-https://johnvansickle.com/ffmpeg/releases/ffmpeg-$FFMPEG_LINUX_VERSION-amd64-static.tar.xz}
# ffbinaries' 6.1 zips: the Linux fallback.
FFMPEG_LINUX_FALLBACK_VERSION=6.1
FFMPEG_LINUX_FALLBACK_FFMPEG=${FFMPEG_LINUX_FALLBACK_FFMPEG:-https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/ffmpeg-6.1-linux-64.zip}
FFMPEG_LINUX_FALLBACK_FFMPEG_SHA256=8bb4a27f5fd02f3dd9a5e75c9eddf6ace1d50a08929ee0d20bbf17eb467fb711
FFMPEG_LINUX_FALLBACK_FFPROBE=${FFMPEG_LINUX_FALLBACK_FFPROBE:-https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/ffprobe-6.1-linux-64.zip}
FFMPEG_LINUX_FALLBACK_FFPROBE_SHA256=cb690c360042b51d9e901db2b0185c585330c1067b5c5edf0b6a5e26e0375e2a
# BtbN's Windows build, pinned by release tag: `latest` is a moving tag, this
# one is a fixed set of bytes.
FFMPEG_WIN_BUILD=autobuild-2026-11-17-12-40
FFMPEG_WIN_ASSET=ffmpeg-N-129000-g64f6bcffaf-win64-gpl.zip
FFMPEG_WIN_SHA256=187a56f79cbbd9606d6937b9b45eaed8c49fb206272c18f48a14eb2003b7a310
FFMPEG_WIN_URL=${FFMPEG_WIN_URL:-https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/$FFMPEG_WIN_BUILD/$FFMPEG_WIN_ASSET}
# ffbinaries' 6.1 zips: the Windows fallback.
FFMPEG_WIN_FALLBACK_VERSION=6.1
FFMPEG_WIN_FALLBACK_FFMPEG=${FFMPEG_WIN_FALLBACK_FFMPEG:-https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/ffmpeg-6.1-win-64.zip}
FFMPEG_WIN_FALLBACK_FFMPEG_SHA256=b0fb4bcef9d4b5f7a77d2e4854f80d4ce3e43809bc29fd1f97caa1b467f96993
FFMPEG_WIN_FALLBACK_FFPROBE=${FFMPEG_WIN_FALLBACK_FFPROBE:-https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/ffprobe-6.1-win-64.zip}
FFMPEG_WIN_FALLBACK_FFPROBE_SHA256=3c0ea2856cf65edff23a2d4e76b1ceabba65fe8b1bed684ee2eeba24aa9427c3
# macOS is not built by CI or the release yet (the launcher ships only once it
# has been tried on a Mac), so it is not pinned here: evermeet.cx serves its
# "release" alias, which is what makes it unusable as a reproducible package.
FFMPEG_MAC_FFMPEG_URL=${FFMPEG_MAC_FFMPEG_URL:-https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip}
FFMPEG_MAC_FFPROBE_URL=${FFMPEG_MAC_FFPROBE_URL:-https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip}

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

# The digest is computed with the Node this script already needs: `sha256sum`
# is not on every host a package is built from (Git Bash has it today, a Mac
# does not), and `node -e` is one line everywhere.
digest_of() { # file → lowercase hex SHA-256
  node -e 'const { createHash } = require("node:crypto"), { createReadStream } = require("node:fs"); const h = createHash("sha256"); createReadStream(process.argv[1]).on("data", chunk => h.update(chunk)).on("end", () => console.log(h.digest("hex")))' "$1"
}

# A file is "the pinned one" only when its bytes hash to the digest above: a
# mirror serving an HTML page, a truncated transfer and a `latest` that moved
# are all the same failure here.
digest_matches() { # file expected
  [ "$(digest_of "$1")" = "$2" ]
}

# fetch + digest, twice: a cached file from an older pin is dropped, never
# trusted. The caller decides what a second failure means (retry, fallback).
fetch_pinned() { # url file sha256 what
  local url=$1 out=$2 want=$3 what=$4
  local attempt=1
  while :; do
    if fetch "$url" "$out" && digest_matches "$out" "$want"; then return 0; fi
    say "  $what: the download is missing or its SHA-256 is not the pinned one (attempt $attempt of 2)"
    rm -f "$out" "$out.url"
    [ "$attempt" -ge 2 ] && return 1
    attempt=$((attempt + 1))
    sleep 1
  done
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
  # evermeet.cx publishes the single binaries for macOS (not pinned: no
  # package ships them yet, see the note where the versions are declared).
  fetch "$FFMPEG_MAC_FFMPEG_URL" "$CACHE/ffmpeg-mac.zip"
  fetch "$FFMPEG_MAC_FFPROBE_URL" "$CACHE/ffprobe-mac.zip"
fi
case "$FFMPEG_KIND" in
  linux)
    # The archive is checked before it is used: `xz -t` costs nothing and says
    # right away whether what arrived really is a .tar.xz, and the SHA-256 says
    # whether it is the build this file pins. A page instead of the file is
    # what the site does when it is busy, and that answer is transient — on
    # 2026-11-17 the portable job got the page and the desktop job got the file
    # from the same URL minutes later. Fetch it again before reaching for
    # anything else.
    FFMPEG_LINUX_LAYOUT=tar
    attempt=1
    while :; do
      # A failed download, an HTML page and a file that is not the pinned one
      # are the same thing here: no archive to unpack. Each is retried, and
      # only after three attempts does the fallback run.
      if fetch_pinned "$FFMPEG_LINUX_URL" "$CACHE/ffmpeg-linux.tar.xz" "$FFMPEG_LINUX_SHA256" "ffmpeg $FFMPEG_LINUX_VERSION" \
        && xz -t "$CACHE/ffmpeg-linux.tar.xz" 2>/dev/null; then break; fi
      say "  the archive is not usable (attempt $attempt of 3)"
      rm -f "$CACHE/ffmpeg-linux.tar.xz" "$CACHE/ffmpeg-linux.tar.xz.url"
      if [ "$attempt" -ge 3 ]; then
        say "  falling back to ffbinaries $FFMPEG_LINUX_FALLBACK_VERSION (pinned, verified)"
        FFMPEG_LINUX_LAYOUT=zip
        fetch_pinned "$FFMPEG_LINUX_FALLBACK_FFMPEG" "$CACHE/ffmpeg-linux-fallback-ffmpeg.zip" \
          "$FFMPEG_LINUX_FALLBACK_FFMPEG_SHA256" "ffbinaries' ffmpeg" \
          || die "ffbinaries did not give ffmpeg (or not the pinned build)"
        fetch_pinned "$FFMPEG_LINUX_FALLBACK_FFPROBE" "$CACHE/ffmpeg-linux-fallback-ffprobe.zip" \
          "$FFMPEG_LINUX_FALLBACK_FFPROBE_SHA256" "ffbinaries' ffprobe" \
          || die "ffbinaries did not give ffprobe (or not the pinned build)"
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
  win)
    # The same shape as Linux: a pinned tag, a digest, a verified fallback.
    FFMPEG_WIN_LAYOUT=zip
    attempt=1
    while :; do
      if fetch_pinned "$FFMPEG_WIN_URL" "$CACHE/ffmpeg-win.zip" "$FFMPEG_WIN_SHA256" "ffmpeg $FFMPEG_WIN_BUILD"; then break; fi
      say "  the archive is not usable (attempt $attempt of 3)"
      rm -f "$CACHE/ffmpeg-win.zip" "$CACHE/ffmpeg-win.zip.url"
      if [ "$attempt" -ge 3 ]; then
        say "  falling back to ffbinaries $FFMPEG_WIN_FALLBACK_VERSION (pinned, verified)"
        FFMPEG_WIN_LAYOUT=zip-fallback
        fetch_pinned "$FFMPEG_WIN_FALLBACK_FFMPEG" "$CACHE/ffmpeg-win-fallback-ffmpeg.zip" \
          "$FFMPEG_WIN_FALLBACK_FFMPEG_SHA256" "ffbinaries' ffmpeg" \
          || die "ffbinaries did not give ffmpeg (or not the pinned build)"
        fetch_pinned "$FFMPEG_WIN_FALLBACK_FFPROBE" "$CACHE/ffmpeg-win-fallback-ffprobe.zip" \
          "$FFMPEG_WIN_FALLBACK_FFPROBE_SHA256" "ffbinaries' ffprobe" \
          || die "ffbinaries did not give ffprobe (or not the pinned build)"
        break
      fi
      attempt=$((attempt + 1))
      sleep "$attempt"
    done
    ;;
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
    if [ "$FFMPEG_WIN_LAYOUT" = zip-fallback ]; then
      # ffbinaries ships one binary per zip, at its root.
      "$PYTHON" -m zipfile -e "$CACHE/ffmpeg-win-fallback-ffmpeg.zip" "$CACHE/ffmpeg-win"
      "$PYTHON" -m zipfile -e "$CACHE/ffmpeg-win-fallback-ffprobe.zip" "$CACHE/ffmpeg-win"
      cp "$CACHE/ffmpeg-win/ffmpeg.exe" "$CACHE/ffmpeg-win/ffprobe.exe" "$APP/runtime/ffmpeg/"
    else
      "$PYTHON" -m zipfile -e "$CACHE/ffmpeg-win.zip" "$CACHE/ffmpeg-win"
      WINDIR=$(find "$CACHE/ffmpeg-win" -maxdepth 3 -type d -name bin | head -1)
      cp "$WINDIR/ffmpeg.exe" "$WINDIR/ffprobe.exe" "$APP/runtime/ffmpeg/"
    fi
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
