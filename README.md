# InkUp

A browser extension (Manifest V3; Chrome, Firefox and Safari from one codebase) for reviewing a web page out loud. You
talk and draw on the page. It turns the Session into a list of located Change Items that a person or a coding agent can
act on. Each item names its element, carries a screenshot and a transcript excerpt, and says what should change.

- **Capture.** Click the extension's icon and a floating toolbar appears on the page: Start, Pause, Draw, Snap,
  Stop and a timer. Alt+Shift+R starts a Session straight away. The extension records your microphone, the tab's
  video where the browser allows it, a live transcript, every Stroke you draw and the page elements under it. The
  toolbar never shows in screenshots. The side panel (Alt+Shift+P, or Panel on the toolbar) has the same controls
  plus captions, cards and past Sessions, and is optional.
- **Object Select and Select Text.** Instead of drawing, pick one element exactly (Object Select, Alt+Shift+O: hover,
  ↑/↓ for its parent, click) and type what should change in the box next to it, or just say it. Or turn on Select
  Text (the caret icon, Alt+Shift+T) and select text to comment on it. The page is never modified. Draw, Object
  Select and Select Text are one at a time; Esc turns them off.
- **Viewport sizes.** Viewport on the toolbar resizes the page to a phone, tablet or desktop size, to the tab, to a
  typed W×H or by dragging its edge. Media queries follow, and the Annotations, screenshots and Change Items say
  the size (`docs/spikes/viewport.md`). The page reloads into a frame of that size in the tab; sites that refuse
  being framed say so.
- **Process.** After Stop, the review page sends a text script of the Session to Claude and gets back Change Items.
  With an Anthropic key, Draft Items also appear in the panel while you talk.
- **Review and export.** Edit, reorder and delete items, then export a zip with `session.json`, the screenshots and
  an agent prompt.
- **Local first.** Sessions stay in the browser's IndexedDB until you delete them. The free tier sends nothing
  anywhere. Paid transcription (Deepgram, ElevenLabs) and Process (Anthropic) use keys you enter in Settings.

The product requirements are in `docs/PRD.md`. The vocabulary (Session, Stroke, Annotation, Candidate, Change Item,
Draft Item, Voice Command, …) is defined in `CONTEXT.md`, and the code uses those terms.

## Install (unpacked)

You need Node 22.18 or later (the scripts run TypeScript directly), pnpm 10 or later and Chrome 153 or later.

```sh
pnpm install     # also copies the ONNX Runtime and VAD wasm files into extensions/web/public/
pnpm zip         # builds and writes extensions/web/.output/inkup-<version>-chrome.zip
```

To load it, open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick
`extensions/web/.output/chrome-mv3`. To install from the zip, unzip it first and load the folder the same way. The
onboarding tab opens on install and asks for the microphone. Then open a page, click the extension's icon to show the
toolbar, and click Start.

## The host and the desktop app

The extension works alone. Pair it with a host to keep Sessions in one store across browsers and to hand Change
Items to coding agents over MCP (`docs/adr/0004-rust-host-with-extension-clients.md`). There are three ways to run
the host, and all three are the same server on the same data dir:

| Run | What you get |
| --- | --- |
| `inkup` | The TUI in a terminal: Clients, Sessions, Timeline, Items, Agents and Tokens, with pairing asked there |
| `inkup serve` | The server with no UI, for scripts and services. Pairing is asked on the terminal |
| The desktop app (`apps/desktop`) | The same six views in a window, plus a menu bar and Dock icon. Pairing is asked in the window |

Only one host runs per data dir. The first one takes the lock and writes `host.json` with its port. What starts
second depends on what it is (`docs/adr/0025-desktop-app-host-lock-and-control-api.md`):

- A second `inkup` or `inkup serve` says which host is running and exits 1. If the running host is the desktop app,
  the app's window also comes forward.
- The desktop app next to `inkup` or `inkup serve` becomes their window: it shows that host and drives it. It never
  takes over on its own. When that host stops, the window says so, and **Host here** makes the app the host.
- A second desktop app brings the first one's window forward and exits.

The app is a prototype and has no release build yet. To run it from a checkout:

```sh
pnpm desktop:dev                                   # the app with hot reload for its UI, on your data dir
pnpm desktop:app                                   # macOS: a debug InkUp.app in apps/desktop/src-tauri/target/debug/bundle/macos/
pnpm desktop:build                                 # any OS: a debug build, apps/desktop/src-tauri/target/debug/inkup-desktop
```

Closing the window hides it, and the app keeps hosting. **Quit InkUp** in the menu bar menu stops it. **Show in Menu
Bar** and **Show in Dock**, in the menu and in the window's header, choose where its icons show. One of them always
stays on. Both are saved under `[desktop]` in `config.toml` in the data dir.

## Develop

The repo is a pnpm workspace:

| Path | What it is |
| --- | --- |
| `packages/core` | `@inkup/core`: the pure TypeScript domain (timeline, grouping, shapes, Candidates, Process, export, the Zod schemas). No browser APIs, no DOM |
| `extensions/web` | The WXT extension (package `inkup`). Browser-specific calls sit behind `src/platform` |
| `packages/protocol` | `@inkup/protocol`: the Zod schemas of the host's wire protocol and its control API |
| `host/` | The Rust host (a cargo workspace): the `inkup` binary, its server, store and TUI |
| `apps/desktop` | The Tauri desktop app: a React and shadcn/ui window in `ui/`, and its own cargo workspace in `src-tauri/` that builds the host's crates |
| `scripts/`, `fixtures/`, `tests/e2e`, `tests/support` | Repo-level scripts, the fixture site and data, the Playwright e2e and shared test stubs |
| `docs/` | PRD, plan, ADRs, the generated `session.json` schema |

