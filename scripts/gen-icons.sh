#!/usr/bin/env bash
# Renders the InkUp icon PNGs from the SVG masters in extensions/web/assets (needs rsvg-convert: brew install librsvg).
# 16 and 32 px use icon-small.svg, the same drawing with thicker strokes so it survives at toolbar size. WXT picks up
# public/icon/<size>.png as the manifest's icons and action icon; the Safari converter copies them into the app.
set -euo pipefail
cd "$(dirname "$0")/../extensions/web"
mkdir -p public/icon
for size in 16 32; do rsvg-convert -w "$size" -h "$size" assets/icon-small.svg -o "public/icon/$size.png"; done
for size in 48 96 128; do rsvg-convert -w "$size" -h "$size" assets/icon.svg -o "public/icon/$size.png"; done
echo "wrote $(ls public/icon | tr '\n' ' ')"
