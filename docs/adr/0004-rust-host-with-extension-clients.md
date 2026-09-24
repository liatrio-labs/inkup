---
status: accepted
date: 2026-09-23
supersedes: the Session-ownership parts of 0001
---

# A Rust host owns storage, the Session registry and agent hand-off; browser extensions are its clients and still work alone

We want to capture reviews of native apps as well as web pages, on macOS first and then Windows and Linux, and to hand
Change Items to coding agents over MCP. A Manifest V3 extension can do neither: it cannot see outside the browser, and
it cannot listen on a port for an agent to connect to. So the backend moves into `inkup`, a cross-platform Rust app in
`host/` (a cargo workspace: `protocol`, `store`, `server`, `tui`, and the `inkup` binary). While a Client is paired, the
Host is the system of record: SQLite plus blob files in the OS data dir, the Session registry, the MCP server and the
TUI. Browser extensions become Clients. They keep capturing (Strokes, voice, video, Object Select) and running Process
in TypeScript, and they stream timeline events over a loopback WebSocket, where the Host upserts each one on its event
id. The wire contract is `packages/protocol`: Zod schemas are the source of truth, `protocol.schema.json` is generated
from them, and the Rust types are generated from that file. A shared fixture corpus must decode on both sides. (The
generated schema and the corpus now live in `contract/`; ADR 0007.)

The host is optional (graceful simplification). An extension that has never been paired stays the whole product it is
today: capture, Process with the user's own key, the review page, zip export and copied prompts. Pairing adds
capabilities: MCP watch and resolve, Resolutions shown on cards, Start and Stop from the TUI, and a durable store shared
across browsers. The Host reports what it can do in `/health` and in `welcome`. The extension gates every host feature
on one `hostCapabilities()` check, so each feature is fully present or absent and never half-works. Its outbox fills
only while it is paired. If the Host goes away mid-Session, capture carries on and the outbox drains on reconnect.
Controls that need a host are hidden or show one hint ("Pair a host to hand items to agents"), never a broken button.

There is one WXT app, `extensions/web`, that builds Chrome, Firefox and Safari. Each browser has a thin adapter behind
one `Platform` interface: the long-lived media context, the control surface, tab video and screenshots. A browser that
cannot do something (say, Safari video) reports it missing from `Platform.capabilities()` and the UI hides it, the same
way host features are gated. Drift rule: if one browser's adapter grows past a thin adapter (roughly more than 20% of
the extension's code), or needs its own entrypoints or UI, that browser moves to its own
`extensions/<browser>-extension/` folder over the shared packages, with an ADR.

## Considered options

- Keep everything in the extension and add a native-messaging helper only for OS capture: the extension would stay the
  owner, but MCP needs a listening server, and native messaging is per-browser, launched by the browser, and dies with
  it.
- A host that also runs Process and audio now: this is the end state, but it means porting working TypeScript before
  anything needs it. Process moves to Rust when OS capture needs Change Items without a browser.
- One extension project per browser: simpler at first, but the three copies would drift. The drift rule makes that split
  a decision made on evidence.

## Consequences

- ADR 0001 still holds for media inside Chrome: the offscreen document owns the mic, the side panel owns video, and
  closing the panel stops the Session. Its consequence that "Session state must be owned by the service worker" now
  means the service worker owns the live Session and its Dexie working copy. The Host owns the durable record once
  paired.
- Every event keeps its UUID and single writer (`appendEvent`), which makes replay an idempotent upsert. An event id
  arriving under a second Session is refused as a conflict.
- Two schema generators have to stay in step: `pnpm schema` (TypeScript) and the committed
  `crates/protocol/src/generated.rs` (typify). Both are guarded by tests, and CI runs cargo on macOS, Windows and Linux.
- Trust (loopback only, Host header check, pairing tokens, unauthenticated MCP) is in ADR 0005.
- A Session started from the page's floating toolbar or the shortcut (E1) is owned by the service worker alone: closing
  the panel stops only a Session the panel started, and the panel is optional in every browser (`docs/decisions-log.md`
  E1).

## Sources

- typify: <https://github.com/oxidecomputer/typify>
- Native messaging lifecycle: <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
