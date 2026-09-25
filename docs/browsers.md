# Browsers

One WXT app (`extensions/web`) builds every browser. Where the browsers' APIs differ, the code goes through the
`Platform` interface in `extensions/web/src/platform/types.ts`, with one thin adapter per browser in
`platform/<browser>/`. The build picks the adapter (`platform/index.ts`, from `import.meta.env`). When a browser
can't do something, `Platform.capabilities()` reports it as missing and the UI hides the control or says why.
Nothing is left half-working.

| Build | Command | Output |
| --- | --- | --- |
| Chrome (MV3) | `pnpm build`, `pnpm zip` | `extensions/web/.output/chrome-mv3`, `…-chrome.zip` |
| Firefox (MV3) | `pnpm build:firefox`, `pnpm zip:firefox` | `extensions/web/.output/firefox-mv3`, `…-firefox.zip` (plus `…-sources.zip` for AMO: the workspace the build reads; `bash scripts/verify-sources-zip.sh` rebuilds from it) |
| Safari | see `docs/spikes/safari.md` | |

## Capability matrix

✅ works and is covered by an automated test · ☑️ works, checked by hand or not yet automated · ⚠️ works with a
limit · ❌ missing: the UI hides it or says why.

| Capability | Chrome | Firefox | How Firefox does it |
| --- | --- | --- | --- |
| Long-lived media context (mic, recorder, transcription, voice detection) | ✅ offscreen document | ✅ | `offscreen.html` in an iframe inside the background event page. The frame messages the background every 10 s, so Firefox's 30 s idle timeout never suspends it mid-Session (`tests/e2e-firefox/idle.spec.ts`) |
| Floating toolbar on the page (the main control surface) | ✅ | ✅ | The same content script. The toolbar icon toggles it; Start, Pause, Draw, Object Select, Select Text, Snap, Stop, timer, host dot, toast strip. Never in a screenshot |
| Control surface (optional panel) | ✅ side panel | ☑️ | `sidebar_action` (WXT makes it from the sidepanel entrypoint). Opened with Alt+Shift+P; the toolbar's Panel button opens it in a window, since Firefox opens the sidebar only inside a user action |
| Closing the panel stops the Session it started | ✅ | ☑️ | The same runtime Port. Manual check F2. A Session started from the toolbar does not depend on any panel |
| Screenshots | ✅ captureVisibleTab | ✅ | `tabs.captureVisibleTab`, the same API |
| Strokes, Annotations, Candidates on the page | ✅ | ✅ | The same content script |
| Tab video, Start in the panel | ✅ getDisplayMedia, tab picker | ⚠️ | `getDisplayMedia` from the panel. Firefox has no tab sharing, so the reviewer picks a window or a screen, and it can't leave the extension's own windows out. Automation can't click a picker in the panel, so that Firefox e2e runs with video off. Manual check F3 |
| Tab video, Start on the toolbar or Alt+Shift+R (`toolbarVideo`) | ✅ `tab_capture`: the tab itself, no picker, follows navigations; needs the icon click or the shortcut on that tab since it last navigated. Without that, a small picker window offers "Choose what to record" (the panel's picker; the window records the video and closes with the Session) or "Record without video" (`tests/e2e/toolbar-session.spec.ts`, ADR 0010) | ⚠️ `frame_picker` | Start is an extension frame in the toolbar; its click opens the window/screen picker and the frame records. The video ends if the tab navigates. `tests/e2e-firefox/toolbar.spec.ts`; manual check F6. See `docs/spikes/toolbar-start.md` |
| Viewport sizes from the toolbar | ✅ the frame host. No `debugger` permission, so no install warning and no debugging bar (ADR 0023) | ✅ | The same frame host: the tab reloads into our `viewport.html`, which frames the page at the size, centred, scaled to fit. The overlay runs in the frame; Snaps are the tab cropped to it. Pages that refuse framing (X-Frame-Options, CSP `frame-ancestors`) say so in the menu. `tests/e2e-firefox/viewport.spec.ts`: a Snap stands in for drawing, which Playwright's Firefox cannot do inside our page. See `docs/spikes/viewport.md` |
| Free live captions (Web Speech) | ✅ on-device, or server with the opt-in | ❌ | Firefox has no `SpeechRecognition`. The Session records audio, Strokes and screenshots without captions, logs `transcription_fallback` (`webspeech` → `none`, `speech_recognition_unsupported`), and the panel, onboarding and options say so. Onboarding hides the server-speech opt-in |
| Free captions with Whisper | ✅ | ☑️ | With no Web Speech, a downloaded Whisper model becomes the free engine. Options offers Whisper in place of Web Speech. Not run in Firefox yet: manual check F4 |
| Paid captions (Deepgram, ElevenLabs) | ✅ | ☑️ | The same WebSocket adapters. If they fall back, they go to "no captions" instead of Web Speech |
| Voice Commands | ✅ | ⚠️ | They need live captions, so they're off unless Whisper or a paid engine is transcribing |
| Process (Anthropic) | ✅ | ✅ | Same code |
| Review page, export zip | ✅ | ✅ | Same code; the zip goes through `downloads` |
| Source mapping (MAIN-world bridge: React fiber, Vue `__file`, `data-source-file`) | ✅ | ✅ | `world: 'MAIN'` content script from the manifest (Firefox 128+). The owner stack is read in either browser's frame format (`tests/e2e-firefox/source-map.spec.ts`) |
| Element crops (the Annotation's screenshot cut to its element) | ✅ | ✅ | `OffscreenCanvas` in the background page |
| Page API (`window.__inkup` on the recording tab) | ✅ | ✅ | Defined by the same MAIN-world bridge; calls cross to the overlay as JSON-string DOM events (`tests/e2e-firefox/page-api.spec.ts`) |
| Cancel (discard with Undo) and Mute | ✅ paired with the host, and a worker stopped mid-window | ✅ unpaired | The same code. The Undo deadline is kept in `storage.local` and enforced by a timer, an `alarms` alarm and a sweep on every background start, so an event page suspended or restarted inside the window still deletes the Session. Mute disables the mic track: the audio file holds silence. Firefox's fake microphone is a tone, so its e2e (`tests/e2e-firefox/cancel-mute.spec.ts`) proves the muted transcript with the scripted engine; that a spoken Voice Command is ignored while muted is proven in Chrome |
| Sessions without a microphone; Process without a model | ✅ | ✅ | The same code: "No mic" and "Turn on voice" on the toolbar, a typed note on each drawn Annotation, one Change Item per Annotation built in code when no key is set (`tests/e2e/voice-optional.spec.ts`, `tests/e2e-firefox/voice-optional.spec.ts`) |
| Comment-box dictation (auto / push) | ✅ with a live caption (Web Speech interims) | ☑️ | Needs live captions: in Firefox that is Whisper or a paid engine, which give finals only, so no live caption in the box. Without an engine the box has no mic button. The Firefox e2e drives the routing with the scripted engine |
| A hub on another computer (network mode, ADR 0006): Find hubs, address, pair link, 6-digit code | ✅ | ✅ | The same options page and background code. Find hubs probes `inkup.local` and `-2` … `-5` (the browser resolves `.local` through the OS) and saved addresses. Scan QR shows only where `BarcodeDetector` exists (Chrome on macOS, ChromeOS and Android; not Firefox, and not Chrome on Windows or Linux); with no camera it says so. `tests/e2e/network-host.spec.ts`, `tests/e2e-firefox/network-host.spec.ts`; manual check C22 |
| Keyboard shortcuts | ✅ | ☑️ | Same `commands`: Alt+Shift+R starts on the tab (or stops), Alt+Shift+P opens the sidebar. Alt+Shift+O and Alt+Shift+T (Object Select, Select Text), Alt+Shift+M (Mute), Alt+Shift+C (Clear all) and Esc are the page's own keys |

## Local network access (E14)

A Host on another computer is plain `http://` and `ws://` to a private address (`192.168.x.y`, `inkup.local`).
Chrome's Private Network Access, now Local Network Access (a permission prompt before a public or local page may
reach a more private address), could block that.

- **Observed.** In Playwright's Chromium 153, the extension's service worker opened `ws://<LAN IP>:<port>` and
  fetched `http://<LAN IP>:<port>/health` with no preflight, prompt or error, and the options page did the same
  for Find hubs. Firefox 155 did the same from its event page. Both e2e suites pass on the LAN address
  (`network-host.spec.ts`). The requests come from the extension's own origin, which holds `<all_urls>` (ADR 0003),
  not from a web page.
- **Not observed.** Branded Chrome with Local Network Access enforcement turned on by default, and a Host on a
  second machine. Manual check C22 covers both. If Chrome starts prompting, the prompt comes from the options page
  click (Find hubs or Connect), which is where the extension asks for anything it needs.
- **Manifest.** `optional_host_permissions: ['http://*/*', 'ws://*/*']` in Chrome and Firefox. `<all_urls>` already
  covers them, so nothing is asked today. The options page checks `permissions.contains` and asks with
  `permissions.request` only when they are missing, from the Find hubs or Connect click, which carries the user
  gesture Firefox needs. Safari's manifest leaves the key out; `<all_urls>` covers the LAN there.

## Firefox notes

- **Manifest.** WXT turns the side panel into `sidebar_action` and the service worker into an event page. The
  `build:manifestGenerated` hook in `wxt.config.ts` drops the `sidePanel` and `offscreen` permissions, which
  Firefox doesn't have. It also adds `browser_specific_settings.gecko`: a GUID add-on id (no domain is claimed),
  `strict_min_version` 140 (the first version that reads `data_collection_permissions`), and no data collection.
- **Event page lifetime.** Firefox suspends a background page after 30 s with no extension events, and a
  suspended page takes its media iframe with it. A Session's row would keep saying "recording" while the audio
  had stopped. The frame's 10 s keepalive message prevents this (`platform/firefox/media-frame.ts`).
- **No storage.session in the Start frame.** An extension frame inside a web page gets no `storage.session` in
  Firefox, so the toolbar's Start frame hears the Session over its Port, not by watching `activeSession` (decisions
  log, F1). After its picker it hands the keyboard back to the page.
