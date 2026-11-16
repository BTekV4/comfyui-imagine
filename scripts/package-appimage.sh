#!/usr/bin/env bash
#
# L'AppImage di Imagine: un file solo, doppio clic, icona nel menu.
#
# L'AppImage è montato in sola lettura, quindi l'app non può scrivere accanto a
# sé: al primo avvio si copia in $XDG_DATA_HOME/imagine (~/.local/share/imagine)
# con config.example.yaml, e da lì lavora — config, progetti, plugin, media.
# Il percorso di quei dati si può cambiare con IMAGINE_DATA.
#
#   scripts/package-appimage.sh            → release/Imagine-<ver>-linux-x64.AppImage
#
# Richiede un AppDir già pronto: si parte dallo stesso albero del pacchetto
# portabile (Node e ffmpeg dentro), non da un secondo build.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
OUT=${OUT_DIR:-$PWD/release}
TARGET=${TARGET:-linux-x64}
CACHE=${CACHE_DIR:-${TMPDIR:-/tmp}/imagine-runtime-cache}
PYTHON=${PYTHON:-$(command -v python3 || command -v python)}
APPIMAGETOOL_URL=${APPIMAGETOOL_URL:-https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage}
say() { printf '%s\n' "$*"; }
die() { printf 'appimage: %s\n' "$*" >&2; exit 3; }

# 1. l'albero dell'app: quello del pacchetto portabile, così le due forme non divergono
TREE="$OUT/Imagine-$VERSION-$TARGET"
[ -d "$TREE" ] || bash scripts/package-portable.sh "$TARGET" >/dev/null
[ -d "$TREE/dist" ] || die "manca l'albero in $TREE"

APPDIR="$OUT/Imagine-$VERSION.AppDir"
rm -rf -- "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/applications" "$APPDIR/usr/share/icons/hicolor/512x512/apps"
# L'app intera sotto usr/ (il lanciatore la copia, quindi non si tocca il montaggio).
mkdir -p "$APPDIR/usr/lib/imagine"
cp -a "$TREE/." "$APPDIR/usr/lib/imagine/"

# 2. l'icona e il .desktop
ICON_SRC="$APPDIR/usr/lib/imagine/web/icon-512.png"
[ -f "$ICON_SRC" ] || ICON_SRC="$APPDIR/usr/lib/imagine/web/favicon-512.png"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$APPDIR/imagine.png"
  cp "$ICON_SRC" "$APPDIR/usr/share/icons/hicolor/512x512/apps/imagine.png"
fi
cat > "$APPDIR/imagine.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Imagine
Comment=A local studio for ComfyUI
Exec=imagine
Icon=imagine
Terminal=true
Categories=Graphics;AudioVideo;
DESK
cp "$APPDIR/imagine.desktop" "$APPDIR/usr/share/applications/imagine.desktop"

# 3. AppRun: primo avvio che si copia nei dati dell'utente, poi avvio normale
cat > "$APPDIR/AppRun" <<'APPRUN'
#!/bin/bash
# AppRun: Imagine dentro un AppImage (montato in sola lettura).
HERE=$(dirname "$(readlink -f "$0")")
SRC="$HERE/usr/lib/imagine"
DATA="${IMAGINE_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/imagine}"
mkdir -p "$DATA"
# La prima volta l'app si copia nei dati: da lì può scrivere (config, plugin, media).
if [ ! -d "$DATA/app" ]; then
  echo "Imagine: prima esecuzione, preparo $DATA…"
  mkdir -p "$DATA/app"
  cp -a "$SRC/." "$DATA/app/"
  [ -f "$DATA/app/config.example.yaml" ] && cp "$DATA/app/config.example.yaml" "$DATA/app/config.yaml"
