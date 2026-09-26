#!/usr/bin/env bash
# Renders the site's favicons from the extension's SVG masters (needs rsvg-convert: brew install librsvg), as
# scripts/gen-icons.sh does for the extension. favicon.svg is icon-small.svg, the heavier strokes that survive at tab
# size; the 32 px PNG is the fallback for browsers without SVG favicons, and apple-touch-icon.png the home-screen icon.
set -euo pipefail
cd "$(dirname "$0")/.."
assets=../../extensions/web/assets
cp "$assets/icon-small.svg" public/favicon.svg
rsvg-convert -w 32 -h 32 "$assets/icon-small.svg" -o public/favicon-32.png
rsvg-convert -w 180 -h 180 "$assets/icon.svg" -o public/apple-touch-icon.png
cp "$assets/icon.svg" src/assets/logo.svg
echo "wrote public/favicon.svg public/favicon-32.png public/apple-touch-icon.png src/assets/logo.svg"
