# The local e2e runner: Linux, as CI's ubuntu runners are, so a Mac never runs Playwright itself (scripts/e2e-docker.sh
# builds and runs this). The Playwright image carries the browsers and their system libraries at the exact version in
# pnpm-lock.yaml; on top of it go what CI adds with setup-node, pnpm/action-setup and rust-toolchain, and the sound
# server the Firefox job starts. scripts/e2e-docker.sh passes every version in, read from the lockfile, ci.yml and
# host/rust-toolchain.toml.
ARG PLAYWRIGHT_VERSION
ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm-slim AS node

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
ARG PNPM_VERSION
ARG RUST_VERSION

# CI's Node (the image ships an older one in /usr/bin), and pnpm at CI's major.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && npm install --global "pnpm@${PNPM_VERSION}" \
  && node --version && pnpm --version

# A C toolchain for cargo's build scripts; pulseaudio for the Firefox job (with no sound server, an AudioContext's
# resume() and close() hang); unzip, with which the Export specs open the zip (the runners have it); util-linux's setpriv, with which the entrypoint drops to the caller's UID.
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential pkg-config pulseaudio unzip util-linux \
  && rm -rf /var/lib/apt/lists/*

# Rust at host/rust-toolchain.toml's channel with its components, so rustup has nothing to fetch at run time. The
# toolchain is read-only to the caller; CARGO_HOME (the registry) moves to a volume at run time.
ENV RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | CARGO_HOME=/usr/local/cargo sh -s -- -y --no-modify-path --profile minimal \
      --default-toolchain "${RUST_VERSION}" --component rustfmt,clippy \
  && chmod -R a+rX /usr/local/rustup /usr/local/cargo \
  && cargo --version

COPY e2e-entrypoint.sh /usr/local/bin/e2e-entrypoint
ENTRYPOINT ["/usr/local/bin/e2e-entrypoint"]
