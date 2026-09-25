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

**The desktop app embeds the host.** It builds the host's crates (`inkup-server`, `inkup-store`, `inkup-protocol`)
from `host/` and runs the same server in-process, rather than shipping the `inkup` binary as a sidecar. It has its own
cargo workspace in `apps/desktop/src-tauri`, so Tauri, WebKitGTK and GTK stay out of the host's `cargo test` and
release builds. CI runs it as a separate `desktop` job on the same three platforms. The job runs when
`apps/desktop/`, `host/`, `packages/` or the workspace's install files change (ADR 0007).

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
host asks.

**The app's own settings.** `[desktop]` in `config.toml` holds `menubar` and `dock`: whether the app shows a menu bar
(tray) icon and a Dock icon (the taskbar outside macOS). At least one stays on. Saving both off is refused, and a file
edited to both off gets the Dock back. Closing the window hides it and the app keeps hosting. Quit, in the menu bar
menu, stops the server and gives up the data dir.

**The UI is shadcn/ui only.** The window (`apps/desktop/ui`) is built from off-the-shelf shadcn/ui components added
with the shadcn CLI, and has no custom components of its own. It follows the TUI's views and words, so the two stay
recognisably the same product.

## Considered options

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
- When the app hosts, it does not check for host updates yet: `ControlState.update` is null. The notice shows only
  when a CLI host reports one.
- Release packaging is deferred. There is no signed or notarized bundle and no release workflow for the app. Builds
  are debug builds from a checkout (`pnpm desktop:build`, `pnpm desktop:app`). How the app ships, and how it relates to
  the host's own releases and self-update (ADR 0008), is decided with that work.

## Sources

- Tauri 2 prerequisites and the tray: <https://v2.tauri.app/start/prerequisites/>, <https://v2.tauri.app/learn/system-tray/>
- `File::try_lock` (advisory, released on process exit): <https://doc.rust-lang.org/std/fs/struct.File.html#method.try_lock>
- shadcn/ui: <https://ui.shadcn.com/docs>
