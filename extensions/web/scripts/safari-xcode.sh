#!/usr/bin/env bash
# Regenerates the Safari wrapper app in safari-xcode/ from the Safari build (docs/spikes/safari.md). The Xcode
# project references .output/safari-mv3 in place rather than copying it, so `pnpm build:safari` refreshes what the
# app bundles; rerun this script only when the build gains or loses a top-level file (a new entrypoint).
# The bundle id is a placeholder (the converter derives the app id from --app-name and the extension id from
# --bundle-identifier, so they must agree, case included) and no signing team is set: see docs/manual-checks.md "Safari".
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm build:safari
xcrun safari-web-extension-converter .output/safari-mv3 \
  --project-location safari-xcode \
  --app-name "InkUp" \
  --bundle-identifier com.example.InkUp \
  --swift --macos-only --no-open --no-prompt --force
