---
status: accepted
date: 2026-09-25
---

# One host per data dir, and a desktop app that hosts it or drives the host already running through a loopback control API

The host had one face, the `inkup` TUI in a terminal, plus headless `inkup serve`. Many reviewers don't keep a
terminal open, so the desktop app (`apps/desktop`, Tauri 2) gives them a window and a menu bar icon with the TUI's six
views and actions. A second front end raises two questions: what happens when two of them start on the same data
dir, and how a window drives a host running in another process.

**One host per data dir.** Every host mode (the TUI, `serve` and the desktop app) holds an exclusive OS lock on
`host.lock` in the data dir for as long as it runs (`inkup_store::instance::HostLock`). The OS drops the lock when the
process dies, however it dies, so no stale-pid logic is needed. Once its server has bound, the holder writes
`host.json` (mode 0600 on Unix): its pid, its kind (`tui`, `serve` or `desktop`), its port, the control API's token and
version, and the host version. A clean exit removes it: Quit, Ctrl-C, or SIGTERM for `serve`. `inkup status` reads the
port from it. A leftover `host.json` after a crash is harmless, because the lock is free and the next host overwrites
the file. Two servers never share a database. A second instance needs its own `--data-dir` (and `--port 0` to take
any free port).

**Find or host.** A host mode that finds the lock held never takes over:

- The TUI and `serve` say which host is running ("InkUp is already running (desktop app, pid …, port …)") and exit 1.
  If the holder is the desktop app, they first ask it to bring its window forward.
- The desktop app (`apps/desktop/src-tauri/src/startup.rs`, `find_or_host`) hosts when the lock is free. If another
  desktop app holds it, the new one asks that app to come forward and exits 0. If the TUI or `serve` holds it, the app
  becomes that host's window: it shows the host's state and drives it through the control API. If that host stops,
  the window says so. **Host here** runs find-or-host again, so the app hosts only after a person asks it to.
- A holder whose control API version differs from the app's is refused with a message naming both versions
  (`StartupError::Incompatible`).

**The desktop app embeds the host.** It builds the host's crates (`inkup-server`, `inkup-store`, `inkup-protocol`,
`inkup-update-check`) from `host/` and runs the same server in-process, rather than shipping the `inkup` binary as a
sidecar. It has its own cargo workspace in `apps/desktop/src-tauri`, so Tauri, WebKitGTK and GTK stay out of the
host's `cargo test` and release builds. CI runs it as a separate `desktop` job on the same three platforms. The job
runs when `apps/desktop/`, `host/`, `packages/` or the workspace's install files change (ADR 0007).

**The control API.** A window, or any other local front end, runs a host through `/api/host/*` on the host's own
port (`host/crates/server/src/control.rs`). It exposes what the TUI's keys do: the state with the timeline, a
long-poll for changes, Session commands, agent tokens, network mode, pairing answers, and "come forward".

- **Trust.** Only loopback peers are accepted, in every network mode, and a web page's Origin is refused. The only
  credential is the Bearer `control_token` from `host.json`, which only the user who runs the host can read, the
  same boundary as ADR 0005's "a local process running as the user is out of scope". A paired Client's token or an
  agent token is refused: those are for Sessions and MCP, not for running the host.
- **Contract.** The shapes are Zod-first in `packages/protocol/src/host-control.ts`, generated to
  `contract/host-control.schema.json` and to the Rust `inkup_protocol::control` types (ADR 0007). The server builds
  its responses as those types, so drift fails in the host's tests. The API has its own version, `CONTROL_API` (in
  `ControlState.control_api` and `host.json`), separate from `PROTOCOL_VERSION`. `contract-compat` requires a bump
  for a breaking change.
- **Embedder hooks.** What only the embedding process can do goes through a hook: `ActivateHook` brings the window
  forward, and `NetworkHook` restarts the server in or out of network mode. A host without the hook answers
  `{handled: false}`, and the window says where to do it instead (the TUI switches network mode in its terminal).

**Pairing is asked by whichever process hosts.** The TUI asks in its terminal and `serve` on its terminal. The desktop
app, when it hosts, asks in its window: `Server::ask_pairing_over_control` routes requests to the control API's
pending list instead of a terminal. A request from another machine shows its pairing code and a QR code. The window can
only refuse it, because the Client pairs by typing the code (ADR 0006). When the app is another host's window, that
host asks. A network-mode restart drops the waiting requests (their Clients are cut off and ask again), and a request's
id is never reused within the process, so an answer meant for a dropped request is a 404, never another request's.

