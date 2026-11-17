#!/usr/bin/env bash
#
# Imagine's desktop app: the studio in a window, as an AppImage.
#
#   scripts/package-electron.sh              → release/Imagine-<ver>-linux-x64.AppImage
#   scripts/package-electron.sh windows-x64  → the same tree, for the Windows installer
#
# It replaces `scripts/package-appimage.sh`, which shipped a bash launcher with
# `Terminal=true` that copied the app into the user's folder on the first run
# and never updated it. Here the program stays inside the package (read-only)
# and only the data (config, media, projects, plugins) lives in the user's
# folder, so an update is "download the new file".
#
# The program tree is the **portable package's** tree — the same `dist/`, the
# same graphs and language packs, the same static ffmpeg — so the two shapes
# cannot drift apart. Its runtime Node is not used: Electron 45 carries Node
# 24, the version `engines` asks for, and the server runs on that.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=${VERSION:-$(node -p "require('./package.json').version")}
TARGET=${1:-linux-x64}
OUT=${OUT_DIR:-$PWD/release}
BUILD=${BUILD_DIR:-$PWD/build/electron}
say() { printf '%s\n' "$*"; }
die() { printf 'electron: %s\n' "$*" >&2; exit 3; }

case "$TARGET" in
  linux-x64) PLATFORM=linux; ARCH=x64 ;;
  windows-x64) PLATFORM=win; ARCH=x64 ;;
  *) die "unknown platform: $TARGET (linux-x64 | windows-x64)" ;;
esac

# 0. A dist/ older than package.json carries the old version inside (the
#    portable script learned this the hard way): rebuild instead of shipping it.
if [ ! -f dist/server.mjs ] || [ package.json -nt dist/server.mjs ]; then
  say "app: dist/ is missing or older than package.json — rebuilding"
  npm run build >/dev/null
fi

# 1. The program tree. It is the portable package's: built here when a release
#    has not built it already, so this script is usable on its own.
TREE="$OUT/Imagine-$VERSION-$TARGET"
if [ ! -d "$TREE/dist" ] || [ ! -x "$TREE/runtime/ffmpeg/ffmpeg" ]; then
  say "program: building the portable tree ($TARGET)"
  OUT_DIR="$OUT" bash scripts/package-portable.sh "$TARGET" >/dev/null
fi

# The tree a release already built can be stale — the same folder survives from
# a previous packaging, and an AppImage that silently carries the previous
# program is the worst kind of bug to find. The two halves that come from the
# build (`dist/`, the plugin bundles) are therefore always the ones just built.
say "program: staging $BUILD"
rm -rf -- "$BUILD"
mkdir -p "$BUILD/app" "$BUILD/ffmpeg" "$BUILD/pages"
cp -a "$TREE/." "$BUILD/app/"
rm -rf -- "$BUILD/app/dist" "$BUILD/app/plugins"
cp -a dist "$BUILD/app/dist"
cp -a plugins "$BUILD/app/plugins"
# The portable launcher and its runtime are not the app's: the window is the
# launcher here, and Electron is the runtime.
rm -rf -- "$BUILD/app/runtime" "$BUILD/app/Imagine.sh" "$BUILD/app/Imagine.desktop" \
  "$BUILD/app/Start Imagine.bat" "$BUILD/app/README.txt"
cp -a "$TREE/runtime/ffmpeg/." "$BUILD/ffmpeg/"

# 2. The window's own files.
cp electron/main.mjs electron/preload.cjs "$BUILD/"
cp -a electron/pages/. "$BUILD/pages/"
cp web/public/icon-512.png "$BUILD/icon.png"

# 3. The manifest electron-builder reads. The version is the one this script
#    was told (a release hands it the tag's), so an upgrade test is a rebuild
#    with VERSION=… and nothing else.
cat > "$BUILD/package.json" <<MANIFEST
{
  "name": "imagine",
  "productName": "Imagine",
  "version": "$VERSION",
  "description": "A local studio for ComfyUI: chat, images, video and a gallery, in one window.",
  "homepage": "https://github.com/BTekV4/comfyui-imagine",
  "author": "Imagine contributors",
  "license": "MIT",
  "main": "main.mjs"
}
MANIFEST

# 4. electron-builder: the application tree (the asar, `resources/`, the
#    Electron runtime) and nothing else. It can produce an AppImage by itself,
#    but its AppRun starts the binary with no argument when the file itself is
#    double-clicked, and Electron refuses to start without `--no-sandbox` as
#    root and where unprivileged user namespaces are restricted (Ubuntu 24.04).
#    The image is assembled below, with our own AppRun — and compressing once
#    instead of twice is what makes this build survive a machine with 4 GB.
say "pack: electron-builder ($PLATFORM $ARCH)"
rm -rf "$OUT/electron"
# The target (AppImage, nsis) is the configuration's: here only the platform
# and the architecture are said, and `--x64` is not a target.
# `-c.directories.output` because the configuration names `release/electron`
# (relative to the project) and a release may pass another OUT_DIR: with the
# output left to the file, the tree lands where this script does not look.
BUILDER_ARGS=(--config electron-builder.yml --publish never "--$PLATFORM" "--$ARCH" "-c.directories.output=$OUT/electron")
if [ "$PLATFORM" = linux ]; then
  npx --no-install electron-builder "${BUILDER_ARGS[@]}" --dir
