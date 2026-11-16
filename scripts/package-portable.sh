#!/usr/bin/env bash
#
# Il pacchetto "portable" di Imagine: l'app, Node e ffmpeg dentro, un lanciatore
# e niente domande. È la forma che chi usa ComfyUI conosce già (lo zip portable
# ufficiale), e su Windows è l'unica forma possibile: là non c'è bash, né Node,
# né ffmpeg.
#
#   scripts/package-portable.sh linux-x64     → release/Imagine-<ver>-linux-x64.zip
#   scripts/package-portable.sh windows-x64   → release/Imagine-<ver>-windows-x64.zip
#   scripts/package-portable.sh macos-arm64   → release/Imagine-<ver>-macos-arm64.zip
#   scripts/package-portable.sh macos-x64
#
# Prima si costruisce l'albero dell'app (scripts/release-tarball.sh), poi si
# aggiungono i binari della piattaforma in runtime/ e il lanciatore.
#
# Sui binari: Node arriva da nodejs.org e la sua impronta è verificata contro
# SHASUMS256.txt; ffmpeg da una build statica pinnata e la verifica è
# funzionale (`ffmpeg -version` deve rispondere), perché quelle build non
# pubblicano impronte per file. Entrambe le verifiche girano in CI.
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET=${1:?"serve la piattaforma: linux-x64 | windows-x64 | macos-arm64 | macos-x64"}
VERSION=$(node -p "require('./package.json').version")
OUT=${OUT_DIR:-$PWD/release}
CACHE=${CACHE_DIR:-${TMPDIR:-/tmp}/imagine-runtime-cache}
mkdir -p "$OUT" "$CACHE"

NODE_VERSION=${NODE_VERSION:-24.22.3}
# johnvansickle: statica, 77 MB per binario contro i 169 delle build complete di
# BtbN — la metà del pacchetto, con quello che serve (filtri, libx264, aac).
# Ma il 16/11/2026 il suo sito ha risposto a un runner di CI con una pagina HTML
# invece dell'archivio (`xz: File format not recognized`): se il file non è un
# xz valido si passa a BtbN, che sta su GitHub e non ha sorprese.
FFMPEG_LINUX_URL=${FFMPEG_LINUX_URL:-https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz}
FFMPEG_LINUX_FALLBACK=https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz
FFMPEG_WIN_URL=${FFMPEG_WIN_URL:-https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip}

PYTHON=${PYTHON:-$(command -v python3 || command -v python)}
[ -n "$PYTHON" ] || die "serve Python (3) per gli zip"
say() { printf '%s\n' "$*"; }
die() { printf 'package: %s\n' "$*" >&2; exit 3; }

# La cache è per URL, non per nome: due build diverse di ffmpeg con lo stesso
# nome di file sono già costate un pacchetto da 186 MB che sembrava non cambiare.
fetch() { # url → file in cache, scaricato una volta
  local url=$1 out=$2
  [ -s "$out" ] && [ "$(cat "$out.url" 2>/dev/null)" = "$url" ] && return 0
  say "  scarico $(basename "$out")"
  curl -fsSL --retry 3 -o "$out" "$url"
  printf '%s' "$url" > "$out.url"
}

# 1. l'albero dell'app: lo stesso del tarball, così le due forme non divergono
say "app: costruisco l'albero"
bash scripts/release-tarball.sh >/dev/null
APP="$OUT/Imagine-$VERSION-$TARGET"
rm -rf -- "$APP"
mkdir -p -- "$APP"
tar xzf "$OUT/comfyui-imagine-$VERSION.tar.gz" -C "$APP" --strip-components=1
# Il tarball porta la versione nel nome della cartella: qui il nome è un altro.
rm -f -- "$OUT/comfyui-imagine-$VERSION.tar.gz" "$OUT/comfyui-imagine-$VERSION.tar.gz.sha256" 2>/dev/null || true

# 2. i binari della piattaforma
mkdir -p "$APP/runtime/node" "$APP/runtime/ffmpeg"
case "$TARGET" in
  linux-x64)   NODE_OS=linux-x64;   NODE_EXE=node;       FFMPEG_KIND=linux ;;
  windows-x64) NODE_OS=win-x64;     NODE_EXE=node.exe;   FFMPEG_KIND=win ;;
  macos-arm64) NODE_OS=darwin-arm64; NODE_EXE=node;      FFMPEG_KIND=mac ;;
  macos-x64)   NODE_OS=darwin-x64;  NODE_EXE=node;       FFMPEG_KIND=mac ;;
  *) die "piattaforma sconosciuta: $TARGET" ;;
esac

# Node per Windows si scarica come .zip (e l'exe sta in radice, senza bin/):
# un singolo schema "tar.gz + bin/" qui costa un 404 e nessun pacchetto.
case "$TARGET" in
  windows-*) NODE_EXT=zip ;;
  *) NODE_EXT=tar.gz ;;
esac
NODE_ARCHIVE="$CACHE/node-v$NODE_VERSION-$NODE_OS.$NODE_EXT"
NODE_URL="https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$NODE_OS.$NODE_EXT"
if [ "$FFMPEG_KIND" = mac ]; then
  # evermeet.cx pubblica i binari singoli per macOS.
  fetch "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip" "$CACHE/ffmpeg-mac.zip"
  fetch "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip" "$CACHE/ffprobe-mac.zip"
