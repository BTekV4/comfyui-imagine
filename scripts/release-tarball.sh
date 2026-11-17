#!/usr/bin/env bash
#
# Build the tarball a release ships: the studio already built, with the five
# runtime packages, so installing is "unpack and run" and `npm install` never
# happens on the user's machine.
#
#   scripts/release-tarball.sh              → release/comfyui-imagine-<ver>.tar.gz
#   OUT_DIR=/tmp scripts/release-tarball.sh  → somewhere else
#
# What goes in, and why:
#   git archive HEAD      the tracked files of this commit (no .git, no config.yaml)
#   dist/                 server.mjs, the plugin bundles' inputs, the built page
#   plugins/<id>/          the built index.mjs of each plugin (gitignored, so copied)
#   node_modules/         production dependencies only, from package-lock.json
#   install.sh            the first-run script
# What stays out: test/, scripts/, docs/, web/ source (the page is built), the
# development notes .publishignore lists, and anything untracked in the tree.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
VERSION=${VERSION:-$(node -p "require('./package.json').version")}
NAME="comfyui-imagine-$VERSION"
OUT=${OUT_DIR:-$ROOT/release}
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/imagine-release.XXXXXX")
trap 'rm -rf -- "$STAGE"' EXIT
DEST="$STAGE/$NAME"
mkdir -p "$DEST" "$OUT"

# 1. The commit's own files.
git archive --format=tar HEAD | tar -x -C "$DEST"

# 2. What a running studio does not need. The build inputs and this machine's
#    notes are already excluded by .publishignore; here are the rest.
# The source of the two Node bundles is not needed to run them (dist/ is the
# built form), and neither is the build tooling: a tarball that still carried
# server/, shared/ and the tsconfig files invited people to rebuild something
# this archive deliberately already built.
rm -rf -- "$DEST/test" "$DEST/scripts" "$DEST/.github" "$DEST/docs" "$DEST/web" \
  "$DEST/server" "$DEST/shared" "$DEST/mcp" "$DEST/tsconfig.json" "$DEST/tsconfig.web.json" \
  "$DEST/tsconfig.test.json" "$DEST/Dockerfile" "$DEST/docker-compose.yml" "$DEST/.dockerignore" \
  "$DEST/AGENTS.md" "$DEST/CLAUDE.md" "$DEST/CONTRIBUTING.md" "$DEST/.publishignore"
if [ -f .publishignore ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%%#*}
    line=$(printf '%s' "$line" | sed 's/[[:space:]]*$//')
    [ -z "$line" ] && continue
    case "$line" in
      /*|*..*) echo "release: ignored the invalid line \"$line\" in .publishignore" >&2; continue ;;
    esac
    rm -rf -- "${DEST:?}/${line%/}"
  done < .publishignore
fi

# 3. The built halves. `dist` is gitignored; the plugin bundles too (except the
#    hand-written telegram one), so both are copied from the tree that was just
#    built. A plugin's src/ is not needed to run it.
[ -f dist/server.mjs ] || { echo "release: dist/server.mjs is missing: run npm run build first" >&2; exit 3; }
rm -rf -- "$DEST/dist" "$DEST/plugins"
cp -a dist "$DEST/dist"
cp -a plugins "$DEST/plugins"
rm -rf -- "$DEST"/plugins/*/src

# 4. The runtime packages, exactly as the lockfile pins them.
( cd "$DEST" && npm ci --omit=dev --no-audit --no-fund >/dev/null )
# The lockfile is not needed once the tree is installed; the manifest is (the
# server reads its version for the first-run card).
rm -f -- "$DEST/package-lock.json"
# Source maps are for the person holding the repository, not for the person
# running the studio: nothing at runtime opens a .map, the code is public
# anyway, and they were 10.8 MB of a 28 MB tree (2.8 MB compressed, 29% of the
# archive). They stay in the repository, produced by `npm run build`; the
# portable package carries this same tree, and the desktop packages stage their
# `dist` from the build and drop their own copy the same way
# (`scripts/package-electron.sh`).
# After step 4, so the dependencies' own maps go too: five files of immer were
# the last ones a release still carried.
find "$DEST" -type f -name '*.map' -delete

# 5. The files a release adds beside the commit: the installer, which may be
#    newer than HEAD while it is being written. Docker is the repo's own way in
#    (it builds from source), so it is not in the prebuilt tarball.
for extra in install.sh; do
  [ -e "$ROOT/$extra" ] && cp -a "$ROOT/$extra" "$DEST/$extra"
done

# 6. The archive and its digest.
tar -czf "$OUT/$NAME.tar.gz" -C "$STAGE" "$NAME"
( cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )
echo "release: $OUT/$NAME.tar.gz"
echo "release: $(du -h "$OUT/$NAME.tar.gz" | cut -f1)  $(cat "$OUT/$NAME.tar.gz.sha256")"
