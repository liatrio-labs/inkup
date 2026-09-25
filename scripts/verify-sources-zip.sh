#!/usr/bin/env bash
# Rebuilds the Firefox add-on from the AMO sources zip, as a reviewer would (SOURCE_BUILD.md), and checks the result
# matches the build it was zipped with.
#   bash scripts/verify-sources-zip.sh          # runs `pnpm zip:firefox` first
#   bash scripts/verify-sources-zip.sh --no-zip # uses the zips already in extensions/web/.output
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/extensions/web/.output"
[ "${1:-}" = "--no-zip" ] || (cd "$root" && pnpm zip:firefox >/dev/null)

zips=("$out"/*-sources.zip)
[ "${#zips[@]}" -eq 1 ] && [ -f "${zips[0]}" ] || { echo "expected one *-sources.zip in $out" >&2; exit 1; }
zip="${zips[0]}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
unzip -q "$zip" -d "$work"
files="$(find "$work" -type f | wc -l | tr -d ' ')"
bytes="$(wc -c <"$zip" | tr -d ' ')"
echo "sources zip: $(basename "$zip"), $bytes bytes, $files files"

for name in node_modules .output .git tests test __tests__ fixtures '*.test.ts' '*.test.tsx'; do
  if [ -n "$(find "$work" -name "$name" -print -quit)" ]; then
    echo "FAIL: the sources zip contains $name" >&2
    exit 1
  fi
done
for top in host contract docs; do
  [ ! -e "$work/$top" ] || { echo "FAIL: the sources zip contains $top/" >&2; exit 1; }
done

(cd "$work" && pnpm install --frozen-lockfile >/dev/null && pnpm build:firefox >/dev/null)

built="$work/extensions/web/.output/firefox-mv3"
if ! diff -u "$out/firefox-mv3/manifest.json" "$built/manifest.json"; then
  echo "FAIL: the manifest built from the sources zip differs" >&2
  exit 1
fi
if ! diff -rq "$out/firefox-mv3" "$built"; then
  echo "FAIL: the build from the sources zip differs from the zipped build" >&2
  exit 1
fi
echo "OK: the sources zip rebuilds the same firefox-mv3 ($(find "$built" -type f | wc -l | tr -d ' ') files)"
