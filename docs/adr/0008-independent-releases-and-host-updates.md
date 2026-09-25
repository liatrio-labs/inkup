---
status: accepted
date: 2026-09-24
---

# The host and the extension release on separate tags that release-please cuts; cargo-dist releases the host, and the host updates itself

One `v*` tag released the Chrome extension, Firefox had no release, and the host had none either: users built it with
cargo. They ship at different speeds. A store review holds up an extension release for days, each store on its own
schedule, while a host fix should reach users the same hour. And a host that people install needs a way to update that
is not "build it again".

**Two trains, two tag prefixes.** `inkup-v<version>` releases the host (`inkup-v-release.yml`) and must match the
host workspace version in `host/Cargo.toml`. `inkup-extension-v<version>` releases the extension to both stores: it
starts `release.yml` (the Chrome zip and the Chrome Web Store upload) and `firefox-release.yml` (the Firefox zip and
addons.mozilla.org), which run side by side, each behind its own environment, so neither store waits on the other's
review. Both check the tag against `extensions/web/package.json`. Each also takes a hand-pushed `inkup-chrome-v…` or
`inkup-firefox-v…` tag, which releases that store alone. No workflow matches another's tags: the host trigger is
`inkup-v**…`, which no extension tag starts with. The host tag is cargo-dist's `<package>-v<version>` form, so its prefix
is the crate name, `inkup`, lowercase; dist cannot parse `InkUp-v0.2.0`. axoupdater parses tags with the same parser
(axotag). It rejects the extension tags, and it skips any release without an `inkup-installer` asset, so it finds host
releases in a repo that also holds extension releases.

**release-please cuts both trains.** `release-please.yml` runs on every push to `main` with `release-please-config.json`
and `.release-please-manifest.json`, and keeps one release pull request open per train. It picks a commit's train by
path: the extension is `extensions/web/`; the host is the repo root minus `.github`, `docs`, `extensions`, `fixtures`,
`packages`, `scripts` and `tests`, so `host/`, `apps/desktop/` (whose DMG ships with the host) and `contract/` all count.
The pull request bumps the version, the host crates' lockfile entries in `host/Cargo.lock` and
`apps/desktop/src-tauri/Cargo.lock` (release-please's rust type and cargo-workspace plugin cannot read a
`[workspace.package]` version in `host/`, so the host package is `simple` with TOML `extra-files`), and the train's
`CHANGELOG.md`, where only `feat`, `fix`, `perf` and `revert` show. Merging it tags the merge commit and creates the
GitHub Release: a draft for the host, which dist uploads to and publishes (`create-release = false`), and a published
one for the extension, which both extension workflows add their zip to. It runs with a personal access token
(`RELEASE_PLEASE_TOKEN`), because a tag or pull request made with `GITHUB_TOKEN` starts no workflow. Only the host has
release candidates, with release-please's `prerelease` versioning switched by the host package's `prerelease` setting;
Chrome takes only dotted numbers as a manifest version, so the extension has none.

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

