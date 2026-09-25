---
status: accepted
date: 2026-09-22
---

# The checks CI runs also run on the contributor's machine; dependencies are few and justified; tests run the real path on the platforms users have

InkUp is open source (MIT, `liatrio-labs/inkup`), built by people and by coding agents in parallel worktrees. The repo
has to catch the same problems locally that CI catches, keep its dependency tree small, and test on the machines its
users run.

**Hooks from one file.** `.pre-commit-config.yaml` is the single list. The root `prepare` script
(`scripts/install-hooks.mjs`) runs `pre-commit install` on `pnpm install`, wiring all three stages; it skips in CI and
warns when pre-commit is missing.

- On commit: file hygiene, gitleaks on the staged change, markdownlint, zizmor on workflows, Biome on TS and JS, and
  `cargo fmt` and clippy `-D warnings` when `host/` changed.
- On push: `pnpm typecheck`, `pnpm test`, and `cargo test` when `host/` changed. e2e stays in CI.
- On the message: commitlint with `@commitlint/config-conventional`.
- In CI: a `lint` job runs the same hooks, and gitleaks scans the whole history.

**Biome, not Prettier and ESLint**: one fast tool for format, lint and imports, with no plugin tree. Its `recommended`
rules apply except `noNonNullAssertion`. A finding that is wrong for a line is silenced on that line with a
`biome-ignore` comment giving the reason, never turned off repo-wide. The one exception is by file type: Biome does
not see an `.astro` file's template, so `noUnusedVariables` and `noUnusedImports` are off for `**/*.astro`, where
every frontmatter binding would be flagged. Biome does not format JSON (generated schemas and
fixtures keep their bytes) or CSS. **Markdown wraps at 120 columns** (`.markdownlint.yaml`); tables and code blocks may
run longer. **gitleaks** allows the tests' fake tokens by exact value, never by path. **Workflows** drop checkout
credentials and read build outputs through environment variables, never templated into shell.

**Dependencies.** Add one only with a reason the PR states, preferring what is installed. Packages whose wire details
change between minors are pinned exactly (`@deepgram/sdk`, `@elevenlabs/client`), and a package whose internals we rely
on is pinned with a test that fails when it moves (vad-web, ADR 0014). Build
workarounds live in `extensions/web/wxt.config.ts` with their reason:

- `ebml` is aliased to its UMD build, because the `browser` build ts-ebml resolves exports nothing once bundled; ts-ebml
  also needs a global `Buffer`, installed by `src/media/buffer-global.ts`.
- One ONNX Runtime wasm ships: onnxruntime-web's `new URL(…wasm, import.meta.url)` is pointed at the copy in
  `public/ort`, and vad-web's `onnxruntime-web/wasm` import is resolved to the build transformers.js pins, so the VAD and
  Whisper share one file.

**Dev overrides have no UI.** Test hooks (`devOverrides` in `storage.local`: scripted transcripts, base URLs for the
model and speech stubs, shorter timers) are set by tests through the service worker. `tests/e2e/prod-ui.spec.ts` fails
on any extension page of the built extension that mentions a stub, a base URL or localhost.

**Tests run the real path.** The e2e drives the built extension in Chrome and Firefox against the real Host binary and
local stubs, with no network. The privacy harness (`tests/e2e/helpers/network-log.ts`) attaches a second DevTools client
to every target (service worker, offscreen document, panel, pages), since Playwright's request events miss some of them,
and a positive control fails the test unless all are seen. `E2E_PORT_BASE` lets parallel checkouts run e2e side by side.

**Firefox CI looks like a desktop.** A Linux runner has no sound server and no display, which a real Firefox user has:
the job runs PulseAudio with a null sink and Firefox headed under `xvfb-run`, and builds the Host like the Chrome job.
Harness evaluations have a deadline that names the call, so a hang says where it is.

**Names.** The product is InkUp (`inkup` in identifiers) since 2026-09-24, a clean break with no migration: stored
names, the data dir, env vars, mDNS names, `inkup://` links, `window.__inkup`, the MCP server name and token prefixes
all changed with it, since v1 had not shipped. The internal `var-` CSS class prefix and `var:` Vite plugin names were
kept: renaming classes injected into pages buys nothing.

## Considered options

- Prettier and ESLint: two tools, a plugin tree, slower hooks.
- Running e2e on push: it needs a browser build and takes minutes.
- Headless Firefox with no audio device in CI: every Stop waited out a 15 s backstop and no video was recorded, which
  no user sees.
- A migration from the working title's stored names: nothing had shipped to migrate.

## Consequences

- Contributors need pre-commit installed; `pnpm install` warns when it is missing.
- CI routing by path, and the contract check, are ADR 0007. Releases are ADR 0008.

## History

- 2026-09-22 (Slice 6): a Vite plugin removed a second 27 MB copy of the transformers ORT wasm (75.8 MB → 49.0 MB).
  2026-09-22 (Slice 7): vad-web moved onto the same wasm (49.0 MB → 32.5 MB).
- 2026-09-23: Linux CI exposed four e2e failures that passed on macOS, three of them product bugs (a stale draw-mode
  push, a video shorter than its Session, a late start offset).
- 2026-09-24 (#32): renamed from the working title "Voice & Annotation Review" (`voice-review`).
- 2026-09-24 (#33): pre-commit, Biome and Conventional Commits, before the repo opened to outside contributors.
- 2026-09-24 (#34): Firefox CI on a desktop-like Linux.
- 2026-09-25 (ADR 0026): the site's `.astro` files turned off Biome's two unused-binding rules for that file type,
  since Biome reads only their frontmatter.
