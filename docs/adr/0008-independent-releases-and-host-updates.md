---
status: accepted
date: 2026-09-24
---

# The extension and the host release on separate tags; cargo-dist releases the host, and the host updates itself

One `v*` tag released the extension, and the host had no release at all: users built it with cargo. The two ship at
different speeds. A store review holds up an extension release for days, while a host fix should reach users the same
hour. And a host that people install needs a way to update that is not "build it again".

**Two trains, two tag namespaces.** `extension-v<version>` runs `release.yml`, which checks the tag against
`extensions/web/package.json` and releases the zip and the Chrome Web Store upload as before. `host/v<version>` runs
`host-release.yml` and must match the host workspace version in `host/Cargo.toml`. Neither workflow matches the other's
tags. The host tag has a slash, not a dash, because cargo-dist reads a version from `v0.2.0`, `<package>-v0.2.0` or
`<prefix>/v0.2.0` and cannot parse `host-v0.2.0`. axoupdater parses tags the same way, so it finds host releases in a
repo that also holds extension releases, and it skips the extension ones because they carry no `inkup-installer`.

**cargo-dist releases the host.** `dist-workspace.toml` at the repo root configures it, and `dist generate` writes
`host-release.yml` from that file. Any change goes into the config, never into the workflow, and a path-filtered
`host-dist-check.yml` runs `dist generate --check` so the two cannot drift. It builds on native runners for
`aarch64-apple-darwin`, `x86_64-apple-darwin`, `aarch64-unknown-linux-gnu`, `x86_64-unknown-linux-gnu` and
`x86_64-pc-windows-msvc`. It ships a shell installer, a PowerShell installer, a Homebrew formula and sha256 checksums.
The formula is pushed to the tap `liatrio-labs/homebrew-tap`, so users run `brew install liatrio-labs/tap/inkup`.
Actions are pinned by commit through dist's `github-action-commits`. Code signing is out of scope for now: dist's
`macos-sign` and Windows signing settings are where it will plug in.

**The host updates itself, and leaves a Homebrew install to Homebrew.** Installed by the shell or PowerShell installer
(with `install-updater` on), the host gets an install receipt and an `inkup-update` binary. A later step embeds
axoupdater in `inkup` itself. It reads the receipt, checks this repo's GitHub Releases for a newer `host/v*`, and
installs it in place. A Homebrew install has no receipt. The host detects that it runs from a Homebrew prefix and tells
the user to run `brew upgrade inkup`. The user can override that and have the host update itself anyway, knowing
that brew then no longer tracks the binary they run.

**Versions will skew, and the protocol contract keeps skew safe.** A user can run any host with any extension, so equal
version numbers can never be the compatibility rule. The rule is ADR 0007's: the wire contract lives in `contract/`,
and a breaking change to it bumps `PROTOCOL_VERSION`. A release on either train that changes the contract in a breaking
way must carry that bump. Additive changes ship on either train alone.

## Considered options

- One tag for both: every host fix would wait on a store review, and every extension release would rebuild five host
  targets.
- `host-v*` tags: what we wanted, but dist cannot parse them. Getting them would take a hand-edited generated workflow
  that rewrites the tag, which `dist generate --check` would then flag on every change.
- `inkup-v*` tags (dist's own `<package>-v` form): these parse, but the extension is also called inkup, so the name does
  not say which train a tag belongs to.
- A hand-written release workflow: we would have to write the cross-compiles, installers, formula and receipt ourselves,
  and axoupdater expects dist's layout.
- `cargo install` as the only install path: it needs a Rust toolchain and a long build, and it cannot update itself.

## Consequences

- `releases/latest` points at whichever train released last, so install links name a specific `host/v…` release.
- The tap repo and its `HOMEBREW_TAP_TOKEN` secret must exist before a host release can publish the formula. Without
  them the GitHub Release still goes out, and only the Homebrew job fails.
- zizmor findings that come from dist's template are ignored for `host-release.yml` only, each with its reason in
  `.github/zizmor.yml`. Upgrading dist means re-reading those findings.