else
  npx --no-install electron-builder "${BUILDER_ARGS[@]}"
fi

# 5. The AppImage: an AppDir, the launcher, the desktop entry, one squashfs,
#    and AppImageKit's runtime glued in front (the shape appimagetool produces,
#    without needing appimagetool).
if [ "$PLATFORM" = linux ]; then
  UNPACKED="$OUT/electron/linux-unpacked"
  [ -x "$UNPACKED/imagine" ] || die "electron-builder produced no app tree in $UNPACKED"
  STAGE=$(mktemp -d "${TMPDIR:-/tmp}/imagine-appimage.XXXXXX")
  trap 'rm -rf -- "$STAGE"' EXIT
  APPDIR="$STAGE/AppDir"
  cp -a "$UNPACKED" "$APPDIR"

  cat > "$APPDIR/AppRun" <<'APPRUN'
#!/bin/sh
# AppRun: start Imagine's window.
#
# --no-sandbox always: inside an AppImage the setuid sandbox helper cannot be
# setuid (the image is mounted `nosuid`), and Electron refuses to start without
# the switch as root or where unprivileged user namespaces are restricted. What
# the window loads is the studio on 127.0.0.1 — the only address it may navigate
# to — with no Node in the page and context isolation on.
HERE=$(dirname "$(readlink -f "$0")")
LD_LIBRARY_PATH="$HERE/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export LD_LIBRARY_PATH
exec "$HERE/imagine" --no-sandbox "$@"
APPRUN
  chmod +x "$APPDIR/AppRun"
  cat > "$APPDIR/imagine.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Imagine
Comment=A local studio for ComfyUI
Exec=AppRun --no-sandbox %U
Icon=imagine
Terminal=false
StartupWMClass=Imagine
X-AppImage-Version=$VERSION
Categories=Graphics;
DESK
  install -Dm644 web/public/icon-512.png "$APPDIR/imagine.png"
  cp "$APPDIR/imagine.png" "$APPDIR/.DirIcon"
  install -Dm644 web/public/icon-512.png "$APPDIR/usr/share/icons/hicolor/512x512/apps/imagine.png"
  mkdir -p "$APPDIR/usr/lib"

  # The runtime AppImageKit uses: an ELF, then the squashfs image.
  CACHE=${CACHE_DIR:-${TMPDIR:-/tmp}/imagine-runtime-cache}
  RUNTIME="$CACHE/appimage-runtime-x86_64"
  RUNTIME_URL=${RUNTIME_URL:-https://github.com/AppImage/AppImageKit/releases/download/continuous/runtime-x86_64}
  mkdir -p "$CACHE"
  if [ ! -s "$RUNTIME" ] || ! head -c 4 "$RUNTIME" | grep -q $'\x7fELF'; then
    say "appimage: downloading the runtime"
    curl -fsSL --retry 3 -o "$RUNTIME" "$RUNTIME_URL"
    head -c 4 "$RUNTIME" | grep -q $'\x7fELF' || die "the runtime is not an ELF file"
    chmod +x "$RUNTIME"
  fi
  # xz and not zstd: AppImageKit's runtime reads only xz and zlib. One
  # processor and a small cache: a threaded xz was killed by the OOM killer on
  # a machine with 4 GB of RAM. When even that is killed, gzip is the same
  # image in a bigger file — a build that fails on a small machine is worse
  # than a package 20 % larger.
  if ! mksquashfs "$APPDIR" "$STAGE/image.squashfs" -comp xz -b 128K -noappend \
      -root-owned -processors 1 -mem-percent 5 -quiet; then
    rm -f "$STAGE/image.squashfs"
    printf "%s\n" "electron: xz was killed (out of memory?): compressing with gzip instead" >&2
    mksquashfs "$APPDIR" "$STAGE/image.squashfs" -comp gzip -b 128K -noappend \
      -root-owned -processors 1 -mem-percent 5 -quiet \
      || die "mksquashfs failed (squashfs-tools installed?)"
  fi
  cat "$RUNTIME" "$STAGE/image.squashfs" > "$OUT/electron/Imagine-$VERSION-linux-x64.AppImage"
  chmod +x "$OUT/electron/Imagine-$VERSION-linux-x64.AppImage"
  say "appimage: the launcher that always passes --no-sandbox"
fi

# 6. The artifact and its digest, named the way the release notes say.
case "$TARGET" in
  linux-x64)   BUILT="$OUT/electron/Imagine-$VERSION-linux-x64.AppImage"; WANTED="$OUT/Imagine-$VERSION-$TARGET.AppImage" ;;
  windows-x64) BUILT="$OUT/electron/Imagine-$VERSION-windows-$ARCH.exe";    WANTED="$OUT/Imagine-$VERSION-$TARGET.exe" ;;
esac
[ -f "$BUILT" ] || die "no artifact at $BUILT"
mv -- "$BUILT" "$WANTED"
# electron-builder's leftovers (the unpacked tree, update metadata for a feed
# nobody runs here) are not part of the package.
rm -rf -- "$OUT/electron"
( cd "$OUT" && sha256sum "$(basename "$WANTED")" > "$(basename "$WANTED").sha256" )
say "electron: $WANTED ($(du -h "$WANTED" | cut -f1))"