fi
case "$FFMPEG_KIND" in
  linux)
    fetch "$FFMPEG_LINUX_URL" "$CACHE/ffmpeg-linux.tar.xz"
    # Un archivio si verifica prima di usarlo: `xz -t` costa niente e dice
    # subito se quello che è arrivato è davvero un .tar.xz.
    if ! xz -t "$CACHE/ffmpeg-linux.tar.xz" 2>/dev/null; then
      say "  l'archivio non è valido: ripiego sulla build di BtbN"
      rm -f "$CACHE/ffmpeg-linux.tar.xz" "$CACHE/ffmpeg-linux.tar.xz.url"
      fetch "$FFMPEG_LINUX_FALLBACK" "$CACHE/ffmpeg-linux.tar.xz"
      xz -t "$CACHE/ffmpeg-linux.tar.xz" || die "nemmeno BtbN ha dato un archivio valido"
    fi
    ;;
  win)   fetch "$FFMPEG_WIN_URL"   "$CACHE/ffmpeg-win.zip" ;;
esac

say "runtime: Node $NODE_VERSION ($NODE_OS)"
fetch "$NODE_URL" "$NODE_ARCHIVE"
fetch "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" "$CACHE/SHASUMS256-$NODE_VERSION.txt"
( cd "$CACHE" && grep " node-v$NODE_VERSION-$NODE_OS.$NODE_EXT\$" "SHASUMS256-$NODE_VERSION.txt" | sha256sum -c --quiet - ) \
  || die "l'impronta di Node non combacia: non lo impacchetto"
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
    tar xf "$CACHE/ffmpeg-linux.tar.xz" -C "$CACHE/ffmpeg-linux" --strip-components=1
    # Due impaginazioni in giro: `bin/ffmpeg` (BtbN) e i binari in radice
    # (johnvansickle). Si prende quella che c'è.
    FF_BIN="$CACHE/ffmpeg-linux/bin"; [ -d "$FF_BIN" ] || FF_BIN="$CACHE/ffmpeg-linux"
    cp "$FF_BIN/ffmpeg" "$FF_BIN/ffprobe" "$APP/runtime/ffmpeg/"
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
# La verifica che conta: il binario, su questa macchina, risponde.
if [ "$FFMPEG_KIND" = linux ] || [ "$FFMPEG_KIND" = mac ]; then
  [ "$TARGET" = "$(uname -s | tr 'A-Z' 'a-z')-$(uname -m | sed 's/x86_64/x64/')" ] \
    && { "$APP/runtime/ffmpeg/ffmpeg" -version >/dev/null || die "ffmpeg non parte"; } || true
fi

# 3. il lanciatore: doppio clic, niente domande, browser che si apre da solo
write_linux() {
  cat > "$APP/Imagine.sh" <<'SH'
#!/usr/bin/env bash
# Avvia Imagine: doppio clic (o ./Imagine.sh). Apre il browser quando la pagina risponde.
cd "$(dirname "$0")" || exit 1
export IMAGINE_CONFIG="$PWD/config.yaml"
export IMAGINE_HOME="$PWD/data"
export PATH="$PWD/runtime/node:$PWD/runtime/ffmpeg:$PATH"
PORT=$(node -e "try{const y=require('yaml');console.log(y.parse(require('fs').readFileSync('config.yaml','utf8')).port||3090)}catch{console.log(3090)}" 2>/dev/null || echo 3090)
# Seconda apertura: Imagine è già in esecuzione, si apre solo la pagina. Senza
# questo, il doppio clic due volte finiva in EADDRINUSE con uno stack trace.
if command -v curl >/dev/null && curl -fsS --max-time 2 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  echo "Imagine è già in esecuzione: apro la pagina."
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
  cat > "$APP/Avvia Imagine.bat" <<'BAT'
@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "IMAGINE_CONFIG=%CD%\config.yaml"
set "IMAGINE_HOME=%CD%\data"
set "PATH=%CD%\runtime\node;%CD%\runtime\ffmpeg;%PATH%"
echo.
echo   Imagine: si apre il browser fra pochi secondi.
echo   Lascia questa finestra aperta mentre lo usi; chiudila per fermarlo.
echo.
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:3090).StatusCode|Out-Null; exit 0}catch{exit 1}" >nul 2>&1
if %errorlevel%==0 (
  echo Imagine is already running: opening the page.
  start "" http://127.0.0.1:3090
  exit /b 0
)
start "" cmd /c "timeout /t 4 >nul & start http://127.0.0.1:3090"
"runtime\node\node.exe" dist\server.mjs
echo.
echo   Imagine si e' fermato. Premi un tasto per chiudere.
pause >nul
BAT
  printf 'Imagine %s: doppio clic su "Avvia Imagine.bat".\r\n' "$VERSION" > "$APP/LEGGIMI.txt"
  printf 'ComfyUI deve essere gia avviato (porta 8188). Se non lo e, la pagina lo dice.\r\n' >> "$APP/LEGGIMI.txt"
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

# 4. lo zip
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
say "pacchetto: $ZIP ($(du -h "$ZIP" | cut -f1))"
