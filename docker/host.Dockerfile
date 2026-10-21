# syntax=docker/dockerfile:1

# A Remote Host image (ADR 0030, #114). Build from the repo root:
#   docker build -f docker/host.Dockerfile -t inkup-host .
# That builds for the machine's own architecture. On an arm64 host (the GitHub-hosted
# ubuntu-24.04-arm runner, for example) the result is linux/arm64 with no emulation.
# scripts/host-image-smoke.sh passes --platform of the Docker daemon's architecture and
# --build-arg RUST_VERSION from host/rust-toolchain.toml.

# debian:bookworm-slim manifest list (linux/amd64, linux/arm64, and the other published
# architectures). Docker selects the platform it is building, so this pin is not an amd64-only image.
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8

# Default matches host/rust-toolchain.toml. The build refuses a value that disagrees with the file.
ARG RUST_VERSION=1.98

FROM rust:${RUST_VERSION}-bookworm AS build
ARG RUST_VERSION
WORKDIR /src
COPY host /src/host
RUN set -eu; \
  expected=$(sed -n 's/^channel = "\(.*\)"$/\1/p' /src/host/rust-toolchain.toml); \
  if [ -z "${expected}" ] || [ "${RUST_VERSION}" != "${expected}" ]; then \
    echo "RUST_VERSION (${RUST_VERSION}) does not match host/rust-toolchain.toml (${expected})." >&2; \
    echo "Pass --build-arg RUST_VERSION from that file. scripts/host-image-smoke.sh does." >&2; \
    exit 1; \
  fi; \
  rm /src/host/rust-toolchain.toml; \
  cargo build --locked --profile dist --manifest-path /src/host/Cargo.toml -p inkup; \
  mkdir -p /out; \
  cp /src/host/target/dist/inkup /out/inkup; \
  strip /out/inkup

FROM ${DEBIAN_IMAGE}

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 65532 inkup \
  && useradd --uid 65532 --gid 65532 --home-dir /tmp --no-create-home --shell /usr/sbin/nologin inkup \
  && mkdir -p /data \
  && chown 65532:65532 /data

COPY --from=build --chmod=755 /out/inkup /usr/local/bin/inkup

# Maps INKUP_PUBLIC_URL to --public-url. The binary does not read that variable.
# INKUP_TLS_CERT and INKUP_TLS_KEY map to --tls-cert and --tls-key when both are
# set, and the Host serves HTTPS itself (ADR 0030). Unset, TLS stays at the proxy.
# exec leaves inkup as PID 1, so SIGTERM from `docker stop` reaches serve.
COPY --chmod=755 <<'EOF' /usr/local/bin/inkup-host
#!/bin/sh
set -eu

echo "Updates: pull a new image. inkup update cannot replace this image." >&2

has_flag() {
  want=$1
  shift
  for arg in "$@"; do
    if [ "$arg" = "$want" ]; then
      return 0
    fi
  done
  return 1
}

set -- serve --remote "$@"

if ! has_flag --public-url "$@"; then
  if [ -n "${INKUP_PUBLIC_URL:-}" ]; then
    set -- "$@" --public-url "${INKUP_PUBLIC_URL}"
  fi
fi

if ! has_flag --tls-cert "$@" && ! has_flag --tls-key "$@"; then
  if [ -n "${INKUP_TLS_CERT:-}" ] || [ -n "${INKUP_TLS_KEY:-}" ]; then
    if [ -z "${INKUP_TLS_CERT:-}" ] || [ -z "${INKUP_TLS_KEY:-}" ]; then
      echo "inkup-host: set both INKUP_TLS_CERT and INKUP_TLS_KEY, or neither." >&2
      exit 1
    fi
    set -- "$@" --tls-cert "${INKUP_TLS_CERT}" --tls-key "${INKUP_TLS_KEY}"
  fi
fi

exec /usr/local/bin/inkup "$@"
EOF

RUN set -eu; \
  ldd /usr/local/bin/inkup; \
  if ldd /usr/local/bin/inkup | grep -F 'not found'; then \
    echo "inkup is missing a shared library in the runtime image" >&2; \
    exit 1; \
  fi

ENV INKUP_DATA_DIR=/data \
  INKUP_NO_UPDATE_CHECK=1 \
  HOME=/tmp \
  SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
  SSL_CERT_DIR=/etc/ssl/certs

VOLUME /data
EXPOSE 47823
USER 65532:65532
WORKDIR /data
ENTRYPOINT ["/usr/local/bin/inkup-host"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["inkup", "status"]
