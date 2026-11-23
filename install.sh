#!/usr/bin/env bash
# Install every mod in this repository into a Herdr app home.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

if [ ! -d "$home" ]; then
  echo "Herdr app home not found: $home" >&2
  echo "Start Herdr once, or set HERDR_APP_HOME, and try again." >&2
  exit 1
fi

command -v rsync >/dev/null 2>&1 || {
  echo "rsync is required to install." >&2
  exit 1
}
command -v sqlite3 >/dev/null 2>&1 || \
  echo "warning: sqlite3 not found; the no-mistakes mod needs it to read its state." >&2

dest="$home/mods"
mkdir -p "$dest"

shopt -s nullglob
mods=("$root"/*/mods/*/)
if [ ${#mods[@]} -eq 0 ]; then
  echo "No mods found under $root." >&2
  exit 1
fi

for src in "${mods[@]}"; do
  name="$(basename "$src")"
  # Keep the files Herdr generates in a mod folder; everything else is ours.
  rsync -a --delete \
    --exclude=gpui-kit.d.ts --exclude=jsconfig.json --exclude='*.error' \
    "$src" "$dest/$name/"
  echo "installed $name -> $dest/$name"
  if command -v herdr-app >/dev/null 2>&1; then
    herdr-app check "$dest/$name"
  fi
done

echo
echo "Open a mod with:  herdr-app do mod.open --name <mod>"
