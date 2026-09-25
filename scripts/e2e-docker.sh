#!/usr/bin/env bash
# Runs the e2e suites in Linux Docker: bash scripts/e2e-docker.sh chrome|firefox [playwright args...], or
# `pnpm test:e2e:docker` and `pnpm test:e2e:firefox:docker`. On macOS, Chromium's tab and screen capture asks the OS
# for screen recording (a prompt charged to the terminal) and network-host.spec.ts needs local-network access; Linux
# has neither, and it is what CI runs. The raw `pnpm test:e2e` and `pnpm test:e2e:firefox` are what the container,
# and CI, run.
#
# The worktree is mounted at /repo. Everything built for Linux goes to named volumes, never into the Mac's copies:
#   inkup-e2e-<worktree>-*   this worktree's node_modules (root and each package), extensions/web/.output and .wxt,
#                            and the host build (CARGO_TARGET_DIR), so the Mac's host/target is never touched
#   inkup-e2e-cargo-home     the cargo registry, shared by every worktree
#   inkup-e2e-pnpm-store     the pnpm store, shared by every worktree
# `.output` is a volume too: the Mac's copy is the unpacked extension a person loads into Chrome, and it stays theirs.
# `.git` is mounted read-only, so nothing in the container can write to the shared repository.
# Clear this worktree's volumes: docker volume rm $(docker volume ls -q --filter name=inkup-e2e-<worktree>-)
set -euo pipefail

browser=${1:-}
case $browser in
  chrome | firefox) shift ;;
  *)
    echo "usage: $0 chrome|firefox [playwright args...]" >&2
    exit 2
    ;;
esac
# `pnpm test:e2e:docker -- <args>` passes the `--` on.
[ "${1:-}" = -- ] && shift

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

# Versions from where CI and the repo pin them.
playwright=$(sed -n "s/^  '@playwright\/test@\([0-9.]*\)':$/\1/p" pnpm-lock.yaml | head -1)
node=$(sed -n 's/^  NODE_VERSION: "\(.*\)"$/\1/p' .github/workflows/ci.yml)
pnpm=$(sed -n 's/^  PNPM_VERSION: "\(.*\)"$/\1/p' .github/workflows/ci.yml)
rust=$(sed -n 's/^channel = "\(.*\)"$/\1/p' host/rust-toolchain.toml)
for v in playwright node pnpm rust; do
  [ -n "${!v}" ] || {
    echo "e2e-docker: could not read the $v version" >&2
    exit 1
  }
done

# The image is tagged by what goes into it, so a change to the Dockerfile, the entrypoint or a version rebuilds it.
tag=$(cat docker/e2e.Dockerfile docker/e2e-entrypoint.sh <(echo "$playwright $node $pnpm $rust") | shasum | cut -c1-12)
image=inkup-e2e:$tag
if ! docker image inspect "$image" > /dev/null 2>&1; then
  echo "e2e-docker: building $image (Playwright $playwright, Node $node, pnpm $pnpm, Rust $rust)"
  docker build -f docker/e2e.Dockerfile -t "$image" \
    --build-arg PLAYWRIGHT_VERSION="$playwright" --build-arg NODE_VERSION="$node" \
    --build-arg PNPM_VERSION="$pnpm" --build-arg RUST_VERSION="$rust" docker
fi

# One set of volumes per worktree: its name, and a hash of its path so two checkouts with one name don't collide.
key=$(basename "$root" | tr -c 'a-zA-Z0-9_.\n-' - | tr 'A-Z' 'a-z')-$(printf %s "$root" | shasum | cut -c1-8)
vol=inkup-e2e-$key
mounts=(
  -v "$root:/repo"
  -v "$root/.git:/repo/.git:ro"
  -v "$vol-target:/cache/target"
  -v inkup-e2e-cargo-home:/cache/cargo
  -v inkup-e2e-pnpm-store:/cache/pnpm-store
  -v "$vol-output:/repo/extensions/web/.output"
  -v "$vol-wxt:/repo/extensions/web/.wxt"
  -v "$vol-nm:/repo/node_modules"
)
for pkg in packages/* extensions/*; do
  [ -f "$pkg/package.json" ] && mounts+=(-v "$vol-nm-$(basename "$pkg"):/repo/$pkg/node_modules")
done

tty=()
[ -t 0 ] && [ -t 1 ] && tty=(-t)

exec docker run --rm -i "${tty[@]}" --init --ipc=host \
  "${mounts[@]}" \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -e CARGO_HOME=/cache/cargo -e CARGO_TARGET_DIR=/cache/target \
  -e npm_config_store_dir=/cache/pnpm-store \
  -e FORCE_COLOR \
  "$image" "$browser" "$@"
