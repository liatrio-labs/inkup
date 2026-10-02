---
status: accepted
date: 2026-09-25
supersedes: 0008
---

# The host and the extension release together, with one version on two tags; cargo-dist releases the host, and the host updates itself

ADR 0008 released the host and the extension on two trains, each with its own version: the host reached 0.6.0 while
the extension was at 0.1.1. Two numbers for one product meant a bug report had to name both, and nothing said which
host and which extension came out together. Now every release gives both the same version, and ships both.

**One version, two tags.** A release tags the host `inkup-v<version>` and the extension `inkup-extension-v<version>`,
with the same version. The host tag starts `inkup-v-release.yml` (cargo-dist) and `desktop-macos.yml` (the desktop
app's DMG, ADR 0025) and must match the host workspace version in `host/Cargo.toml`. The extension tag starts
`release.yml` (the Chrome zip and the Chrome Web Store upload) and `firefox-release.yml` (the Firefox zip and
addons.mozilla.org), which run side by side, each behind its own environment, so neither store waits on the other's
review; both check the tag against `extensions/web/package.json` with `scripts/extension-tag.ts`. Each also takes a
hand-pushed `inkup-chrome-v…` or `inkup-firefox-v…` tag, which releases that store alone at the version already on
`main`. The tags stay separate because the tools read them: the host tag is cargo-dist's `<package>-v<version>` form,
so its prefix is the crate name, `inkup`, lowercase; dist cannot parse `InkUp-v0.2.0`. No workflow matches another's
tags: the host trigger is `inkup-v**…`, which no extension tag starts with. axoupdater parses tags with the same parser
(axotag). It rejects the extension tags, and it skips any release without an `inkup-installer` asset, so it finds host
releases in a repo that also holds extension releases.

**Every release ships everything.** A release tags both and runs every release workflow, even when only one side's
code changed: the host is rebuilt for five targets, the DMG is rebuilt, and the extension is uploaded to both stores
and waits on their reviews again. There is no release of one side alone through release-please.

**One Chrome Web Store review at a time.** The store refuses an upload while a submission is in review, and cancelling
that submission to make room puts the item back at the end of the queue. So before uploading,
`scripts/chrome-web-store.ts` reads the item's status and skips, with a notice and a passing job, while any submission
is in review or when the store already has this version or newer, published or submitted (a rejected one included: the
fix ships as a newer release). It never cancels a submission. `chrome-web-store-sync.yml` runs daily on `main` and runs
the same script with the newest final extension release's Chrome zip from its GitHub Release, so the newest release is
submitted once the review in flight clears; releases in between are never submitted on their own. The sync and
`release.yml`'s store job share a concurrency group, and the `chrome-web-store` environment admits `main` for the sync.

**release-please cuts the release.** `release-please.yml` runs on every push to `main` with
`release-please-config.json` and `.release-please-manifest.json`, and keeps one release pull request open,
`chore(release): <version>`, for both packages: `separate-pull-requests` is off, and the `linked-versions` plugin links
the `inkup` and `inkup-extension` components (its own merge is off, so the config's
`group-pull-request-title-pattern` names the pull request). It still picks a commit's package by path: the extension
is `extensions/web/`; the host is the repo root minus `.github`, `.impeccable`, `apps/site`, `docs`, `extensions`,
`fixtures`, `scripts` and `tests`, so `host/`, `apps/desktop/` (whose DMG ships with the host), `contract/` and
`packages/` (which the extension and the desktop app are built from) all count. Each
package with releasable commits proposes its next version from its own last release, and the plugin takes the highest
of them for both; a package with no releasable commits gets a synthetic `Release-As` commit, so it is released at
that version too. The pull request bumps both versions, the host crates' lockfile entries in `host/Cargo.lock` and
`apps/desktop/src-tauri/Cargo.lock` (release-please's rust type and cargo-workspace plugin cannot read a
`[workspace.package]` version in `host/`, so the host package is `simple` with TOML `extra-files`), and each package's
`CHANGELOG.md`, where only `feat`, `fix`, `perf` and `revert` show (and the synthetic commit, as a chore). The pull
request is set to auto-merge, so releases need no one: CI skips every job on it and it merges once `ci-ok` passes.
Merging it tags the merge commit twice and creates two GitHub Releases: a draft for the host, which dist uploads to
and publishes (`create-release = false`), and a published one for the extension, which both extension workflows add
their zip to. It runs with a personal access token (`RELEASE_PLEASE_TOKEN`), because a tag or pull request made with
`GITHUB_TOKEN` starts no workflow.

**Only a change that ships opens a release.** release-please gives its root package every commit, and its
`exclude-paths` match directories only, so a commit touching any root file (`README.md`, `DESIGN.md`, `.gitignore`,
`package.json`, `pnpm-lock.yaml`) counted for the host: three `feat(site)` pull requests released inkup 0.3.0, 0.4.0
and 0.5.0, and with linked versions each would release both. It has no setting that lists the paths that count, so
`scripts/release-worthy.ts` does, and `release-please.yml` runs it first. It reads the commits since the last commit
that changed `.release-please-manifest.json` (only a merged release pull request does) and says a release is due when
one of them is a type `release-please-config.json` shows in a changelog (`feat`, `fix`, `perf`, `revert`) or a
breaking change, and touches `host/`, `apps/desktop/`, `contract/`, `packages/` or `extensions/web/`; a `Release-As:`
footer is due wherever it is. When none is, release-please runs with `skip-github-pull-request`: it still tags a
merged release pull request, but opens or updates none. Root files never count. A dependency change that matters
edits a `package.json` or `Cargo.toml` under those paths as well as the lockfile; a lockfile-only refresh ships with
the next release, or now with a `Release-As:` footer. Once a change that ships is waiting, release-please writes the
release pull request as before, so a site `feat` merged alongside it still shows in the host's changelog.

**Release candidates cover both, and stay on GitHub.** `versioning: prerelease` and `prerelease-type: rc.1` are set
for both packages, and one top-level `prerelease` setting switches both between proposing `X.Y.Z-rc.N` and the plain
`X.Y.Z`. A candidate tags both `inkup-vX.Y.Z-rc.N` and `inkup-extension-vX.Y.Z-rc.N` as GitHub pre-releases, with
the host's dist artifacts and DMG and the two extension zips. Browsers take only dotted numbers as a manifest
`version`, so the extension build writes the numeric part as `version` and the full version as `version_name` (WXT
does both from package.json's version). Firefox has no `version_name`, so its manifest carries only `X.Y.Z`; the zip's
name (`inkup-X.Y.Z-rc.N-firefox.zip`) and the pre-release say which candidate it is. `scripts/extension-tag.ts` reports
a `-` in the version as a pre-release, the rule dist, `desktop-tag.ts` and release-please use, and the Chrome Web
Store and addons.mozilla.org jobs run only when it is not one. Homebrew skips a candidate (`homebrew-formula`'s
publish job and `desktop-macos`'s cask step), and `inkup update` does not offer it.

**cargo-dist releases the host.** `dist-workspace.toml` at the repo root configures it, and `dist generate` writes
`inkup-v-release.yml` (dist names it after the tag prefix) from that file. Any change goes into the config, never into
the workflow, and a path-filtered `host-dist-check.yml` runs `dist generate --check` so the two cannot drift. It builds
on native runners for `aarch64-apple-darwin`, `x86_64-apple-darwin`, `aarch64-unknown-linux-gnu`,
`x86_64-unknown-linux-gnu` and `x86_64-pc-windows-msvc`. It ships a shell installer, a PowerShell installer and sha256
checksums. Actions are pinned by commit through dist's `github-action-commits`. Code signing the host's binaries is
out of scope for now: dist's `macos-sign` and Windows signing settings are where it will plug in.

**Homebrew pours bottles.** Users run `brew install liatrio-labs/tap/inkup`. The formula is not dist's: dist writes
one without a `bottle do` block, and Homebrew treats such a formula as a source build, so it demands a current Xcode or
Command Line Tools before running an `install` that only copies a binary. `homebrew-formula.yml` runs on the same
`inkup-v*` tag, waits for dist to publish the release, and runs `scripts/formula.ts`, which checks each dist archive
against the release's `sha256.sum` and repacks it as a bottle holding the keg `install` would leave
(`inkup/<version>/bin/inkup` and the docs). The formula's `root_url` is the release's download URL, its `url`s are the
archives (so `--build-from-source` still works), and each bottle is `cellar: :any_skip_relocation`, since the binary
holds no Homebrew path. The release asset is named `inkup-<version>.<tag>.bottle.tar.gz`, with one `-`: that is the
name Homebrew fetches from any `root_url` except GitHub Packages, which uses `inkup--…`. There are four tags:
`arm64_linux` and `x86_64_linux`, and on macOS `arm64_big_sur` and `big_sur`, because Homebrew pours a bottle tagged
for an older macOS on any newer one, and Big Sur (11) is the oldest macOS it still recognises (the arm64 binary needs
11.0, the Intel one 10.12). Before anything is uploaded, a verify job installs the formula from a local tap on macOS
(Apple silicon and Intel) and Linux (x86_64 and arm64) runners, with `root_url` pointed at the bottles just built, and
fails unless Homebrew poured the bottle and `inkup --version` is the release's. Only a stable release uploads the
bottles and pushes `Formula/inkup.rb` to the tap `liatrio-labs/homebrew-tap`; a pre-release builds and verifies them
and stops there. The formula's push and the desktop cask's (ADR 0025) each rebase onto the other and retry, so
neither waits for the other.

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
install commands. A copy inside the desktop app's bundle (its canonical path runs through
`<name>.app/Contents/MacOS/`, which the app's Install CLI link resolves to, ADR 0025) is never overwritten, since that
would break the app's signature: `inkup update` says the copy updates with the app and prints the app's update, `brew
upgrade --cask inkup` when the cask installed it, else the release's DMG. The app check comes before the Homebrew one,
and a saved `[update] homebrew` choice does not apply to it.

**A quiet daily check.** Whichever process hosts (the TUI, `inkup serve`, or the desktop app when it hosts) starts a
background check that never delays startup or the server: at most once a day, cached in `update-check.json` in the
data dir, and only for a person (the CLI when stdout is a terminal; the desktop app always), when `CI` is unset and
`INKUP_NO_UPDATE_CHECK` is unset. It lives in the `inkup-update-check` crate, which the desktop app embeds with the
server. Offline, or on any error, it gives up silently and tries again next start. A newer release shows in the TUI's
key line (while no command outcome is showing), on stderr for `serve`, and in the desktop window's "Update available"
banner (`ControlState.update`), with what to do: `inkup update`, or `brew upgrade inkup` for a Homebrew copy that has
not chosen "self"; for the app, and for the CLI running from inside it, `brew upgrade --cask inkup` when the cask
installed the app, else the release's DMG.

**`inkup-update` still ships.** dist's installers write the receipt only when `install-updater` is on, and that setting
also installs the standalone `inkup-update`. `inkup update` needs the receipt, so the setting stays; `inkup-update` is
redundant but harmless.

**Matching numbers are not the compatibility rule.** The host updates within the hour and each store reviews the
extension on its own schedule, and a user can keep either side back, so users run a host and an extension of
different versions for days at a time. Equal versions say which pair came out together; they never say which pairs
work. The rule is ADR 0007's: the wire contract lives in `contract/`, and a breaking change to it bumps
`PROTOCOL_VERSION`. A release that changes the contract in a breaking way must carry that bump.

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

- Two trains with independent versions (ADR 0008): either side ships without the other, but two numbers name one
  product, and nothing records which host and extension belong together.
- One tag for both: dist needs `inkup-v<version>`, so every workflow would run on that tag, and the environments'
  tag policies, the GitHub Releases (dist's draft and the zips) and the hand-pushed per-store tags would no longer be
  kept apart. Two tags cost nothing once the versions match.
- Linked versions that tag only the side that changed: release-please's default without the plugin's synthetic
  commit. The numbers would still match, but a version would exist on one side only, and "the extension at 0.4.0"
  might not exist.
- `linked-versions` with its own merge, or with `separate-pull-requests` on: the plugin then names the pull request
  "release inkup libraries" or leaves two pull requests; the config's group title pattern with one pull request reads
  better and parses back on merge.
- Release candidates in the stores: neither store has a pre-release channel on the same listing (a beta is a
  second item), and a candidate uploaded there would reach every user after review. GitHub pre-releases are enough
  to load by hand.
- A `release-as` in the config for the first lockstep release: it stays in force until someone takes it out, and
  releases are automatic, so a forgotten one would propose the same version again. The switch is a `feat`, which
  proposes 0.7.0 with nothing to take out.
- Listing what does not count in `exclude-paths`: it matches directories only, so root files would still count.
- A release-please package per shipped directory (`host`, `apps/desktop`, `contract`, `packages`), linked: the paths
  would count without a script, but each package needs its own component, version file and changelog, and a desktop
  change would leave the host's release notes.
- dist's own Homebrew formula and bottles on GitHub Packages: turned down for the reasons in ADR 0008, which still
  hold.
- One tag per store (`inkup-chrome-v…`, `inkup-firefox-v…`) as the normal path, hand-made version bumps, the `rust`
  release type, a hand-written release workflow and `cargo install` as the only install path: turned down for the
  reasons in ADR 0008, which still hold.

## Consequences

- Every release rebuilds five host targets and the DMG, and resubmits the extension to both store reviews, even for a
  change to one side only, except that a Chrome release made while another is in review waits for the daily sync. A
  fix to one side waits no longer than before: the other side's review does not hold it up, because each workflow
  runs alone.
- The extension's version jumped from 0.1.1 to the host's line at the first lockstep release (0.7.0). The Chrome Web
  Store and AMO accept a jump.
- A version bump on one side bumps the other: a `feat` on the extension alone makes a minor release of the host too.
- `releases/latest` points at whichever of the two releases GitHub marked latest last. dist publishes the host's
  draft after the extension's release exists, so it is usually the host's, but install links name a specific
  `inkup-v…` release.
- `RELEASE_PLEASE_TOKEN` must exist and stay unexpired. Without it the release pull request gets no CI run, so it
  cannot pass `ci-ok`, and the tags start no release workflow.
- The `chrome-web-store` and `firefox-amo` environments and the release-tag ruleset must list `inkup-extension-v*`,
  and `chrome-web-store` must admit `main` too, or the daily sync cannot start.
- A Chrome release can reach the store up to a day after its review clears, and some versions never reach it.
  A pre-release still enters neither environment: its store job is skipped before it starts.
- The Chrome Web Store upload holds no Google key. The job exchanges its GitHub OIDC token for an access token of the
  `inkup-cws-upload` service account through a workload identity provider that admits only this repository's
  `chrome-web-store` environment (docs/releasing.md). Renaming that environment, or moving the upload to another job
  environment, breaks the sign-in until the provider's condition and the service account binding follow it.
- A change only in `packages/` counts for the host, and so releases both.
- `scripts/release-worthy.ts` repeats two of release-please's rules, which commit types release and what a breaking
  change or `Release-As:` looks like. It reads the types from `release-please-config.json`; a release-please upgrade
  that changes the others shows when a release pull request opens without the script's say-so, or does not open.
  A new shipped directory (a Safari app, a new package) goes into its `SHIPPED_PATHS`.
- A commit that touches a shipped path only by chance (a `feat(site)` that also edits `packages/`) still releases.
- The host's lockfile bump selects packages by name through release-please's parsed TOML (`@.name.value`); a
  release-please upgrade that changes that shape leaves the lockfiles stale, and the release pull request fails CI's
  `--locked` builds rather than shipping. An upgrade that changes how `linked-versions` picks the version or adds its
  synthetic commit shows in a `release-please release-pr --dry-run` against a branch.
- The tap repo and its `HOMEBREW_TAP_TOKEN` secret must exist before a host release can publish the formula. Without
  them the GitHub Release still goes out, and only `homebrew-formula.yml`'s publish job fails.
- Homebrew plans to drop Big Sur (and Intel macOS) around September 2027. A formula whose macOS tags it no longer
  recognises gets no bottle, and installs fall back to the source build and its Xcode check. When it drops Big Sur,
  move the macOS tags in `scripts/formula.ts` to its oldest remaining macOS and publish a release.
- The Firefox sources zip AMO reviewers rebuild from is the part of the pnpm workspace the build reads, from the repo
  root (`zip.includeSources` in `extensions/web/wxt.config.ts`). The release workflow rebuilds the add-on from it and
  fails if the result differs (`scripts/verify-sources-zip.sh`).
- Only the extension release workflows build with `INKUP_RELEASE_BUILD=1`, and only those builds keep the plain
  icon. Every other build (`wxt dev`, `pnpm build`, `build:firefox`, `build:safari`) draws its manifest and toolbar
  icons over black-and-yellow construction stripes (`extensions/web/src/lib/dev-stripes.ts`), so a build loaded from
  disk is never mistaken for the store one. A new extension release workflow (Safari has none yet) must set it on its
  build step, check its tag with `scripts/extension-tag.ts` and skip its store on a pre-release; the sources zip
  rebuild sets it too (`SOURCE_BUILD.md`).
- A release candidate and its final release have the same manifest `version`, so a browser does not update a
  candidate loaded by hand to the final one; it is removed and the final one installed from the store.
- A user who updates a Homebrew copy with "self" has two copies until they uninstall one; `inkup update` says so.
- zizmor findings that come from dist's template are ignored for `inkup-v-release.yml` only, each with its reason in
  `.github/zizmor.yml`. Upgrading dist means re-reading those findings.

## History

- 2026-09-25: we released the host and the extension on two trains, each with its own version and release pull
  request (ADR 0008, whose History covers cargo-dist, self-update, the skew guard, the Homebrew bottles and
  release-please up to here). Now one release pull request gives both the same version and ships both, and release
  candidates cover the extension too, on GitHub only. The first lockstep release is 0.7.0: the switch is a `feat`, so
  the host proposes 0.7.0 after its 0.6.0, and the plugin gives the extension the same.
- 2026-10-01: any commit touching a root file counted for the host, so site and docs pull requests released it (inkup
  0.3.0, 0.4.0 and 0.5.0 had no host change). Now `scripts/release-worthy.ts` lists the paths that ship and
  release-please opens a release pull request only for a change to one, and `packages/` counts, since the extension
  and the desktop app are built from it.
- 2026-10-02: we thought every release submits to the Chrome Web Store. Now at most one review is in flight, and a
  daily sync submits the newest release once it clears, because rapid releases failed the upload ("You may not edit
  or publish an item that is in review") or would have queued a review each.

## Sources

- release-please's `linked-versions` plugin: <https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md#linked-versions>
- Chrome's `version` and `version_name`: <https://developer.chrome.com/docs/extensions/reference/manifest/version>
- Firefox's `version` format, and no `version_name`: <https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/manifest.json/version>
