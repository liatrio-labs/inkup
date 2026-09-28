#!/usr/bin/env bash
# The inkup CLI the macOS desktop app bundles at InkUp.app/Contents/MacOS/inkup (ADR 0025), for a build that passes
# `--config src-tauri/tauri.cli.conf.json` to `tauri build` or `tauri dev`. Tauri's externalBin takes the file with a
# target-triple suffix: apps/desktop/src-tauri/binaries/inkup-<triple>. A universal build needs one per architecture
# (each architecture's cargo build checks for its own) and the lipo'd inkup-universal-apple-darwin, which is the one
# the bundle gets.
#
#   scripts/desktop-cli.sh                         # this machine's architecture, a debug build
#   scripts/desktop-cli.sh --release --universal   # what desktop-macos.yml bundles
#
# It builds into host/target, this checkout's own.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/apps/desktop/src-tauri/binaries"
profile=debug
universal=false
for arg in "$@"; do
  case "$arg" in
    --release) profile=release ;;
    --universal) universal=true ;;
    *) echo "usage: $0 [--release] [--universal]" >&2; exit 2 ;;
  esac
done
[ "$(uname -s)" = Darwin ] || { echo "the app bundles the CLI on macOS only" >&2; exit 2; }
# host/rust-toolchain.toml picks the toolchain, from the directory cargo runs in.
cd "$ROOT/host"

flags=(--locked -p inkup)
[ "$profile" = release ] && flags+=(--release)
if $universal; then
  targets=(aarch64-apple-darwin x86_64-apple-darwin)
else
  targets=("$(rustc --print host-tuple)")
fi

mkdir -p "$OUT"
for target in "${targets[@]}"; do
  cargo build --target "$target" "${flags[@]}"
  cp "$ROOT/host/target/$target/$profile/inkup" "$OUT/inkup-$target"
done
if $universal; then
  lipo -create -output "$OUT/inkup-universal-apple-darwin" "${targets[@]/#/$OUT/inkup-}"
  lipo -info "$OUT/inkup-universal-apple-darwin"
fi
ls -l "$OUT"
