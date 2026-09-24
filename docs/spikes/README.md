# Slice 0 spikes: findings

Date: 2026-09-22. Machine: macOS (arm64), installed Google Chrome 153. Automated runs use Playwright 1.63's
bundled Chromium 153.0.8010.12 (Chrome for Testing), because branded Chrome 137+ ignores `--load-extension`.

The spike code was removed in Slice 1. That covers `src/spikes/`, `src/entrypoints/spike-*/`,
`tests/e2e/spikes/` and the spike hooks in the background and side panel. Commit `23f3664` has it all.
`tests/e2e/raw-cdp.ts` was kept for hidden-page tests. The d1–d3 checks live on as
`tests/e2e/ort-assets.spec.ts`. The manual checks M1 and M2 moved to `docs/manual-checks.md`.

## Results

| # | Question | Result | Evidence |
| --- | --- | --- | --- |
| a1 | Offscreen document (reason `USER_MEDIA`) gets a mic stream after an extension-tab grant | **PASS** | `getUserMedia` ok, track "Fake Default Audio Input", live |
| a2 | `SpeechRecognition` exists in the offscreen document | **PASS** | `SpeechRecognition`, `webkitSpeechRecognition`, `available`, `install` and the `processLocally` property are all present |
| a3 | `SpeechRecognition.available({langs:['en-US'], processLocally:true})` | **Recorded** | Chromium: `"downloadable"`. With `processLocally:false`: `"available"` |
| a4 | On-device recognition of speech in the offscreen document | **NEEDS-HUMAN** | Chromium: `start(track)` errors `language-not-supported` at once. `install()` from an extension tab moves the state to `"downloading"` and never completes, even after 6 min, with or without the component updater enabled |
| b | Side panel `MediaRecorder` keeps recording while its document is hidden | **PASS** (automated proxy); real side panel NEEDS-HUMAN | Six non-empty 1 s chunks, 25.9 KB, arrived while `visibilityState` was `hidden`, with renderer backgrounding enabled |
| c | `getDisplayMedia` from a click handler after awaiting `chrome.storage` reads | **PASS** | Enforcement forced on: the call succeeds, `displaySurface: "browser"`. The same call 6 s after the click fails with `InvalidStateError ... requires transient activation`. Without enforcement the late call still succeeds |
| d1 | vad-web loads Silero v5 from bundled ORT under the MV3 CSP in the offscreen doc | **PASS** | Loaded in 270 ms. It found the three phrases of `review-scratch-that.wav`, with speech-end edges at 2.9, 6.4 and 8.7 s. Every fetch was `chrome-extension://`. No CSP violations |
| d2 | transformers.js initializes ORT from bundled files, no model download | **PASS** | `matmul` runs a small ONNX graph that ships inside transformers.js, and returns `[19,22,43,50]`. The only fetch was `/ort/ort-wasm-simd-threaded.asyncify.wasm`. No CSP violations |
| d3 | Both ORT builds in one offscreen document | **PASS** | transformers.js, then vad-web, then transformers.js again, all work |
| e | Playwright harness with fake media and auto-select flags | **PASS** | `tests/e2e/fixtures.ts`. Every spec in this table runs through it |

Conclusion for the PLAN: nothing blocks the planned architecture. The one open question is the free default
tier, a4. Web Speech `processLocally` has to be confirmed on this Mac in real Chrome. If it fails, local
Whisper becomes the free default, as the PLAN already says.

## Evidence details

**a. Offscreen probe (Chromium 153, headless).** The first line below is the raw result.

```json
{"hasSpeechRecognition":true,"hasWebkitSpeechRecognition":true,"hasAvailable":true,"hasInstall":true,
 "hasProcessLocallyProp":true,"micPermission":"prompt","getUserMedia":{"ok":true,"label":"Fake Default Audio Input"},
 "available_processLocally_true":"downloadable","available_processLocally_false":"available"}
recognize(processLocally:true): {"startedWith":"track","events":[{"t":27,"type":"error","error":"language-not-supported"}]}
install from extension tab (with activation): {"before":"downloadable","installed":"timeout after 20s","after":"downloading"}
```