**Skew guard.** Updating the host can lock out an installed extension when the new host raises `PROTOCOL_VERSION`
past what the extension speaks, so `inkup update` checks before it installs. Each host release carries its protocol
version as a `protocol-version.txt` asset: dist's `extra-artifacts` (in the `inkup` crate's `[package.metadata.dist]`)
runs the `inkup-protocol` crate's `protocol-version` example, which writes the crate constant, so the file cannot
drift from the code. The store records the version each paired Client last spoke in `hello` (`clients.protocol_version`,
migration 5, set on every handshake). After finding a newer release, `inkup update` reads the release's asset
(`releases/tags/inkup-v<version>` on the same GitHub API axoupdater uses) and compares it with the versions spoken by
Clients seen in the last 30 days. When the release's is higher than any of theirs, it names each Client behind, says to
update the extension first, and asks "Update inkup anyway? [y/N]"; no answer is no. `--yes` goes on with the warning
printed, and `--check` prints the warning without asking. The guard runs before every install path (installer,
Homebrew, a dev build's install commands). A release without the asset (every release before the guard), no paired
Client, or a Client not heard from since the version was recorded means no warning. The daily check caches the
release's protocol version next to its version, and its notice says to update the extension first and names the
Clients behind.

## Considered options

- One tag for everything: every host fix would wait on a store review, and every extension release would rebuild five
  host targets.
- A tag per store (`inkup-chrome-v…`, `inkup-firefox-v…`) as the normal path: release-please makes one tag per
  package, and both stores ship the same package.json version, so two tags would be two release pull requests for one
  version. One tag does not make a store wait on the other's review, because the two workflows run apart.
- Hand-made version-bump pull requests and hand-pushed tags: each release took two steps by hand, and changelogs were
  not written.
- release-please's `rust` release type with the `cargo-workspace` plugin: it reads a `Cargo.toml` at the repo root and
  per-crate `version` fields, and the host's workspace is in `host/` with one `[workspace.package]` version.
- `host-v*` or `InkUp-v*` host tags: dist parses only `v…`, `<package>-v…` (the crate name, exactly) and `<prefix>/v…`.
  Either would need a hand-edited generated workflow, which `dist generate --check` would flag on every change.
- `host/v*` host tags: these parse, but they break the `inkup-<train>-v` pattern the extension tags follow.
- A hand-written release workflow: we would have to write the cross-compiles, installers, formula and receipt ourselves,
  and axoupdater expects dist's layout.
- `cargo install` as the only install path: it needs a Rust toolchain and a long build, and it cannot update itself.

## Consequences

- `releases/latest` points at whichever train released last, so install links name a specific `inkup-v…` release.
- `RELEASE_PLEASE_TOKEN` must exist and stay unexpired. Without it the release pull requests get no CI run, so they
  cannot pass `ci-ok`, and the tags start no release workflow.
- The `chrome-web-store` and `firefox-amo` environments and the release-tag ruleset must list `inkup-extension-v*`.
- A change only in `packages/` opens no release on its own; it ships with the next extension release.
- The host's lockfile bump selects packages by name through release-please's parsed TOML (`@.name.value`); a
  release-please upgrade that changes that shape leaves the lockfiles stale, and the release pull request fails CI's
  `--locked` builds rather than shipping.
- The tap repo and its `HOMEBREW_TAP_TOKEN` secret must exist before a host release can publish the formula. Without
  them the GitHub Release still goes out, and only the Homebrew job fails.
- The Firefox sources zip AMO reviewers rebuild from is the part of the pnpm workspace the build reads, from the repo
  root (`zip.includeSources` in `extensions/web/wxt.config.ts`). The release workflow rebuilds the add-on from it and
  fails if the result differs (`scripts/verify-sources-zip.sh`).
- Only the extension release workflows build with `INKUP_RELEASE_BUILD=1`, and only those builds keep the plain
  icon. Every other build (`wxt dev`, `pnpm build`, `build:firefox`, `build:safari`) draws its manifest and toolbar
  icons over black-and-yellow construction stripes (`extensions/web/src/lib/dev-stripes.ts`), so a build loaded from
  disk is never mistaken for the store one. A new extension release workflow (Safari has none yet) must set it on its
  build step, and the sources zip rebuild sets it too (`SOURCE_BUILD.md`).
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
- 2026-09-25: the skew guard was recorded as not built; now built, as described under "Skew guard": a
  `protocol-version.txt` release asset generated from the crate constant, the protocol version each Client last spoke
  in `hello` in the store, and a warning with a confirmation (or `--yes`) in `inkup update` and a mention in the daily
  notice. The config.toml header the host writes is now the file's first lines; toml_edit had kept it as trailing
  decor, so it ended up at the bottom.
- 2026-09-25: the sources zip covered `extensions/web` only, so reviewers could not rebuild it without
  `packages/core` and `packages/protocol`. It is now zipped from the repo root with the workspace packages, the root
  lockfile and `SOURCE_BUILD.md`. Tailwind scans `src/` only (`source("../")`), because it had picked up class names
  from tests and from the generated `public/ort` files, and the CSS differed between the repo and the zip.
- 2026-09-25: a host release carried only the host. Now it also carries the desktop app's signed, notarized DMG,
  built by `desktop-macos.yml`, which dist calls after announce (`post-announce-jobs`), behind the `release`
  environment's approval (ADR 0025). The host's own binaries are still unsigned.
- 2026-09-25: every extension build looked the same. Now only release-workflow builds (`INKUP_RELEASE_BUILD=1`, a
  compile-time constant) keep the plain icon; the rest show construction stripes under it, drawn by the same pure code
  at build time (the manifest icons) and in the background (the toolbar icon with its host dot). A reviewer rebuilding
  from the sources zip sets the variable too, or the icons differ from the submitted add-on.
- 2026-09-25: releases were cut by hand, with a version-bump pull request and a pushed tag per train, and the
  extension had a tag per store. Now release-please cuts them from release pull requests, and one
  `inkup-extension-v<version>` tag releases both stores; `inkup-chrome-v…` and `inkup-firefox-v…` remain for releasing
  one store alone. dist uploads to release-please's draft release instead of creating one.