fi
cd "$DATA/app" || exit 1
export IMAGINE_CONFIG="$DATA/app/config.yaml"
export IMAGINE_HOME="$DATA"
export PATH="$DATA/app/runtime/node:$DATA/app/runtime/ffmpeg:$PATH"
# IMAGINE_PORT vince sulla config: serve per una seconda copia accanto a un'altra
# (e per provare il pacchetto senza spostare la config a mano).
if [ -n "${IMAGINE_PORT:-}" ]; then
  "$DATA/app/runtime/node/node" -e "
    const fs = require('fs'), y = require('$DATA/app/node_modules/yaml')
    const f = '$DATA/app/config.yaml'
    const c = y.parse(fs.readFileSync(f, 'utf8'))
    c.port = Number(process.env.IMAGINE_PORT)
    fs.writeFileSync(f, y.stringify(c))
  " >/dev/null 2>&1
fi
# La porta è quella della config (letta col Node del pacchetto, che ha `yaml`):
# un 3090 fisso qui faceva credere «già in esecuzione» a chiunque avesse un'altra
# copia su quella porta.
PORT=$("$DATA/app/runtime/node/node" -e "try{const y=require('$DATA/app/node_modules/yaml');console.log(y.parse(require('fs').readFileSync('$DATA/app/config.yaml','utf8')).port||3090)}catch{console.log(3090)}" 2>/dev/null || echo 3090)
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
exec "$DATA/app/runtime/node/node" dist/server.mjs
APPRUN
chmod +x "$APPDIR/AppRun"
# `imagine` in usr/bin: è quello che il .desktop nomina.
ln -sf ../lib/imagine/../AppRun "$APPDIR/usr/bin/imagine" 2>/dev/null || true
printf '#!/bin/bash\nexec "$APPDIR/AppRun" "$@"\n' > "$APPDIR/usr/bin/imagine"
chmod +x "$APPDIR/usr/bin/imagine"

# 4. l'immagine: runtime AppImage + squashfs, senza appimagetool.
#
# appimagetool è un AppImage a sua volta e senza FUSE non parte (16/11/2026:
# "exec: : Permission denied"). Un AppImage è però solo il runtime ufficiale con
# un'immagine squashfs incollata dietro, e `cat` fa esattamente questo: niente
# dipendenze, niente FUSE, e la stessa forma che produce appimagetool.
RUNTIME_URL=${RUNTIME_URL:-https://github.com/AppImage/AppImageKit/releases/download/continuous/runtime-x86_64}
RUNTIME="$CACHE/appimage-runtime-x86_64"
if [ ! -s "$RUNTIME" ] || ! [ "$(cat "$RUNTIME.url" 2>/dev/null)" = "$RUNTIME_URL" ]; then
  say "  scarico il runtime AppImage"
  curl -fsSL --retry 3 -o "$RUNTIME" "$RUNTIME_URL" || die "runtime non scaricato"
  printf '%s' "$RUNTIME_URL" > "$RUNTIME.url"
  chmod +x "$RUNTIME"
fi
# Il runtime deve essere un ELF: una pagina HTML di errore non è un runtime.
head -c 4 "$RUNTIME" | grep -q $'\x7fELF' || die "il runtime scaricato non è un ELF"

ln -sf imagine.png "$APPDIR/.DirIcon" 2>/dev/null || true
SQUASH="$OUT/Imagine-$VERSION.squashfs"
rm -f "$SQUASH"
say "  squashfs di $(du -sh "$APPDIR" | cut -f1)"
# xz e non zstd: il runtime di AppImageKit sa leggere solo xz e zlib (16/11/2026:
# "Squashfs image uses (null) compression, this version supports only xz, zlib").
mksquashfs "$APPDIR" "$SQUASH" -comp xz -b 128K -noappend -root-owned -quiet \
  || die "mksquashfs ha fallito"
rm -f "$OUT/Imagine-$VERSION-$TARGET.AppImage"
cat "$RUNTIME" "$SQUASH" > "$OUT/Imagine-$VERSION-$TARGET.AppImage"
rm -f "$SQUASH"
chmod +x "$OUT/Imagine-$VERSION-$TARGET.AppImage"
( cd "$OUT" && sha256sum "Imagine-$VERSION-$TARGET.AppImage" > "Imagine-$VERSION-$TARGET.AppImage.sha256" )
say "appimage: $OUT/Imagine-$VERSION-$TARGET.AppImage ($(du -h "$OUT/Imagine-$VERSION-$TARGET.AppImage" | cut -f1))"
