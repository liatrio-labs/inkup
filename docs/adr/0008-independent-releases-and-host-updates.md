---
status: accepted
date: 2026-09-24
---

# The host, the Chrome extension and the Firefox add-on release on separate tags; cargo-dist releases the host, and the host updates itself

One `v*` tag released the Chrome extension, Firefox had no release, and the host had none either: users built it with
cargo. They ship at different speeds. A store review holds up an extension release for days, each store on its own
schedule, while a host fix should reach users the same hour. And a host that people install needs a way to update that
is not "build it again".

**Three trains, three tag prefixes.** `inkup-v<version>` releases the host (`inkup-v-release.yml`) and must match the
host workspace version in `host/Cargo.toml`. `inkup-chrome-v<version>` runs `release.yml`, which checks the tag against
`extensions/web/package.json` and releases the zip and the Chrome Web Store upload as before. `inkup-firefox-v<version>`
runs `firefox-release.yml`, which does the same for the Firefox zip and addons.mozilla.org. The two extension trains
share the package.json version; each store only needs it to rise between its own uploads. No workflow matches another's
tags: the host trigger is `inkup-v**…`, which `inkup-chrome-v…` and `inkup-firefox-v…` do not start with. The host tag
is cargo-dist's `<package>-v<version>` form, so its prefix is the crate name, `inkup`, lowercase; dist cannot parse
`InkUp-v0.2.0`. axoupdater parses tags with the same parser (axotag). It rejects `inkup-chrome-v…` and
`inkup-firefox-v…`, and it skips any release without an `inkup-installer` asset, so it finds host releases in a repo
that also holds extension releases.

**cargo-dist releases the host.** `dist-workspace.toml` at the repo root configures it, and `dist generate` writes
`inkup-v-release.yml` (dist names it after the tag prefix) from that file. Any change goes into the config, never into
the workflow, and a path-filtered `host-dist-check.yml` runs `dist generate --check` so the two cannot drift. It builds
on native runners for `aarch64-apple-darwin`, `x86_64-apple-darwin`, `aarch64-unknown-linux-gnu`,
`x86_64-unknown-linux-gnu` and `x86_64-pc-windows-msvc`. It ships a shell installer, a PowerShell installer, a Homebrew
formula and sha256 checksums. The formula is pushed to the tap `liatrio-labs/homebrew-tap`, so users run `brew install
liatrio-labs/tap/inkup`. Actions are pinned by commit through dist's `github-action-commits`. Code signing is out of
scope for now: dist's `macos-sign` and Windows signing settings are where it will plug in.

**The host updates itself, and leaves a Homebrew install to Homebrew.** Installed by the shell or PowerShell installer
(with `install-updater` on), the host gets an install receipt and an `inkup-update` binary. A later step embeds
axoupdater in `inkup` itself. It reads the receipt, checks this repo's GitHub Releases for a newer `inkup-v*`, and
installs it in place. A Homebrew install has no receipt. The host detects that it runs from a Homebrew prefix and tells
the user to run `brew upgrade inkup`. The user can override that and have the host update itself anyway, knowing
that brew then no longer tracks the binary they run.

**Versions will skew, and the protocol contract keeps skew safe.** A user can run any host with any extension, so equal
version numbers can never be the compatibility rule. The rule is ADR 0007's: the wire contract lives in `contract/`,
and a breaking change to it bumps `PROTOCOL_VERSION`. A release on any train that changes the contract in a breaking
way must carry that bump. Additive changes ship on any train alone.

## Considered options

- One tag for everything: every host fix would wait on a store review, and every extension release would rebuild five
  host targets.
- One tag for both extensions: a Chrome fix would wait on Mozilla's review, or the reverse.
- `host-v*` or `InkUp-v*` host tags: dist parses only `v…`, `<package>-v…` (the crate name, exactly) and `<prefix>/v…`.
  Either would need a hand-edited generated workflow, which `dist generate --check` would flag on every change.
- `host/v*` host tags: these parse, but they break the `inkup-<train>-v` pattern the extension tags follow.
- A hand-written release workflow: we would have to write the cross-compiles, installers, formula and receipt ourselves,
  and axoupdater expects dist's layout.
- `cargo install` as the only install path: it needs a Rust toolchain and a long build, and it cannot update itself.

## Consequences

- `releases/latest` points at whichever train released last, so install links name a specific `inkup-v…` release.
- The tap repo and its `HOMEBREW_TAP_TOKEN` secret must exist before a host release can publish the formula. Without
  them the GitHub Release still goes out, and only the Homebrew job fails.
- The Firefox sources zip AMO reviewers rebuild from covers `extensions/web` only, not the workspace packages it
  imports; that must be fixed before the first listed AMO submission.
- zizmor findings that come from dist's template are ignored for `inkup-v-release.yml` only, each with its reason in
  `.github/zizmor.yml`. Upgrading dist means re-reading those findings.
