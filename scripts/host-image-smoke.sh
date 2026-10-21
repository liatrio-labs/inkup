#!/usr/bin/env bash
# Builds the Host image and checks a Remote Host container. From the repo root: pnpm host:image:smoke
#
# The build uses the Docker daemon's own architecture (`docker build --platform linux/$native`).
# On an arm64 Linux host, including the GitHub-hosted ubuntu-24.04-arm runner, that is linux/arm64
# compiled in the arm64 build stage. This script does not request a second architecture, so it does
# not emulate. A foreign DOCKER_DEFAULT_PLATFORM is overridden by the explicit native platform.
#
# Not part of CI yet (#119).
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

rust=$(sed -n 's/^channel = "\(.*\)"$/\1/p' host/rust-toolchain.toml)
if [ -z "$rust" ]; then
  echo "host-image-smoke: could not read the Rust version from host/rust-toolchain.toml" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "host-image-smoke: docker is not installed" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "host-image-smoke: curl is not installed" >&2
  exit 1
fi

norm_arch() {
  case $1 in
    aarch64 | arm64) printf '%s\n' arm64 ;;
    x86_64 | amd64) printf '%s\n' amd64 ;;
    *)
      echo "host-image-smoke: unsupported architecture: $1" >&2
      return 1
      ;;
  esac
}

daemon=$(docker info --format '{{.Architecture}}')
native=$(norm_arch "$daemon")
host_arch=$(norm_arch "$(uname -m)")
if [ "$native" != "$host_arch" ]; then
  echo "host-image-smoke: docker daemon is $native but this machine is $host_arch; refusing to build off-machine." >&2
  exit 1
fi

export DOCKER_BUILDKIT=1
image=inkup-host
echo "host-image-smoke: building $image natively for linux/$native (Rust $rust, uname $(uname -m))"
docker build --platform "linux/$native" --build-arg "RUST_VERSION=$rust" -f docker/host.Dockerfile -t "$image" .

built=$(docker image inspect "$image" --format '{{.Architecture}}')
built_norm=$(norm_arch "$built")
if [ "$built_norm" != "$native" ]; then
  echo "host-image-smoke: image architecture is $built, daemon is $native" >&2
  exit 1
fi
echo "host-image-smoke: image architecture $built"

user=$(docker image inspect "$image" --format '{{.Config.User}}')
[ "$user" = "65532:65532" ]
echo "host-image-smoke: image user $user"

docker image inspect "$image" --format '{{json .Config.ExposedPorts}}' | grep -q '47823/tcp'
docker image inspect "$image" --format '{{json .Config.Volumes}}' | grep -q '/data'
docker image inspect "$image" --format '{{json .Config.Env}}' | grep -q 'INKUP_DATA_DIR=/data'
docker image inspect "$image" --format '{{json .Config.Env}}' | grep -q 'INKUP_NO_UPDATE_CHECK=1'
docker image inspect "$image" --format '{{json .Config.Entrypoint}}' | grep -q 'inkup-host'
docker image inspect "$image" --format '{{json .Config.Healthcheck.Test}}' | grep -q 'status'
echo "host-image-smoke: expose 47823, volume /data, update check off, healthcheck is inkup status"

# Without a public URL the Host exits 1. The image does not invent one.
set +e
no_url=$(docker run --rm --platform "linux/$native" "$image" 2>&1)
no_url_code=$?
set -e
if [ "$no_url_code" -ne 1 ]; then
  echo "host-image-smoke: missing public URL exited $no_url_code" >&2
  printf '%s\n' "$no_url" >&2
  exit 1
fi
case $no_url in
  *"https public URL"*) echo "host-image-smoke: no public URL exits 1 with the Host's message" ;;
  *)
    echo "host-image-smoke: missing public URL did not say why" >&2
    printf '%s\n' "$no_url" >&2
    exit 1
    ;;
esac
case $no_url in
  *"pull a new image"*) ;;
  *)
    echo "host-image-smoke: the update banner was not printed" >&2
    exit 1
    ;;
esac

name=
again=
vol=
cleanup() {
  status=$?
  if [ -n "$name" ]; then
    docker rm -f "$name" >/dev/null 2>&1 || true
  fi
  if [ -n "$again" ]; then
    docker rm -f "$again" >/dev/null 2>&1 || true
  fi
  if [ -n "$vol" ]; then
    docker volume rm -f "$vol" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

name=inkup-host-smoke-$$
again=${name}-again
vol=inkup-host-smoke-$$
public_url=https://inkup.example.com
docker volume create "$vol" >/dev/null
docker run -d --name "$name" --platform "linux/$native" \
  -e "INKUP_PUBLIC_URL=$public_url" \
  -p 127.0.0.1::47823 \
  -v "$vol:/data" \
  "$image" >/dev/null

# The process listens on 47823. The published port may differ, and the Host admits 127.0.0.1 only
# with its own port, so the Host header stays 127.0.0.1:47823.
port=$(docker port "$name" 47823/tcp | awk -F: '/127\.0\.0\.1/ {print $2; exit}')
if [ -z "$port" ]; then
  echo "host-image-smoke: no published port" >&2
  docker logs "$name" >&2 || true
  exit 1
fi

ready=0
for _ in $(seq 1 60); do
  running=$(docker inspect -f '{{.State.Running}}' "$name")
  if [ "$running" != "true" ]; then
    echo "host-image-smoke: container exited before /health" >&2
    docker logs "$name" >&2 || true
    exit 1
  fi
  if curl --ipv4 --silent --show-error --fail --max-time 2 --output /dev/null \
    -H "Host: 127.0.0.1:47823" "http://127.0.0.1:${port}/health"; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "host-image-smoke: /health did not answer" >&2
  docker logs "$name" >&2 || true
  exit 1
fi

health=$(curl --ipv4 --silent --show-error --fail --max-time 5 \
  -H "Host: 127.0.0.1:47823" "http://127.0.0.1:${port}/health")
case $health in
  *'"name"'*) ;;
  *)
    echo "host-image-smoke: /health was not the Host document: $health" >&2
    exit 1
    ;;