- **No storage.session in content scripts either.** `@wxt-dev/storage` reads an item the moment it is defined, so a
  content script or the Start frame must not even import a `session:` item: those live in `src/session-state.ts`,
  and `page-storage.spec.ts` checks the built bundles (ADR 0011).
- **Mic permission.** Onboarding still asks for the mic in a visible tab. The e2e skips prompts, so whether
  Firefox lets the background page's iframe reuse that grant without a prompt is manual check F1.
- **Overlay over modal dialogs and fullscreen.** While the toolbar's Start frame records video, the overlay host
  cannot move into a page's modal dialog or fullscreen element (Firefox reloads a moved iframe in a shadow root),
  so the toolbar stays painted on top but cannot be clicked until the dialog or fullscreen ends. Sessions started
  from the sidebar are not affected (ADR 0011).
- **Drift rule.** `platform/firefox` is 85 lines, about 1% of the extension's 8.7k lines of TypeScript. It needs
  no entrypoints or UI of its own. The only Firefox-driven code outside it is the capability-based "no Web Speech"
  path (`adapters/transcription/none.ts` and three UI notes), which any browser without the API would use. So
  Firefox stays in the one app.

## Testing Firefox

`pnpm test:e2e:firefox` builds `firefox-mv3` and runs the Playwright `firefox` project (`tests/e2e-firefox`). CI
runs it in the `extension-firefox` job.

