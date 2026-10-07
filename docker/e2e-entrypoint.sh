#!/usr/bin/env bash
# Runs inside the e2e image (docker/e2e.Dockerfile), started by scripts/e2e-docker.sh: e2e-entrypoint chrome|firefox
# [playwright args...]. As root it hands the cache volumes to the caller's UID, then drops to that UID for the rest,
# so what lands in the worktree (test-results, playwright-report) belongs to the caller.
set -euo pipefail

if [ "$(id -u)" = 0 ]; then
  : "${HOST_UID:?}" "${HOST_GID:?}"
  # A fresh named volume is root's. Only the top level: everything below it the caller writes.
  for dir in /cache/* /repo/node_modules /repo/*/*/node_modules /repo/extensions/web/.output /repo/extensions/web/.wxt; do
    [ -d "$dir" ] && [ "$(stat -c %u "$dir")" != "$HOST_UID" ] && chown "$HOST_UID:$HOST_GID" "$dir"
  done
  mkdir -p /tmp/home && chown "$HOST_UID:$HOST_GID" /tmp/home
  exec setpriv --reuid="$HOST_UID" --regid="$HOST_GID" --clear-groups -- "$0" "$@"
fi

browser=$1
shift
export HOME=/tmp/home XDG_RUNTIME_DIR=/tmp/home/run
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
cd /repo

# CI=1 for the install only: it makes `prepare` skip the git hooks (scripts/install-hooks.mjs). Playwright reads CI
# too (one worker), so it stays unset for the run.
CI=1 pnpm install --frozen-lockfile --config.confirm-modules-purge=false

# Two workers unless the caller picks: the machine is shared.
workers=(--workers=2)
for arg in "$@"; do
  case $arg in --workers | --workers=* | -j | -j*) workers=() ;; esac
done

case $browser in
  chrome)
    exec pnpm test:e2e "${workers[@]}" "$@"
    ;;
  firefox)
    # What the Firefox CI job adds (.github/workflows/ci.yml): the host, a sound server with a null sink, and a display.
    pnpm host:build
    pulseaudio --start --exit-idle-time=-1
    pactl load-module module-null-sink sink_name=null > /dev/null
    pactl set-default-sink null
    HEADED=1 exec xvfb-run -a pnpm test:e2e:firefox "${workers[@]}" "$@"
    ;;
  *)
    echo "e2e-entrypoint: unknown browser '$browser' (chrome or firefox)" >&2
    exit 2
    ;;
esac
