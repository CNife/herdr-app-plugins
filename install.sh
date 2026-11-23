#!/usr/bin/env bash
# Install every mod in this repository into a Herdr app home.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
dest="$home/mods"
marker=".herdr-plugins-install"

if [ ! -d "$dest" ]; then
  echo "$home is not a Herdr app home (no mods folder)." >&2
  echo "Start Herdr once, or set HERDR_APP_HOME to its home, and try again." >&2
  exit 1
fi

command -v rsync >/dev/null 2>&1 || {
  echo "rsync is required to install." >&2
  exit 1
}
command -v sqlite3 >/dev/null 2>&1 || \
  echo "warning: sqlite3 not found; the no-mistakes mod needs it to read its state." >&2

shopt -s nullglob
mods=("$root"/*/mods/*/)
if [ ${#mods[@]} -eq 0 ]; then
  echo "No mods found under $root." >&2
  exit 1
fi

for src in "${mods[@]}"; do
  name="$(basename "$src")"
  target="$dest/$name"
  # A folder this repository installed is ours to replace. Any other folder
  # with the same name is not: stop before deleting something we didn't make.
  if [ -e "$target" ] && [ ! -f "$target/$marker" ] \
      && ! diff -r -q -x gpui-kit.d.ts -x jsconfig.json -x '*.error' "$src" "$target" >/dev/null 2>&1 \
      && [ "${FORCE:-0}" != "1" ]; then
    echo "mods/$name already exists and was not installed from this checkout." >&2
    echo "Move it aside, or run again with FORCE=1 to replace it." >&2
    exit 1
  fi
  # Keep the files Herdr generates in a mod folder; everything else is ours.
  rsync -a --delete \
    --exclude=gpui-kit.d.ts --exclude=jsconfig.json --exclude='*.error' --exclude="$marker" \
    "$src" "$target/"
  printf '%s\n' "$root" > "$target/$marker"
  echo "installed $name -> $target"
done

if command -v herdr-app >/dev/null 2>&1; then
  failed=0
  for src in "${mods[@]}"; do
    name="$(basename "$src")"
    if ! herdr-app check "$dest/$name"; then
      echo "check failed for $name; it is installed but will not load." >&2
      failed=1
    fi
  done
  [ "$failed" -eq 0 ] || exit 1
else
  echo "warning: herdr-app not found on PATH; skipped the mod checks." >&2
fi

echo
echo "Open a mod with:  herdr-app do mod.open --name <mod>"