esac
case $health in
  *hub_name*)
    echo "host-image-smoke: a Remote Host published hub_name: $health" >&2
    exit 1
    ;;
esac
curl --ipv4 --silent --show-error --fail --max-time 5 --output /dev/null \
  -H "Host: inkup.example.com" "http://127.0.0.1:${port}/health"
echo "host-image-smoke: /health 200 (loopback and the placeholder public host), no hub_name"

uid=$(docker exec "$name" id -u)
if [ "$uid" != "65532" ]; then
  echo "host-image-smoke: container uid is $uid" >&2
  exit 1
fi
echo "host-image-smoke: running as uid $uid"

check=$(docker exec "$name" printenv INKUP_NO_UPDATE_CHECK)
if [ "$check" != "1" ]; then
  echo "host-image-smoke: INKUP_NO_UPDATE_CHECK is '${check}'" >&2
  exit 1
fi
docker exec "$name" inkup status >/dev/null
echo "host-image-smoke: inkup status ok, update check off"

init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
mcp_code() {
  curl --ipv4 --silent --show-error --max-time 20 --output /dev/null --write-out '%{http_code}' \
    -H "Host: 127.0.0.1:47823" \
    -H "Accept: application/json, text/event-stream" \
    -H "Content-Type: application/json" \
    "$@" "http://127.0.0.1:${port}/mcp" || true
}
missing=$(mcp_code --data "$init")
if [ "$missing" != "401" ]; then
  echo "host-image-smoke: /mcp without a token returned $missing" >&2
  exit 1
fi
echo "host-image-smoke: /mcp 401 without a token"

token=$(docker exec "$name" inkup token create --name smoke)
token=$(printf '%s' "$token" | tr -d '[:space:]')
if [ -z "$token" ]; then
  echo "host-image-smoke: token create printed nothing" >&2
  exit 1
fi
authed=$(mcp_code --data "$init" -H "Authorization: Bearer ${token}")
unset token
if [ "$authed" != "200" ]; then
  echo "host-image-smoke: /mcp with an agent token returned $authed" >&2
  exit 1
fi
echo "host-image-smoke: /mcp 200 with an agent token"

logs=$(docker logs "$name" 2>&1)
case $logs in
  *"pull a new image"*) ;;
  *)
    echo "host-image-smoke: logs do not say to pull a new image" >&2
    exit 1
    ;;
esac
case $logs in
  *"inkup pairing"*) echo "host-image-smoke: serve's stderr is in the container logs" ;;
  *)
    echo "host-image-smoke: serve's banner is not in the container logs" >&2
    exit 1
    ;;
esac

set +e
second=$(docker run --rm --platform "linux/$native" \
  -e "INKUP_PUBLIC_URL=$public_url" \
  -v "$vol:/data" \
  "$image" 2>&1)
second_code=$?
set -e
if [ "$second_code" -ne 1 ]; then
  echo "host-image-smoke: a second container on the volume exited $second_code" >&2
  printf '%s\n' "$second" >&2
  exit 1
fi
case $second in
  *"already running"*) echo "host-image-smoke: a second container on the volume exits 1" ;;
  *)
    echo "host-image-smoke: the second container did not say the data dir is taken" >&2
    printf '%s\n' "$second" >&2
    exit 1
    ;;
esac

docker stop --time 20 "$name" >/dev/null
stopped=$(docker inspect -f '{{.State.ExitCode}}' "$name")
if [ "$stopped" != "0" ]; then
  echo "host-image-smoke: docker stop left exit code $stopped" >&2
  docker logs "$name" >&2 || true
  exit 1
fi
echo "host-image-smoke: docker stop exit 0"

docker run --rm --platform "linux/$native" --entrypoint sh -v "$vol:/data" "$image" \
  -c 'test ! -e /data/host.json'
echo "host-image-smoke: host.json removed"

# The lock file may remain; the lock itself must be free, or this start would exit 1.
docker run -d --name "$again" --platform "linux/$native" \
  -e "INKUP_PUBLIC_URL=$public_url" \
  -p 127.0.0.1::47823 \
  -v "$vol:/data" \
  "$image" >/dev/null
again_port=$(docker port "$again" 47823/tcp | awk -F: '/127\.0\.0\.1/ {print $2; exit}')
again_ready=0
for _ in $(seq 1 60); do
  running=$(docker inspect -f '{{.State.Running}}' "$again")
  if [ "$running" != "true" ]; then
    echo "host-image-smoke: the data dir was still locked after stop" >&2
    docker logs "$again" >&2 || true
    exit 1
  fi
  if curl --ipv4 --silent --show-error --fail --max-time 2 --output /dev/null \
    -H "Host: 127.0.0.1:47823" "http://127.0.0.1:${again_port}/health"; then
    again_ready=1
    break
  fi
  sleep 0.5
done
if [ "$again_ready" -ne 1 ]; then
  echo "host-image-smoke: the restarted Host did not answer /health" >&2
  docker logs "$again" >&2 || true
  exit 1
fi
docker stop --time 20 "$again" >/dev/null
echo "host-image-smoke: host.lock released (a new container reached /health)"
echo "host-image-smoke: ok (linux/$native)"
