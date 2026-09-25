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

**The host updates itself, and leaves a Homebrew install to Homebrew.** `inkup` embeds axoupdater. `inkup update` asks
GitHub for the newest `inkup-v*` release (`--check` only reports) and acts on how this copy was installed. The shell and
PowerShell installers write an install receipt naming the install dir; when the receipt matches the running executable,
`inkup update` runs the new release's installer over it. A Homebrew copy is recognised by its canonical path running
through `<prefix>/Cellar/inkup/` (or `$HOMEBREW_CELLAR/inkup/`): that covers `/opt/homebrew` on Apple silicon,
`/usr/local` on Intel and `/home/linuxbrew/.linuxbrew` on Linux without running `brew`. For a Homebrew copy the user
chooses once, when first asked at a terminal or with `inkup update --homebrew brew|self|ask`, and the choice is saved as
`[update] homebrew` in the data dir's config.toml. "brew" prints `brew upgrade inkup`. "self" installs the release with
its installer anyway. It does not touch Homebrew's files: the new copy goes where the installer puts it
(`~/.cargo/bin`), with its own receipt, so there are then two copies, `brew upgrade` still updates Homebrew's, and PATH
order decides which runs. `inkup update` says which one PATH picks, and suggests `brew uninstall inkup`. Any other copy
(`cargo install`, a dev build) has no receipt and does not update itself: it says a release exists and prints the
install commands.

**A quiet daily check.** The TUI and `inkup serve` start a background check that never delays startup or the server: at
most once a day, cached in `update-check.json` in the data dir, and only when stdout is a terminal, `CI` is unset and
`INKUP_NO_UPDATE_CHECK` is unset. Offline, or on any error, it gives up silently and tries again next start. A newer
release shows in the TUI's key line (while no command outcome is showing), and on stderr for `serve`, with the command
to run: `inkup update`, or `brew upgrade inkup` for a Homebrew copy that has not chosen "self".

**`inkup-update` still ships.** dist's installers write the receipt only when `install-updater` is on, and that setting
also installs the standalone `inkup-update`. `inkup update` needs the receipt, so the setting stays; `inkup-update` is
redundant but harmless.

**Versions will skew, and the protocol contract keeps skew safe.** A user can run any host with any extension, so equal
version numbers can never be the compatibility rule. The rule is ADR 0007's: the wire contract lives in `contract/`,
and a breaking change to it bumps `PROTOCOL_VERSION`. A release on any train that changes the contract in a breaking
way must carry that bump. Additive changes ship on any train alone.

**Where a skew guard would go (not built).** Updating the host can lock out an installed extension when the new host
raises `PROTOCOL_VERSION` past what the extension speaks. The guard belongs in `inkup update`, before it installs:
publish each host release's protocol version with the release (a small `protocol-version.txt` added through dist's
`extra-artifacts`, or a line in the release body), have the updater read it next to the version, and warn when it is
newer than the protocol version the paired Clients last spoke in `hello`, which the store would need to keep. Neither
half exists today, so this step only records the place.

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
- A user who updates a Homebrew copy with "self" has two copies until they uninstall one; `inkup update` says so.
- zizmor findings that come from dist's template are ignored for `inkup-v-release.yml` only, each with its reason in
  `.github/zizmor.yml`. Upgrading dist means re-reading those findings.

## History

- 2026-09-24 (#36): the three trains shipped. dist's `tag-namespace` is `inkup-v`, not `inkup`: dist turns it into the
  trigger glob, and `inkup` would also catch the extension tags. `pr-run-mode = "skip"`, so dist does not run on every
  pull request; `host-dist-check.yml` runs only when the release config changes and is not part of `ci-ok`. The Firefox
  AMO upload sits behind a `firefox-amo` environment and skips when its secrets are unset.
- 2026-09-24 (#39): `inkup update` and the daily check shipped on axoupdater 0.10. The version check ignores the
  receipt, so Homebrew and dev copies get the notice too; only installing needs it. The `[update]` table is written
  from the `inkup` crate with `toml_edit`, so the store crate is unchanged.