**The app's own settings.** `[desktop]` in `config.toml` holds `menubar` and `dock`: whether the app shows a menu bar
(tray) icon and a Dock icon (the taskbar outside macOS). At least one stays on. Saving both off is refused, and a file
edited to both off gets the Dock back. Closing the window hides it and the app keeps hosting. Quit, in the menu bar
menu, stops the server and gives up the data dir.

**What the icons say.** The menu bar (tray) and Dock icons are drawn at run time from the bundled PNG
(`apps/desktop/src-tauri/src/icon.rs`), in host mode and client mode alike:

- A dot for paired Clients, the extension's host dot (green, white ring, bottom-right, the same geometry): none
  while no Client is paired, steady while one or more are, and a slow pulse (full and faint, half a second each)
  while any is sending: a live Session that is not paused (a paused one shows the steady dot). It follows the host
  state the window already reads through `HostLink` (each `host_state` call), so the icons add no poll of their
  own, and only the pulse runs a timer.
- Development stripes: anything the release workflow did not build (`INKUP_RELEASE_BUILD` unset at compile time,
  so debug builds, `desktop:dev` and a local release build) draws the icon, inset by one band, on 45° black and
  yellow bands, the same as the extension's development icon. The dot goes on top.
- The tray icon is a full-colour image, not a template: macOS draws a template in the menu bar's single colour,
  which would lose the green dot and the stripes.
- The Dock picture is the Dock tile's content view (safe objc2-app-kit calls), because Tauri 2 cannot change the
  Dock icon. The bundled .icns never changes, so Finder, and the Dock before launch, show the plain icon even for a
  development build.

**It ships as a signed, notarized DMG on the host's release train.** Each `inkup-v<version>` release also carries
`InkUp_<version>_universal.dmg`: one app for Apple silicon and Intel, versioned by the tag, since it embeds that
host. `.github/workflows/desktop-macos.yml` runs on the same `inkup-v*` tag as cargo-dist's release workflow, as a
workflow of its own rather than a job in dist's. It first checks the tag (`scripts/desktop-tag.ts`): a host release
tag that exists on the remote. Its version says whether it is a pre-release, by the rule dist and release-please use
(a `-` in the version). The build checks out the commit the tag points at. The job runs on a GitHub-hosted macOS
runner in the `release` environment, which holds the signing secrets and takes `inkup-v*` tags only; it has no
required reviewer, so the DMG builds as soon as the tag is out. A maintainer can run it again for an existing tag with
`workflow_dispatch`, dispatched on that tag so the environment admits it. There is one run per tag at a time.

- fastlane match puts the Developer ID Application certificate in a temporary keychain. It reads the shared match
  repo read-only, so CI never creates or renews a certificate (`apps/desktop/fastlane`).
- Tauri signs the app with the hardened runtime (`bundle.macOS.hardenedRuntime`), then notarizes and staples it,
  using an App Store Connect API key.
- The job notarizes and staples the DMG as well, because Gatekeeper checks the file that was downloaded.
- It attaches the DMG only after `codesign --verify --deep --strict` and `spctl` accept both the app and the DMG.
  release-please creates the tag's release as a draft, and dist's `host` job publishes it once the host's files are
  on it. The job uploads to that release whether it is still a draft or not, waiting up to 30 minutes for it to
  exist, and never publishes it itself.
- On a stable release it waits (up to 30 minutes) for dist to publish the release, since the cask's URL is a published
  release's download. It then pushes a Homebrew cask for the DMG, `Casks/inkup.rb`, to `liatrio-labs/homebrew-tap`
  (rendered by `scripts/cask.ts`), with the `HOMEBREW_TAP_TOKEN` dist's formula job uses. The cask's token is `inkup`,
  the formula's too: `brew install --cask liatrio-labs/tap/inkup` installs the app and
  `brew install liatrio-labs/tap/inkup` the CLI. A pre-release never touches the tap, the rule dist follows for the
  formula. Its `zap` removes only the app's own `dev.inkup.desktop` caches and preferences: the host's data dir is
  the CLI's too.

Nothing in dist's workflow waits on this one, so a failed or slow desktop build never holds up or undoes
the host release: the release just has no DMG until the job is re-run. Pre-releases run it too, which is how the path
is proven.

**The UI is shadcn/ui only.** The window (`apps/desktop/ui`) is built from off-the-shelf shadcn/ui components added
with the shadcn CLI, and has no custom components of its own. It follows the TUI's views and words, so the two stay
recognisably the same product.

## Considered options

- The DMG as a dist publish job (`publish-jobs`): dist skips publish jobs for pre-releases unless
  `publish-prereleases` is on, which would also push every rc to the Homebrew tap. It would also make `announce` wait
  for the desktop build.
