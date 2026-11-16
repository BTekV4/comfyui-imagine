#!/usr/bin/env bash
#
# Imagine's AppImage: one file, double-click, icon in the menu.
#
# The AppImage is mounted read-only, so the app cannot write beside itself: on
# the first start it copies itself into $XDG_DATA_HOME/imagine
# (~/.local/share/imagine) with config.example.yaml, and works from there —
# config, projects, plugins, media. That data path can be changed with
# IMAGINE_DATA.
#
#   scripts/package-appimage.sh            → release/Imagine-<ver>-linux-x64.AppImage
#
# It needs an AppDir already built: it starts from the same tree as the
# portable package (Node and ffmpeg inside), not from a second build.
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

# 1. the app tree: the portable package's one, so the two shapes do not diverge
TREE="$OUT/Imagine-$VERSION-$TARGET"
[ -d "$TREE" ] || bash scripts/package-portable.sh "$TARGET" >/dev/null
[ -d "$TREE/dist" ] || die "the tree is missing in $TREE"

APPDIR="$OUT/Imagine-$VERSION.AppDir"
rm -rf -- "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/applications" "$APPDIR/usr/share/icons/hicolor/512x512/apps"
# The whole app under usr/ (the launcher copies it, so the mount is never touched).
mkdir -p "$APPDIR/usr/lib/imagine"
cp -a "$TREE/." "$APPDIR/usr/lib/imagine/"

# 2. the icon and the .desktop file
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

# 3. AppRun: first start copies itself into the user's data, then a normal start
cat > "$APPDIR/AppRun" <<'APPRUN'
#!/bin/bash
# AppRun: Imagine inside an AppImage (mounted read-only).
HERE=$(dirname "$(readlink -f "$0")")
SRC="$HERE/usr/lib/imagine"
DATA="${IMAGINE_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/imagine}"
mkdir -p "$DATA"
# On the first run the app copies itself into the data folder: from there it can write (config, plugins, media).
if [ ! -d "$DATA/app" ]; then
  echo "Imagine: first run, preparing $DATA…"
  mkdir -p "$DATA/app"
  cp -a "$SRC/." "$DATA/app/"
  [ -f "$DATA/app/config.example.yaml" ] && cp "$DATA/app/config.example.yaml" "$DATA/app/config.yaml"
fi
cd "$DATA/app" || exit 1
export IMAGINE_CONFIG="$DATA/app/config.yaml"
export IMAGINE_HOME="$DATA"
export PATH="$DATA/app/runtime/node:$DATA/app/runtime/ffmpeg:$PATH"
# IMAGINE_PORT wins over the config: it is for a second copy beside another one
# (and for trying the package without moving the config by hand).
if [ -n "${IMAGINE_PORT:-}" ]; then
  "$DATA/app/runtime/node/node" -e "
    const fs = require('fs'), y = require('$DATA/app/node_modules/yaml')
    const f = '$DATA/app/config.yaml'
    const c = y.parse(fs.readFileSync(f, 'utf8'))
    c.port = Number(process.env.IMAGINE_PORT)
    fs.writeFileSync(f, y.stringify(c))
  " >/dev/null 2>&1
fi
# The port is the config's one (read with the package's Node, which has `yaml`):
# a fixed 3090 here made anyone with another copy on that port believe Imagine
# was "already running".
PORT=$("$DATA/app/runtime/node/node" -e "try{const y=require('$DATA/app/node_modules/yaml');console.log(y.parse(require('fs').readFileSync('$DATA/app/config.yaml','utf8')).port||3090)}catch{console.log(3090)}" 2>/dev/null || echo 3090)
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
exec "$DATA/app/runtime/node/node" dist/server.mjs
APPRUN
chmod +x "$APPDIR/AppRun"
# `imagine` in usr/bin: it is what the .desktop file names.
ln -sf ../lib/imagine/../AppRun "$APPDIR/usr/bin/imagine" 2>/dev/null || true
printf '#!/bin/bash\nexec "$APPDIR/AppRun" "$@"\n' > "$APPDIR/usr/bin/imagine"
chmod +x "$APPDIR/usr/bin/imagine"

# 4. the image: AppImage runtime + squashfs, without appimagetool.
#
# appimagetool is an AppImage itself and does not start without FUSE
# (2026-11-16: "exec: : Permission denied"). An AppImage is, however, only the
# official runtime with a squashfs image glued behind it, and `cat` does exactly
# that: no dependencies, no FUSE, and the same shape appimagetool produces.
RUNTIME_URL=${RUNTIME_URL:-https://github.com/AppImage/AppImageKit/releases/download/continuous/runtime-x86_64}
RUNTIME="$CACHE/appimage-runtime-x86_64"
if [ ! -s "$RUNTIME" ] || ! [ "$(cat "$RUNTIME.url" 2>/dev/null)" = "$RUNTIME_URL" ]; then
  say "  downloading the AppImage runtime"
  curl -fsSL --retry 3 -o "$RUNTIME" "$RUNTIME_URL" || die "runtime not downloaded"
  printf '%s' "$RUNTIME_URL" > "$RUNTIME.url"
  chmod +x "$RUNTIME"
fi
# The runtime must be an ELF file: an HTML error page is not a runtime.
head -c 4 "$RUNTIME" | grep -q $'\x7fELF' || die "the downloaded runtime is not an ELF"

ln -sf imagine.png "$APPDIR/.DirIcon" 2>/dev/null || true
SQUASH="$OUT/Imagine-$VERSION.squashfs"
rm -f "$SQUASH"
say "  squashfs of $(du -sh "$APPDIR" | cut -f1)"
# xz and not zstd: AppImageKit's runtime can only read xz and zlib (2026-11-16:
# "Squashfs image uses (null) compression, this version supports only xz, zlib").
mksquashfs "$APPDIR" "$SQUASH" -comp xz -b 128K -noappend -root-owned -quiet \
  || die "mksquashfs failed"
rm -f "$OUT/Imagine-$VERSION-$TARGET.AppImage"
cat "$RUNTIME" "$SQUASH" > "$OUT/Imagine-$VERSION-$TARGET.AppImage"
rm -f "$SQUASH"
chmod +x "$OUT/Imagine-$VERSION-$TARGET.AppImage"
( cd "$OUT" && sha256sum "Imagine-$VERSION-$TARGET.AppImage" > "Imagine-$VERSION-$TARGET.AppImage.sha256" )
say "appimage: $OUT/Imagine-$VERSION-$TARGET.AppImage ($(du -h "$OUT/Imagine-$VERSION-$TARGET.AppImage" | cut -f1))"