Playwright can't load a Firefox add-on, and it can't open or see `moz-extension://` pages. Evidence from
Playwright 1.63 / Firefox 155:

- Juggler: `page.goto('moz-extension://…')` times out. Firefox logs `NS_ERROR_FAILURE … removeProgressListener`
  in `chrome://juggler/content/Helper.js` when the tab switches to the extension process.
- The WebDriver BiDi channel (`channel: 'moz-firefox'`) refuses the navigation: `browsingContext.navigate:
  unsupported operation … is not allowed in this context`.
- Tabs the add-on opens itself (onboarding at install) never appear in `context.pages()`.

So the harness (`tests/e2e-firefox/fixtures.ts`, `rdp.ts`):

1. Starts Firefox with its remote debugging server.
2. Installs the build as a temporary add-on over the Remote Debugging Protocol (`installTemporaryAddon`, what
   `about:debugging` does), with the moz-extension UUID pinned by the `extensions.webextensions.uuids` pref.
3. Scripts the extension pages over RDP: evaluate, click and wait, through each tab's console actor.
4. Drives the web pages under review with Playwright as usual, so drawing uses real pointer events.

What the Firefox project covers:

- Onboarding → Start → draw on the fixture site → Stop → Process (Anthropic stub) → Export. The zip is unpacked
  and checked: `session.json` validates, `audio.webm` holds the fake mic's recording, and every screenshot that
  review.md cites is present.
- A Session with no Web Speech records without captions, and logs and shows why.
- A Session outlives a shortened event-page idle timeout. This test fails without the keepalive.

## Firefox manual checks

Run these with Firefox 140 or later. Load the build from `about:debugging` → This Firefox → Load Temporary
Add-on → `extensions/web/.output/firefox-mv3/manifest.json`. Serve the fixture site with `pnpm fixtures:serve`.

| # | Step | Expected |
| --- | --- | --- |
| F1 | On install, onboarding opens. Allow the mic and choose to remember the decision. Open the sidebar with the toolbar icon and click Start on `http://localhost:4401/pricing.html` | Recording starts with no second mic prompt, and the panel timer runs |
| F2 | While recording, close the sidebar | The Session stops and the review page opens |
| F3 | Start again and pick a window in Firefox's screen picker | The panel says video is recording. After Stop, the review page plays the recording |
| F4 | Options → Free → download Whisper base, then record a Session while talking | Captions appear after each pause. The panel names local Whisper |
| F5 | Record for over a minute in silence, then say something | The audio in the export covers the whole Session |
| F6 | On `http://localhost:4401/pricing.html`, click the toolbar icon, then Start on the page's toolbar. Pick the Firefox window in the picker | The toolbar shows the timer; draw, Stop from the toolbar: the review page plays the window's video. Start again, then click a link to `docs.html`: the toolbar comes back on the new page, recording, and says "Video ended" |
