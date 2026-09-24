# Implementation plan: InkUp (PRD v0.3)

## Context

The repo holds only the PRD (`docs/PRD.md`), glossary (`CONTEXT.md`) and three ADRs (`docs/adr/0001–0003`). No code
exists. This plan turns the PRD's 15 P0 requirements into thin, end-to-end slices, each ending in a runnable proof on
sample data (TVP rule, global CLAUDE.md). The PRD requires off-the-shelf libraries everywhere possible; every library
below was checked on 2026-09-22 against npm (version, release date, weekly downloads), GitHub activity and official
docs. Custom code is limited to the product's novel logic plus a few spots where no maintained library exists, each
justified.

Deviation from the PRD phase order: **Process (LLM → Change Items) moves to slice 2**, so slice 2 is the first to
deliver the core value end to end. Shape recognition and voice commands widen it in slice 3.

## Framework and libraries (researched 2026-09-22)

| Concern | Library (version, date) | Notes / why not the alternative |
| --- | --- | --- |
| Extension framework | **WXT** 0.21.4 (2026-08-11) | Sidepanel entrypoint, unlisted pages (offscreen, onboarding, review), `createShadowRootUi`, `wxt zip`/`submit`, Firefox output, Playwright guide. Plasmo is unmaintained (no release since 2025-05). |
| Cross-context messaging | **@webext-core/messaging** 4.0.0 (2026-07) | Typed ProtocolMap across SW, offscreen, side panel, pages, content scripts. webext-bridge unmaintained since 2023. Blobs never go over messages; they go through Dexie (shared `chrome-extension://` origin). |
| Settings / small state | **@wxt-dev/storage** 1.2.9 | Typed items, `local:` area for keys, `watch()` for cross-context updates. Zustand only for per-page UI state if needed; the chrome-storage sync libs for Zustand are dead. |
| Large data | **Dexie** 4.4.6 + **dexie-react-hooks** 4.4.0 | Audio/video chunks, screenshots, events. `useLiveQuery` updates the panel and review page across contexts. |
| Schemas | **Zod** v4 | Session timeline, Change Items, LLM output. |
| LLM | **@anthropic-ai/sdk** 0.128.0 (2026-09-22) | Runs in the SW with `dangerouslyAllowBrowser`. Structured outputs via `messages.parse` + `zodOutputFormat` (GA; replaces forced tool-use). `messages.countTokens` for the cost estimate. |
| Cost table | hardcoded `PRICES` map, dated, cited | The only maintained price lib (@pydantic/genai-prices) is 2.1 MB for a handful of models. |
| UI | React 19, Tailwind v4, **shadcn/ui**, **sonner** 2.0.8 (toasts) | Side panel and pages are ordinary extension pages. |
| Item reorder | **@dnd-kit/react** 0.5.0 (2026-06) | The `@dnd-kit/core` line has had no release since 2024. Runner-up pragmatic-drag-and-drop. |
| Video playback | native `<video>` | Seek = `currentTime`. vidstack is being folded into Video.js v10 (RC); revisit after GA. |
| Freehand strokes | **perfect-freehand** 1.2.3 + canvas 2D | Konva/fabric add a scene graph fading ink does not need. Same outline reused as SVG on the review page. |
| Content-script UI | WXT `createShadowRootUi` | Canvas in a shadow root. |
| CSS selectors | **css-selector-generator** 3.9.4 (2026-08) | Blacklist regexes for CSS-module hashes and Tailwind utilities; prefer `data-testid`/`id`/role. @medv/finder unmaintained since 2024-12. |
| Accessible name/role | **dom-accessibility-api** 0.7.1 | `computeAccessibleName`, `getRole` for Candidates. |
| Mic recording | native `MediaRecorder` + **fix-webm-duration** (audio) + **ts-ebml** 3.0.2 `makeMetadataSeekable` (video) | Chunked WebM lacks duration/cues (Chromium 40482588, open). Video needs cues for seek-to-item. RecordRTC unmaintained. |
| Silence / VAD | **@ricky0123/vad-web** 0.0.31 (Silero v5, ORT wasm bundled locally) | Needed for Voice Command silence gaps on every tier, and for segmenting local Whisper. Requires `'wasm-unsafe-eval'` CSP and local `baseAssetPath`/`onnxWASMBasePath`. hark unmaintained since 2018. |
| Resampling to 16 kHz PCM16 | `new AudioContext({sampleRate:16000})` + ~20-line Float32→Int16 AudioWorklet | Chrome resamples natively; no library needed. |
| Free STT (default) | Web Speech API directly (`processLocally`, `available()`, `install()`) | No wrapper supports on-device APIs; react-speech-recognition adds nothing in an offscreen doc. |
| Free STT (alternate) | **@huggingface/transformers** 4.3.0 (2026-09-16) | `whisper-base_timestamped` q8 (~77 MB) default, `whisper-large-v3-turbo_timestamped` q4 (~760 MB) opt-in on WebGPU; `return_timestamps:'word'`. Bundle ORT wasm/mjs locally (issue #1248); weights download from HF and cache. Runs per VAD segment. |
| Better STT | **@deepgram/sdk** 5.12.0 (2026-09-21) | Browser WebSocket streaming, Nova-3, word timestamps. User key via temporary JWT (`/v1/auth/grant`, `ttl_seconds`) minted in the offscreen doc. |
| Best STT | **@elevenlabs/client** 1.25.0 `Scribe` | Manual audio mode fed our PCM16; single-use token from `POST /v1/single-use-token/realtime_scribe`; `include_timestamps` for words. |
| Voice Command matching | **fuzzball** 2.2.6 + **double-metaphone** 2.0.1 + **compromise** 14.17 | Token-set ratio over a sliding word window, phonetic fallback, number normalization. No dedicated command-spotting lib exists. |
| Zip export | **client-zip** 2.5.1 (2026-09) | Streaming, Zip64, no recompression of WebM. Built in the review page; `URL.createObjectURL` is unavailable in SWs (Chromium 40876652). JSZip holds 300 MB in memory. |
| E2E testing | **@playwright/test** 1.63.0 | Persistent context with `--load-extension`; flags verified in Chromium source: `--use-fake-device-for-media-stream`, `--use-file-for-fake-audio-capture`, `--auto-accept-camera-and-microphone-capture`, `--auto-select-tab-capture-source-by-title`. No API to open the docked side panel (Playwright #26693): tests open `sidepanel.html` as a tab. |
| Unit testing | **Vitest** + happy-dom | `src/core` only. |

### Custom code, and why

- Session clock, Annotation grouping, Candidate ranking, prompt builder, windowing/merge, `review.md` renderer: the
  product's novel logic.
- **Shape classifier** (~200 lines, rules-based: closed loop → circle, flat low-deviation → underline, long segment +
  terminal V → arrow, high path-length/area + many turns → scribble). Every $1/$P npm package is unmaintained
  (2015–2018); fallback is vendoring the UW $P reference.
- **Region → elements**: `elementsFromPoint` on an ~8×8 grid over the Annotation box, overlay excluded. rrweb-snapshot
  is overkill.
- **Web Speech adapter** (~60 lines), **PCM worklet** (~20 lines), **hover highlight** (P1, one positioned div).

## Repo layout

```text
src/
  core/            # pure TS, no chrome.*, no DOM: clock, timeline schema, grouping, candidates (ranks rect data),
                   # shapes, voice-commands, process/ (prompt, pairing, merge, cost, ChangeItem), export/ (markdown, manifest)
  adapters/
    transcription/ # types.ts (start(stream) → AsyncIterable<Segment>) + webspeech | whisper | deepgram | elevenlabs | scripted
    llm/           # types.ts + anthropic.ts
  db/              # Dexie schema: sessions, events, blobs
  messaging.ts     # @webext-core/messaging ProtocolMap
  entrypoints/     # WXT: background.ts, offscreen/, sidepanel/, content/, onboarding/, options/, review/, sessions/
public/ort/, public/vad/   # locally bundled ORT wasm/mjs and Silero model (MV3 forbids remote code)
fixtures/
  site/            # static sample site: /pricing with hero CTA inside a card, header nav with "Docs",
                   # two cards for "same height as that", a cross-origin iframe, a link to a second origin
  audio/           # WAVs from macOS `say` + `afconvert` (generation script checked in), with silence gaps
  sessions/        # hand-authored session.json fixtures (a)–(d), each in word + approximate modes
tests/unit/  tests/e2e/  tests/eval/
contract/  docs/spikes/
```

Rule: `src/core` never imports `chrome.*` or touches the DOM. The content script snapshots element data (rect, tag,
role, name, selector) into plain objects; core ranks them.

Manifest (in `wxt.config.ts`): permissions `sidePanel`, `offscreen`, `storage`, `unlimitedStorage`, `downloads`, `tabs`;
host `<all_urls>`; `commands` for `Alt+Shift+R` / `Alt+Shift+D`; CSP
`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.

## Slices

One worker per slice (CLAUDE.md cw-workflow guidance). Sequential, except 5 ∥ 6.

### Slice 0 — Spikes (1–2 days)

Throwaway WXT extension; findings in `docs/spikes/README.md`.

1. Web Speech `processLocally` in the offscreen doc after an onboarding-tab mic grant (check crbug 444393111 on this
   Mac). If it fails, local Whisper becomes the free default.
2. Side panel `MediaRecorder` keeps recording while hidden on another tab.
3. `getDisplayMedia` from the panel Start click still has activation after awaiting storage reads.
4. vad-web + transformers.js load from bundled ORT files under the MV3 CSP in the offscreen doc.
5. Playwright launch config with the fake-media and auto-select flags.
**Proof:** pass/fail table plus a working `tests/e2e/fixtures.ts`.
**Status (2026-09-22): done.** Findings in `docs/spikes/README.md`. The spike code was removed in Slice 1, and its ORT
checks live on in `ort-assets.spec`.

### Slice 1 — Capture spine (thinnest end-to-end)

P0-1 (Start/Stop/timer), P0-2 (toggle + fade), P0-3 (time gap only), P0-4 (geometric Candidates, region fallback), P0-6
(screenshot on Annotation close), P0-7 (free tier), P0-9, P0-14 manifest, onboarding mic grant.

- WXT scaffold, messaging ProtocolMap, Dexie schema, `@wxt-dev/storage` settings.
- Background owns t0 and the event log; offscreen runs mic → MediaRecorder (30s chunks → Dexie) + Web Speech adapter →
  captions via `useLiveQuery` in the panel.
- Content: shadow-root canvas with perfect-freehand; Candidates via grid sampling + css-selector-generator + dom-accessibility-api.
- Stop → review page stub with "Download session.json".
**Proof:** `pnpm test:e2e capture` on `fixtures/site/pricing` with the scripted transcript adapter: draw around the CTA,
Stop, download; assert schema-valid JSON, geometric pick `button.cta`, screenshot present, transcript within 2s of the
Annotation. Plus a manual real-Chrome run with real Web Speech.
**Status (2026-09-22): done.** `capture.spec` and `inject.spec` pass. The manual runs are C1, C1b and C2 in
`docs/manual-checks.md`. The free tier is on-device only unless the reviewer opts in to server speech.

### Slice 2 — Process: Change Items (core value)

P0-11 (without pins/discards), P0-12 read-only, P0-14 processing settings, P0-15 Anthropic notice.

- `core/process`: ChangeItem Zod schema, prompt builder (PRD §7 script), 2s/4s pairing window, noun table, cost from
  `countTokens` × `PRICES`.
- `llm/anthropic`: `messages.parse` + `zodOutputFormat`; low-confidence (<0.6) second pass with screenshots.
- Options page (key, Process model `claude-sonnet-5`, Draft model, Test). Review page: Process button with estimate,
  items with "check me" badges sorted first, screenshot with SVG stroke overlay.
**Proof:** `pnpm eval` (key in `.env`, backed up via the secrets-backup skill) runs fixtures (a), (b), (d) × both
timestamp modes against the live API, asserting category, Location roles and selectors. Unit snapshot tests for the
prompt builder.
**Status (2026-09-22): done.** Prompt snapshots, adapter tests and `process.spec` pass against a local Anthropic stub.
`pnpm eval` is key-gated and skips cleanly without a key. Manual check C3.

### Slice 3 — Understanding signals

P0-3 full, P0-8, remaining P0-6 triggers, P0-2 re-injection, pause/resume, `tab_switch`.

- Shape classifier + Connector endpoints; grouping closes on scroll >25%, navigation, Speech Boundary, draw toggle, `next`.
- vad-web in offscreen emits speech/silence edges; command matcher (fuzzball + double-metaphone + compromise) requires
  silence on both sides; commands stripped from Process input; sonner "Paused by voice, undo?".
- Screenshots on click, navigation, `snap`, panel Snap; 500ms debounce; content script re-injected per navigation.
**Proof:** unit tests on recorded stroke fixtures and synthetic VAD traces; `pnpm eval` adds fixture (c); e2e plays a
fake-mic WAV with "scratch that" between silences and asserts the discard; a cross-origin navigation keeps drawing and
screenshots working.
**Status (2026-09-22): done.** The shape classifier runs on recorded Strokes. Voice Commands are VAD-gated and proven on
a spoken fixture, and navigation is proven across two origins. Fixture (c) was added. Manual checks C4 and C5.

### Slice 4 — Video, evidence, editing, export

P0-5, P0-12 full, P0-13, close-panel = Stop.

- Panel `getDisplayMedia` (1280w/15fps) → MediaRecorder → Dexie; cancel → "video off"; panel `pagehide`/port disconnect
  → background Stop; ts-ebml makes the final WebM seekable.
- Review page: `<video>` seek per item, textarea-per-segment transcript editing + re-Process, @dnd-kit/react reorder,
  edit/merge/split/delete (logged), copy prompt(s).
- Export via client-zip in the review page → object URL → `chrome.downloads`; offer to drop media.
**Proof:** e2e with `--auto-select-tab-capture-source-by-title`: Session → Process → Export; unzip and assert the file
set, every `agent_prompt` screenshot path exists, video is seekable with duration ≈ Session length, and closing the
panel tab finalized the Session.
**Status (2026-09-22): done.** `export.spec` unzips the export and checks the file set and a seekable video. Editing is
driven through the review page. Manual checks C6 and C7.

### Slice 5 — Live Draft Items (parallel with 6)

P0-10 and pins/discards in P0-11. Haiku (`claude-haiku-4-5-20251001`) pass on Annotation close + 3s silence and a 30s
fallback; cards with discard/pin by click or voice; Process keeps pins fixed and treats discards as negatives; no-key
mode shows Annotation cards.
**Proof:** e2e with key: scripted Session yields a Draft card, "pin that" pins it, Process output contains it with
`pinned: true`.
**Status (2026-09-22): done.** `drafts.spec` pins a draft by voice and discards one by click, and the pin survives
Process. Manual check C8.

### Slice 6 — Transcription tiers (parallel with 5)

P0-7 full, P0-15 vendor notices. PCM16 worklet feeds Deepgram SDK and ElevenLabs Scribe (manual audio); tokens minted in
offscreen from stored keys; 3× backoff then fallback + `transcription_fallback`; transformers.js Whisper on VAD segments
with model picker and download status; options tier selector; re-transcribe from the review page.
**Proof:** `pnpm eval:stt` streams fixture WAVs through each keyed adapter, asserting WER under a threshold and
monotonic word timestamps; a unit test forces socket close and asserts fallback.
**Status (2026-09-22): done.** Deepgram and ElevenLabs run against local stubs and fall back after four drops. Whisper
runs per VAD span, and the review page can re-transcribe. `pnpm eval:stt` is key-gated. `pnpm test:e2e:whisper` is
opt-in and needs the network. Manual checks C9 and C10.

### Slice 7 — Hardening and release

Session list grouped by origin with sizes, delete, 80% quota warning (`navigator.storage.estimate`); 45/60-min warnings;
~10-min windowing + merge; iframe region fallback; privacy e2e (free tier, no key → zero requests beyond the fixture
site); keys absent from exports; `wxt zip` for unlisted CWS.
**Proof:** a synthetic 40-minute Session processes without truncation; privacy and export-secret tests green.
**Status (2026-09-22): done.** Shipped: the Session list with delete and the 80% warning, and the 45 and 60 minute
warnings. Process runs in 10-minute windows with overlap and merge, and the synthetic 40-minute Session accounts for
every live Annotation. Also shipped: the iframe region fallback, the privacy e2e over every extension context,
`pnpm metrics`, one ORT wasm for a 32.5 MB build, `pnpm zip` and the README. Manual checks C11 to C14. Still open: there
is no recovery UI for a Session interrupted by a crash. Its audio chunks stay in IndexedDB, and the Session list shows
it as interrupted.

## Testing strategy

- **Unit (Vitest):** all of `src/core`.
- **E2E (Playwright, real extension):** real SW, offscreen, content script, Dexie, screenshots and video with fake
  media. CI uses the `scripted` STT adapter because headless Chromium lacks the on-device language pack;
  `pnpm test:e2e:real` reruns capture against installed Chrome with real Web Speech.
- **Eval (live APIs, key-gated):** `pnpm eval`, `pnpm eval:stt`; not in CI by default.

## Verification (end to end)

1. `pnpm install && pnpm test` — unit suite green.
2. `pnpm test:e2e` — capture, process (with key), voice commands, video/export, privacy suites green.
3. `pnpm eval` — fixtures (a)–(d) × 2 modes meet PRD targets (≥90% word, ≥80% approximate).
4. Manual: `pnpm dev`, load in Chrome, review `fixtures/site` for 2 minutes with circles, an arrow, "scratch that" and a
   tab switch; Stop, Process, Export; paste "Copy all prompts" into a Claude Code session opened in the unzipped folder
   and confirm it can open the cited screenshots.