Run every command from the repo root; the extension's commands delegate to `extensions/web`. To run one package on
its own, use `pnpm -C packages/core test` or `pnpm -C extensions/web test`.

| Command | What it does |
| --- | --- |
| `pnpm dev` | WXT dev server with a Chrome profile and hot reload |
| `pnpm build` | Production build into `extensions/web/.output/chrome-mv3` |
| `pnpm zip` | Production build, then the store zip in `extensions/web/.output/` |
| `pnpm build:safari` | Safari MV3 build into `extensions/web/.output/safari-mv3` (docs/spikes/safari.md; manual checks S1–S4) |
| `pnpm safari:xcode` | Safari build, then regenerates the Xcode wrapper app in `extensions/web/safari-xcode/` |
| `pnpm build:firefox`, `pnpm zip:firefox` | The same for Firefox (`firefox-mv3`). What each browser can do is in `docs/browsers.md` |
| `pnpm typecheck` | `tsc --noEmit` in each package, then the repo-level scripts and tests |
| `pnpm fixtures:serve` | The fixture site on `http://localhost:4401` and `http://127.0.0.1:4402` |
| `pnpm schema` | Regenerates the Session, wire protocol and control API JSON Schemas in `contract/` |
| `pnpm host:build` | The `inkup` host, a debug build in `host/target/debug/inkup` |
| `pnpm desktop:dev`, `pnpm desktop:build`, `pnpm desktop:app` | The desktop app: dev with hot reload, a debug build, or a debug `InkUp.app` on macOS |
| `pnpm validate:session <file>` | Validates an exported `session.json` against the schema |
| `pnpm metrics <dir>` | PRD §8 metrics over a folder of exported `session.json` files |
| `pnpm fixtures:sessions` | Regenerates the Process fixtures in `fixtures/sessions/` |
| `pnpm fixtures:long [out] [minutes]` | Writes a synthetic 40-minute Session for the long-Session proof |

## Test

| Command | What it runs |
| --- | --- |
| `pnpm test` | Vitest unit and adapter tests across `packages/core`, `extensions/web`, the desktop app's UI and the repo, with stand-in models and stub servers |
| `pnpm test:e2e` | Builds, then Playwright in headless Chromium with the extension loaded, fake media and local stubs for every vendor |
| `pnpm test:e2e:firefox` | Builds the Firefox add-on and runs `tests/e2e-firefox` in Playwright's Firefox (the add-on is installed over Firefox's remote debugging protocol) |
| `pnpm test:e2e:whisper` | The local Whisper e2e, which downloads a real model from Hugging Face |
| `pnpm eval` | The live Process eval against the Anthropic API |
| `pnpm eval:stt` | The live transcription eval against Deepgram and ElevenLabs |

`pnpm test` and `pnpm test:e2e` need no keys and make no calls outside the machine. Each eval skips cleanly when
its key is missing. To run e2e in two checkouts at once, give one of them another port range with
`E2E_PORT_BASE=5401` (the default is 4401).

### Keys for the evals

The evals read keys from a `.env` file in the repo root, which git ignores. The extension itself never reads
`.env`: in the extension, keys are entered in Settings and kept in `chrome.storage.local`.

```sh
ANTHROPIC_API_KEY=...     # pnpm eval
EVAL_MODEL=...            # optional, defaults to the Process model
DEEPGRAM_API_KEY=...      # pnpm eval:stt
ELEVENLABS_API_KEY=...    # pnpm eval:stt
```

Evals call real services and cost money.

## Manual checks

Automation cannot show a real side panel, a real permission prompt, on-device speech, or click the extension's
icon. Before a release, run the ordered checklist in `docs/manual-checks.md` in installed Chrome.

## Architecture

- `docs/PLAN.md` covers the framework choices, the repo layout, the slices and the testing strategy.
- `docs/adr/` records the decisions that still govern the code, from media ownership and the Host's trust model to
  the Process pipeline and the review page. `docs/adr/README.md` indexes them and says when to write or revise one.
- `docs/spikes/` records what was tried and measured before building: Slice 0, Safari, and how a Session started
  from the toolbar gets video (`toolbar-start.md`), and how the toolbar resizes the page's viewport
  (`viewport.md`).
- `packages/core` (`@inkup/core`) is pure TypeScript with no browser or vendor imports: the Session clock, the event
  log, grouping, Candidates, the Process script and windows, merging, and metrics.
- In `extensions/web/src`, `adapters` wraps each vendor and `platform` wraps the browser-specific seams (the
  media context, the control surface, the panel's Port, tab video, screenshots) behind one `Platform` interface,
  with one adapter per browser (`docs/browsers.md`). The entrypoints in `entrypoints` are the service worker, the
  offscreen document, the content script (the drawing overlay and the floating toolbar, `src/content`), the
  toolbar's Start frame, and the side panel, options, onboarding, review and Sessions pages.

## Contributing and license

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md), and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities privately.

InkUp is released under the [MIT License](LICENSE). Copyright (c) 2026 Liatrio, Inc.
