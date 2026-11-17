#!/usr/bin/env bash
#
# The publish job's gate: a release carries the packages and their digests,
# nothing else.
#
#   scripts/check-release-assets.sh dist-artifacts
#
# v0.3.0 went out with the Windows check's own files attached — imagine.log,
# selftest-*.json, window-*.png — because the publish job downloaded every
# artifact of the run and then attached `dist-artifacts/**`. This refuses a
# list like that before anything is written: one unexpected file fails the job
# and its name is in the log. A package without its `.sha256`, and a `.sha256`
# without its file, are refused the same way.
set -euo pipefail

dir=${1:?the directory holding the downloaded artifacts is required}
[ -d "$dir" ] || { echo "check-release-assets: $dir is not a directory" >&2; exit 3; }

# What a release attaches: the tarball (servers and macOS) and the three
# desktop/portable packages for 64-bit Linux and Windows, each with the
# .sha256 that verifies it.
allowed=(
  '^comfyui-imagine-[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz(\.sha256)?$'
  '^Imagine-[0-9]+\.[0-9]+\.[0-9]+-linux-x64\.zip(\.sha256)?$'
  '^Imagine-[0-9]+\.[0-9]+\.[0-9]+-linux-x64\.AppImage(\.sha256)?$'
  '^Imagine-[0-9]+\.[0-9]+\.[0-9]+-windows-x64-setup\.exe(\.sha256)?$'
)
packages=(
  '^comfyui-imagine-[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz$'
  '^Imagine-[0-9]+\.[0-9]+\.[0-9]+-linux-x64\.zip$'
  '^Imagine-[0-9]+\.[0-9]+\.[0-9]+-linux-x64\.AppImage$'
  '^Imagine-[0-9]+\.[0-9]+\.[0-9]+-windows-x64-setup\.exe$'
)

shopt -s nullglob
files=("$dir"/*)
if [ "${#files[@]}" -eq 0 ]; then
  echo "check-release-assets: no files in $dir" >&2
  exit 1
fi

status=0
names=()
for path in "${files[@]}"; do
  name=${path##*/}
  names+=("$name")
  known=0
  for pattern in "${allowed[@]}"; do
    if [[ $name =~ $pattern ]]; then known=1; break; fi
  done
  if [ "$known" -eq 0 ]; then
    echo "check-release-assets: not a release package: $name" >&2
    status=1
  fi
done

# A package without its digest is a download nobody can verify.
for pattern in "${packages[@]}"; do
  found=
  for name in "${names[@]}"; do
    if [[ $name =~ $pattern ]]; then found=$name; break; fi
  done
  if [ -z "$found" ]; then
    echo "check-release-assets: missing package: ${pattern#^}" >&2
    status=1
  elif [ ! -f "$dir/$found.sha256" ]; then
    echo "check-release-assets: $found has no $found.sha256 beside it" >&2
    status=1
  fi
done

# A digest with no file beside it is as wrong.
for name in "${names[@]}"; do
  case "$name" in
    *.sha256)
      if [ ! -f "$dir/${name%.sha256}" ]; then
        echo "check-release-assets: $name has no file beside it" >&2
        status=1
      fi
      ;;
  esac
done

if [ "$status" -ne 0 ]; then
  echo "check-release-assets: refusing to publish this list" >&2
  exit 1
fi

echo "check-release-assets: ${#names[@]} files, exactly the packages and their digests:"
printf '  %s\n' "${names[@]}" | sort