- `micPermission` reads `prompt` even though `getUserMedia` succeeds. The auto-accept flag grants each request but does
  not persist a grant. Whether a real onboarding grant carries over to the offscreen document is on the manual
  checklist.
- `recognition.start(track)` accepts a `MediaStreamTrack`. So the offscreen document can feed recognition from the same
  mic stream the recorder and the VAD use.

**b. Hidden recording.** Playwright keeps every page it attaches to reporting `visible`. We tried tab switches in the
same window, separate windows, minimizing, and headed mode. So this check launches Chromium itself and drives it over
raw CDP (`tests/e2e/spikes/raw-cdp.ts`). It also leaves out Playwright's `--disable-renderer-backgrounding`,
`--disable-background-timer-throttling` and `--disable-backgrounding-occluded-windows`, so throttling matches real
Chrome.

```json
{"status":"recording","midway":"hidden","visibilityChanges":[{"t":598,"state":"hidden"},{"t":8560,"state":"visible"}],
 "chunks":7,"hiddenChunks":6,"hiddenBytes":25927,"chunkTimes":[1642,2645,3648,4654,6651,7658,9614]}
```

Chunks kept arriving at about 1 s intervals while hidden. One interval was 2 s, so chunk timing is not exact, but no
data was lost. The page went hidden before Start, when the captured tab opened in the same window, and stayed hidden for
the whole recording. A real side panel is window-scoped and stays visible across tab switches. It only disappears when
closed, and closing destroys it (ADR 0001). The case that matters most is therefore the manual one below.

**c. Activation.** Chromium 153 has the upcoming requirement as the feature `GetDisplayMediaRequiresUserActivation`,
which is off by default. The spec turns it on with `--enable-features=...` and `--enable-blink-features=...`. A handler
that awaits `chrome.storage.local.get` and `chrome.storage.session.get` still has activation when it calls
`getDisplayMedia`, because transient activation is time-based (about 5 s), not microtask-based. So Slice 4's Start
handler may await a few storage reads, but must not await anything slow, such as network or `countTokens`, before
`getDisplayMedia`.

**d. Local ORT.** Resource Timing does not list `chrome-extension://` loads. The spike offscreen document therefore
records every `fetch()` URL and every `securitypolicyviolation`.

- Negative control: transformers.js defaults set `wasmPaths` to
  `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/...`. The `.wasm` is **actually fetched
  from the CDN**, because `connect-src` is not restricted. The `.mjs` import is then blocked by `script-src`, and
  initialization fails with `no available backend found`. Always set `wasmPaths` before the first inference.
- `env.useWasmCache` works with local paths in both settings. No blob import tripped the CSP.

## Manual checklist (NEEDS-HUMAN)

> Superseded: the current procedure is in `docs/manual-checks.md`. The steps below use spike pages that
> exist only at commit `23f3664`.

Setup, once:

1. Run `pnpm install && pnpm build`, then `pnpm fixtures:serve` in a second terminal.
2. In real Chrome 153, open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and select `.output/chrome-mv3`.
3. Copy the extension ID.

**M1: on-device Web Speech in the offscreen document (a4). Also check crbug 444393111 on this Mac.**

1. Open `chrome-extension://<id>/spike-speech.html`.
2. Click "1. Grant microphone" and accept the prompt. Expect `{"ok":true,"permission":"granted"}`.
3. Click "2. Probe offscreen". Record `micPermission` (expect `granted`, which proves the onboarding grant reaches the
   offscreen document), `getUserMedia.ok` and `available_processLocally_true`.
4. If that value is `downloadable`, click "1b. Install on-device en-US" and re-probe until it reads `available`. Record
   how long it took.
5. Click "3a. Recognize 15s (processLocally: true)" and say "this button should go here, and make it smaller". Pass:
   `result` events with `final: true` and the right words, and no `error` event.
6. Turn Wi-Fi off and repeat step 5. Pass: same result, which proves recognition is really on-device.
7. Record any `language-not-supported`, `network` or `service-not-allowed` errors. Compare against crbug 444393111.
8. Optional: click "4. VAD 10s" and "5. transformers.js init" to confirm d1 and d2 in branded Chrome.