- The DMG as a dist post-announce job (`post-announce-jobs`), which it first was: the generated job has no `if:`, so
  its implicit `success()` skips it when any job it depends on, directly or not, was skipped. On a pre-release dist
  skips `publish-homebrew-formula`, `announce` depends on it, so the DMG was never built for an rc. The generated
  workflow can't take a custom `if:`.
- Tauri importing a `.p12` from a secret (`APPLE_CERTIFICATE`): a second copy of the certificate to rotate. match keeps
  one copy, which the team's other apps already use.

- Ship the `inkup` binary as a sidecar and have the app start it: two binaries to build, sign and keep in step. The
  window would still need an API to talk to it, and the app couldn't restart or hook into the server directly.
- Let the app read the SQLite store directly while a CLI host runs: two writers on one database, and a window coupled
  to the storage schema. With the control API, the host stays the only writer.
- Take over from a running TUI (ask it to quit, or kill it): that surprises the person in the terminal and drops their
  Clients mid-Session. Host here makes the takeover something the person asks for.
- A pid file with staleness checks instead of an OS lock: pids get reused, and a crash leaves a file that looks live.
  The lock is released by the OS.
- Pair the window like a Client: a prompt to let a local window drive its own host protects nothing that the
  user-only `host.json` does not already.
- A Unix socket or named pipe for the control API: a second transport per OS, when loopback plus the Origin check plus
  a user-only token already has the trust boundary ADR 0005 accepts.

## Consequences

- The TUI and `serve` take the lock too, so a second `inkup` on the same data dir now exits instead of failing to
  bind the port.
- Tests and scripts that start a host use a temporary `--data-dir` and `--port 0`, as they did for the port.
  `scripts/desktop-smoke.sh` runs the lock, find-or-host, Host here and the menu bar and Dock settings end to end,
  on macOS.
- Anything the TUI can do that a window should also do becomes a control API route, added to the contract first,
  with a `CONTROL_API` bump when it breaks.
- When the app hosts, it runs the host's daily update check (ADR 0008) and its notice fills `ControlState.update`,
  which the window shows as "Update available": `brew upgrade --cask inkup` when the cask installed the app, else the
  release's DMG. When the app is a CLI host's window, that host checks and words the notice.
- The app has no Windows or Linux release and does not update itself: a newer DMG is installed over it. The host's
  self-update (ADR 0008) covers only the `inkup` binary.
- A release depends on the match repo (`dbhagen/fastlane-match`) and its read-only deploy key, and on an App Store
  Connect API key. When the Developer ID certificate expires, it is renewed in the match repo, outside CI.

## History

- 2026-09-25 (#26): release packaging was deferred; builds were debug builds from a checkout. 2026-09-25: the app
  ships as a signed, notarized universal DMG on each host release, from a post-announce job, as "It ships as a signed,
  notarized DMG" says.
- 2026-09-25: the icons showed only the app icon. Now they carry the paired-Clients dot and, on development builds,
  the construction stripes, as "What the icons say" describes, so a glance says whether Clients are recording and
  whether this is a real release.
- 2026-09-25: the DMG was a download only; now stable releases also publish it as the Homebrew cask `inkup` in
  `liatrio-labs/homebrew-tap`, so the app installs and upgrades with `brew`. The cask names no macOS floor: the app's
  (Tauri's default, 10.13) is below every macOS Homebrew supports, and Homebrew refuses a floor it has dropped.
- 2026-09-25: the app hosting did not check for updates (`ControlState.update` stayed null); now it runs the same
  daily check as the TUI and `serve`, so a window on the app's own host says when a release is out.
- 2026-09-25: pending pairing ids counted from 1 again after a network-mode restart, so a dialog left open from
  before it could answer a new request; now ids are unique for the process, and the window's link opens a connection
  per request, since a pooled one to the stopped server failed the first request after a restart.
- 2026-09-25: we hooked the DMG to dist's post-announce; an rc (inkup-v0.2.0-rc.2) skipped it because implicit
  `success()` skips on any skipped ancestor; now it runs on the tag itself, in its own workflow that waits for
  release-please's draft release, and can be dispatched for an existing tag.

## Sources

- Tauri 2 prerequisites and the tray: <https://v2.tauri.app/start/prerequisites/>, <https://v2.tauri.app/learn/system-tray/>
- `File::try_lock` (advisory, released on process exit): <https://doc.rust-lang.org/std/fs/struct.File.html#method.try_lock>
- shadcn/ui: <https://ui.shadcn.com/docs>
- 2026-09-25: the `release` environment needed a maintainer's approval for each DMG build. Now it has no required
  reviewer, because releases are automatic (ADR 0008); its tag policy alone keeps the signing secrets to release tags.