**M2: real side panel keeps recording (b) and Start has activation there (c).**

1. Open `http://localhost:4401/pricing.html`.
2. Click the toolbar icon to open the side panel, then click "Open spike: panel recorder" inside it.
3. Click Start. In the picker, choose the "Pricing Fixture" tab, then Share. Expect `status: "recording"` and
   `displaySurface: "browser"`.
4. Switch to two other tabs for about 30 s without closing the panel. Then return. Pass: `chunkCount` is close to the
   elapsed seconds.
5. Record `hiddenChunks`. For a window-scoped panel, expect 0 hidden chunks, because the panel stays visible.
6. Click Stop, then "Start after 6s delay". Record whether Chrome 153 already enforces activation by default. It does if
   you see `InvalidStateError`.

## Harness notes for later slices

- **Launch.** `tests/e2e/fixtures.ts` exports `test` and `expect` with these fixtures:
  - `context`: a persistent Chromium context with `.output/chrome-mv3` loaded, headless. Set `HEADED=1` to watch.
  - `serviceWorker` and `extensionId`.
  - `openExtensionPage(path)`: opens an extension page, such as `'sidepanel.html'`, as a tab. No API opens the docked
    side panel (Playwright #26693).
  - `site.primaryOrigin` and `site.secondOrigin`.
  - Options you can set per test with `test.use`: `fakeAudio`, which picks a WAV in `fixtures/audio` (default
    `review-scratch-that.wav`, looped); `captureSourceTitle` (default `"Pricing Fixture"`); `extraArgs`;
    `ignoreDefaultArgs`.
- **Fixture servers.** The primary origin is `http://localhost:4401` and the second is `http://127.0.0.1:4402`. Each
  Playwright worker adds `10 × parallelIndex` to both ports. Unit tests use 4501 and 4502. `pnpm fixtures:serve` honors
  `FIXTURE_PORT` and `FIXTURE_SECOND_PORT`. HTML files may use `{{PRIMARY_ORIGIN}}` and `{{SECOND_ORIGIN}}`, which the
  server replaces.
- **Do not add `--use-fake-ui-for-media-stream`.** Together with `--auto-accept-camera-and-microphone-capture` it
  crashes Chromium 153 at startup with SIGTRAP.
- **`page.evaluate` grants user activation**, because Playwright runs it with `userGesture: true`. For
  activation-sensitive code, click with a locator, then leave the page alone until the handler finishes.
- **Hidden pages** cannot be produced through Playwright. Use `RawChromium` in `tests/e2e/spikes/raw-cdp.ts`. Find our
  service worker by manifest name, because component extensions also run a `background.js`.
- **Headless tab URL patterns.** `chrome.tabs.query({url})` rejects patterns with ports. Query all tabs and filter in code.
- **Offscreen documents only have `chrome.runtime`.** Results must come back as message responses. A service worker's
  `chrome.runtime.sendMessage` reaches the offscreen document.
- **ORT asset paths.** `scripts/copy-wasm-assets.mjs` copies them into `public/`, which is git-ignored. It runs before
  every `dev`, `build` and `zip`, and on postinstall.
  - vad-web: `baseAssetPath` and `onnxWASMBasePath` are both `chrome.runtime.getURL('/vad/')`, with `model: 'v5'`. The
    directory holds `vad.worklet.bundle.min.js`, `silero_vad_v5.onnx`, `silero_vad_legacy.onnx` and
    `ort-wasm-simd-threaded.{mjs,wasm}` from onnxruntime-web **1.30.0**.
    - **Superseded in Slice 7:** `onnxWASMBasePath` is now `/ort/`. The VAD runs on the onnxruntime-web build
      transformers.js pins, so `public/vad` holds only the worklet and `silero_vad_v5.onnx`, and one 26.9 MB ORT wasm
      ships (docs/decisions-log.md Slice 7).
  - transformers.js: set
    <!-- markdownlint-disable-next-line MD013 -->
    `env.backends.onnx.wasm.wasmPaths = { mjs: getURL('/ort/ort-wasm-simd-threaded.asyncify.mjs'), wasm: getURL('/ort/ort-wasm-simd-threaded.asyncify.wasm') }`
    before the first inference. These files come from the onnxruntime-web **1.31.0-dev.20260914** build that
    transformers pins. Only the asyncify build is copied, so Slice 6 must check which files the WebGPU path needs.
- **Build size.** The build is 73 MB. Vite also emits a second 26.9 MB copy of the transformers ORT wasm under
  `assets/`, from ORT's `new URL(..., import.meta.url)`. Slice 6 or 7 should dedupe it by pointing `wasmPaths.wasm` at
  the emitted asset or by excluding it. Slice 6 removed the `assets/` copy (49 MB). Slice 7 moved the VAD onto the same
  ORT build and dropped the unused legacy Silero model (32.5 MB).

## Deviations and versions

| Item | PLAN | Installed | Note |
| --- | --- | --- | --- |
| WXT | 0.21.4 | 0.21.4 | — |
| @playwright/test | 1.63.0 | 1.63.0 | Bundled Chromium 153.0.8010.12 |
| @ricky0123/vad-web | 0.0.31 | 0.0.31 | Peer `onnxruntime-web` resolves to 1.30.0; since Slice 7 the build resolves its import to transformers' 1.31.0-dev |
| @huggingface/transformers | 4.3.0 | 4.3.0 | Pins onnxruntime-web 1.31.0-dev.20260914 |
| Vitest | unversioned | 5.0.1 | — |
| TypeScript | unversioned | 7.0.2 | The native compiler. `tsc --noEmit` works with WXT's generated tsconfig |
| React / Tailwind | 19 / v4 | 19.3.0 / 4.3.3 | — |
| pnpm / Node | — | 12.4.2 / 26.9.0 | `scripts/*.ts` run on Node's built-in type stripping |

Other deviations:

- **Slice 0 scope.** The spikes live in the real scaffold, not in a separate throwaway extension. They are isolated in
  `spike-*` entrypoints so Slice 1 can delete them.
- **`public/ort` and `public/vad` are generated, not committed.** They are about 45 MB of copies from `node_modules`,
  and generating them keeps them locked to the installed versions.
- **Fixture WAVs are committed**, about 820 KB in total. Tests stay deterministic on machines without macOS `say` or
  with different voices. `pnpm fixtures:audio` regenerates them.
- **shadcn/ui was set up by hand.** The CLI cannot detect WXT. `components.json` points at `src/assets/tailwind.css`.
  The root `tsconfig.json` declares `paths` for `@/*` itself. Without that, the CLI resolves WXT's `../src` relative to
  the repo root and writes outside the repo. Even with the fix, `shadcn add` still writes `import { cn } from "cn"`.
  After every `shadcn add`, change that import to `@/lib/utils` and check that no `cn` package was added to
  `package.json`.
- **PLAN libraries not yet installed.** @webext-core/messaging, @wxt-dev/storage, Dexie, Zod and the others start in the
  slices that use them. Slice 0 uses plain `chrome.runtime` messages in its spike code only.

Dependencies not listed in the PLAN:

- `onnxruntime-web` (direct dependency): vad-web's peer dependency. Declaring it pins the version that the copy script bundles.
- `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `radix-ui`, `tw-animate-css`: shadcn/ui's own dependencies.
- `@tailwindcss/vite`: the Tailwind v4 Vite plugin.
- `@types/chrome`: types for `chrome.offscreen`, `chrome.sidePanel` and `chrome.runtime.getContexts`.
- `@types/node`: types for the test and script code.
- `happy-dom`: the Vitest environment the PLAN names.
- `@wxt-dev/module-react`: WXT's React integration.

## Proof commands

```sh
pnpm typecheck   # tsc --noEmit: clean
pnpm test        # Vitest: 3 files, 8 tests passed
pnpm build       # wxt build: chrome-mv3, 73.5 MB
pnpm test:e2e    # build + Playwright: 12 passed, 1 skipped (a4, NEEDS-HUMAN)
```
