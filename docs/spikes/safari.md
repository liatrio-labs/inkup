# S1 spike: the Safari target

Date: 2026-09-23. Machine: macOS 26.6.2 (arm64), Safari 27.0, Xcode 27.0 (27A266a). WXT 0.21.4.

Nothing here ran inside Safari. Playwright's WebKit cannot load extensions, and loading an unsigned extension
needs a person to authenticate in Safari's Developer settings. So each seam below is settled from three kinds of
evidence, and says which:

- **compat**: MDN browser-compat-data 8.1.2 (2026-09-17), the data behind MDN's extension compatibility tables.
- **source**: WebKit `main` on GitHub (2026-09-23). Safari's extension runtime is WebKit's `WK_WEB_EXTENSIONS`
  code, so its rules are readable there. Code on `main` can be newer than the shipping Safari; that is called out.
- **built**: something run on this Mac: `wxt build -b safari --mv3`, `safari-web-extension-converter`,
  `xcodebuild`, the unit tests.

What only a person in Safari can confirm is the "Safari" section of `docs/manual-checks.md` (S1–S4).

## Results

| Seam | Result | Evidence |
| --- | --- | --- |
| Long-lived media context | **No hidden context can hold the mic. The adapter uses a small visible extension window** | source, below |
| Microphone permission from an extension page | **Prompts in a visible extension page; parked forever in a hidden one** | source |
| `webkitSpeechRecognition` | **Present, needs a visible page; no `available()`/`install()`, so the free tier runs without captions by default** | compat, source |
| `getDisplayMedia` from an extension page | **Present, needs a click; Safari's picker offers windows and screens, never a single tab** | compat, source; NEEDS-HUMAN (S3) |
| `tabs.captureVisibleTab` | **Supported** (Safari 14). Host access is granted by the user per site | compat, Apple docs |
| Side panel / sidebar | **Absent.** `sidePanel`, `side_panel` and `sidebar_action` are unsupported. The panel page opens in a popup window | compat, source |
| Content-script shadow-DOM overlay | **Supported.** `attachShadow`, pointer capture and `getCoalescedEvents` (feature-detected) are all in Safari | compat |
| `downloads` API | **Absent.** Export saves through a download link | compat |
| MV3 background | **Service worker** (Safari 15.4+), as in Chrome. `storage.session` since 16.4 | compat, built |
| `offscreen` API | **Not in Safari 27.0.** Enabled on WebKit `main` on 2026-08-28, and would not help: its view is hidden | source |
| MediaRecorder WebM (audio and video) | **Supported since Safari 18.4** (Opus, VP8/VP9) | WebKit release notes |
| Build and wrapper app | **PASS.** `pnpm build:safari` and an unsigned `xcodebuild` Debug build | built |

### The Safari column for the capability matrix

The seam table in the plan, with Safari's answers:

| Seam | Chrome | Safari (this spike) |
| --- | --- | --- |
| Long-lived media context (mic, speech-to-text, voice detection) | offscreen document | `offscreen.html` in a small, focused extension window opened at Start and closed at Stop |
| Control surface | sidePanel | `sidepanel.html` in a popup window beside the reviewed window, opened from the page toolbar's Panel button or Alt+Shift+P (since E1 the toolbar icon shows the page toolbar) |
| Tab video | getDisplayMedia (tab picker) | getDisplayMedia from the panel window's Start click; the reviewer picks the Safari **window** (no tab surface) |
| Screenshots | captureVisibleTab | captureVisibleTab |
| Saving the export and session.json | downloads API | `<a download>` from the review page; no completion state |

`safariPlatform.capabilities()` reports
`{ mediaContext: true, controlSurface: true, tabVideo: <getDisplayMedia exists>, screenshots: true }`. Every seam has a
working mechanism in Safari. None is missing outright, so no UI is hidden on the current evidence. The places where
Safari does less are these:

- video is a window, not a tab;
- the Web Speech free tier has no on-device check, so it runs without captions unless the reviewer opts in to
  server speech (the same path Chrome takes without its language pack);
- the recorder is a visible window;
- the export reports "saved" once Safari has taken the file, not when it lands.

If S1–S3 fail in real Safari, flip the matching capability to `false`. The existing fallbacks then take over:
video off with `reason: 'unavailable'`, which the panel now words as "this browser cannot record the screen here".

## Evidence details

### Media context and the microphone (source)

WebKit gates capture on the page's view being visible:

- `UserMediaPermissionRequestManagerProxy.cpp` handles a getUserMedia request that is already granted like this:
  `if (page->isViewVisible()) grantRequest(...) else m_pregrantedRequests.append(...)`. The request is released
  only by `viewIsBecomingVisible()`. A page that never becomes visible never gets its promise settled.
- `SpeechRecognitionPermissionManager.cpp`: `if (!page()->isViewVisible())` completes the request with
  `NotAllowed`, "Page is not visible to user".
- `WebExtensionContextCocoa.mm` creates the background `WKWebView` with `CGRectZero` and never puts it in a shown
  window. Its UI delegate implements no media-capture method, so WebKit's default is to prompt. There is nothing
  to show a prompt in, and the view is not visible, so the request parks.
- The `offscreen` API (`WebExtensionContextAPIOffscreenCocoa.mm`) puts its view in a borderless `NSZeroRect`
  window "so that it can be used to play audio", and that window is never ordered front. It was switched on in
  WebKit commit 320085@main, "Enable the offscreen web extension API" (2026-08-28, bug 322752). It is not in
  Safari 27.0: MDN has no `offscreen` entry for Safari. Even when it ships, the same visibility rule would keep it
  from opening the mic. That is why the adapter does not feature-detect `chrome.offscreen`.

So Safari's media context is a **visible** extension page:

- `mediaContext.ensure()` opens `offscreen.html`, the page Chrome uses as its offscreen document, in a 360×180
  focused popup window, and waits for it to load.
- The page now carries one line of text ("…is recording your microphone… keep this window open"). Chrome never
  shows it.
- `offscreenStart` then opens the mic, and speech recognition when it is used, while that window is in front.
- The reviewer should then be able to go back to the page they are reviewing while the mic keeps running, as a
  call in a background Safari tab does. This spike did not read the rule for capture in a page that has since been
  hidden, so it is unconfirmed; S2 step 4 checks it.
- The window id lives in `storage.session`, so a restarted service worker closes the right window at Stop.

**Closing the recorder window is Stop (#9, follow-up F4).** The adapter reports the user closing the window
(`windows.onRemoved` for the remembered id; its own close at Stop forgets the id first, so it does not count), and
the service worker stops the Session as `panel_closed`, as closing the panel does in Chrome. The page that would have
joined the audio chunks is gone, so the service worker joins them itself; the recorder writes a chunk every 5 s in
Safari (30 s elsewhere) to bound what the close loses. Manual check S9.

### Microphone permission (source + Apple docs)

The recorder window is an ordinary Safari window showing a `safari-web-extension://` page. getUserMedia there
takes WebKit's normal prompt path (`doDefaultAction` → `promptForGetUserMedia`). Onboarding asks in a tab, as it
does in Chrome, and sets `micGranted`. Whether Safari remembers that grant for the extension origin, or asks
again at each Start, is S2 step 2.

### SpeechRecognition (compat + source)

- `webkitSpeechRecognition` has been in Safari since 14.1 (MDN), and it needs a visible page (above).
- Safari has no `SpeechRecognition.available()` or `install()`. So `useSpeechPack` reports `unsupported`, and the
  Web Speech adapter takes its `on_device_unavailable` path. By default the Session records without live
  captions and makes no network calls (P0-15).
- The server-speech opt-in starts Safari's recognizer. That recognizer uses Apple's dictation service and needs
  Siri or Dictation enabled, which `checkSpeechRecognitionServiceAvailability` checks.
- Local Whisper (WebGPU, Safari 26+) is the other free tier. S4 covers it.

### getDisplayMedia (compat + source)

- MDN: Safari 13+. It needs a user gesture; a promise chain loses it (WebKit bug 198040).
- The panel calls `pick()` first thing in the Start click, as it does in Chrome.
- Safari ignores Chrome's picker hints (`displaySurface`, `selfBrowserSurface`, `surfaceSwitching`,
  `monitorTypeSurfaces`, `preferCurrentTab`), so the Safari adapter asks only for the width and frame-rate caps.
- The macOS picker offers windows and screens only. The reviewer picks the Safari window. The recording then
  includes the browser's own UI.

### Everything else the extension calls (compat)

These are all supported in Safari: `runtime.connect`/`onConnect`, `tabs.query`/`create`/`update`/`get`, the
`tabs` events, `windows.create`/`update`/`get`/`remove`, `scripting.executeScript` (15.4), `commands` (full
support from 26), `storage.local`/`session`/`onChanged`, `unlimitedStorage` (16), `action.onClicked` (15.4) and
`runtime.getPlatformInfo`.

These are not supported in Safari, and only the Chrome adapter calls them: `runtime.getContexts`
(webkit.org/b/294456), `offscreen`, `sidePanel` and `downloads`.

Safari's `<all_urls>` is not granted at install. When the reviewer opens a page they have not allowed, Safari
badges the toolbar icon and asks them to allow it once, for the day, or on every website. Only then do the
content script and `captureVisibleTab` work there. Clicking the toolbar icon on such a page may open that prompt
instead of firing `action.onClicked`. That is S1 step 5.

## Build (built)

- `pnpm build:safari` runs `wxt build -b safari --mv3` into `extensions/web/.output/safari-mv3`.
  - WXT's Safari default is MV2. `--mv3` matches Chrome, and gives up nothing, because a persistent MV2
    background page would be just as hidden.
  - The `build:manifestGenerated` hook in `wxt.config.ts` drops `side_panel` and the `sidePanel`, `offscreen` and
    `downloads` permissions for Safari. The result is `["storage","unlimitedStorage","tabs","scripting","activeTab"]`
    plus `<all_urls>`.
- `src/platform/index.ts` picks `safariPlatform` when `import.meta.env.SAFARI` is set. The Chrome bundle contains
  no Safari code: `grep -c safariPanelWindow` gives 0 for chrome-mv3 and 1 for safari-mv3.
- `pnpm safari:xcode` (`extensions/web/scripts/safari-xcode.sh`) builds and then runs
  `xcrun safari-web-extension-converter --macos-only --swift` into `extensions/web/safari-xcode/InkUp/`.
  - The project **references** `../../../.output/safari-mv3` rather than copying it, so the 27 MB ORT wasm stays
    out of git.
  - Build Safari before building the Xcode project.
  - Rerun the converter only when the build gains or loses a top-level file.
- Bundle id: the placeholder `com.example.InkUp`. The converter derives the app id from `--app-name` and the
  extension id from `--bundle-identifier`. When the two differed in case, `xcodebuild` failed with "Embedded
  binary's bundle identifier is not prefixed with the parent app's bundle identifier".
- No signing team is set. The unsigned build:

  ```text
  cd "extensions/web/safari-xcode/InkUp"
  xcodebuild -project "InkUp.xcodeproj" -scheme "InkUp" -configuration Debug build CODE_SIGNING_ALLOWED=NO
  ** BUILD SUCCEEDED **
  ```

  The built `.appex` contains `manifest.json`, the HTML pages, `background.js`, `ort/ort-wasm-simd-threaded.asyncify.wasm`
  (26 MB) and `vad/`.
- The converter warns "manifest.json is missing icons". The extension has no icons on any browser yet.

## Drift rule

- `src/platform/safari` is 2 files and about 170 lines, against about 8,550 lines of extension TypeScript. That is
  about 2%, well under the 20% line.
- It reuses Chrome's runtime Ports and `captureVisibleTab`.
- It needs **no entrypoints of its own**. The recorder window is `offscreen.html` and the panel window is
  `sidepanel.html`, both unchanged apart from one line of visible text on the recorder page.
- The shared-code changes Safari needed are all small:
  - a `saveFile` seam on `Platform`, which moved `chrome.downloads` out of the review page;
  - a manifest hook;
  - a panel status string.

**Recommendation: Safari stays in the one WXT app.** Revisit the split only if S1–S4 in real Safari force one of
these:

- a Safari-only page, for example a recorder page that differs from the offscreen document;
- a different panel layout for a floating window;
- native-app messaging through `SafariWebExtensionHandler.swift` (for example, to reach the host without the
  localhost WebSocket).

The last of these is the likeliest trigger. It would be a Swift target inside `safari-xcode/`, which is already
Safari-only, not a TypeScript fork.

## Sources

- MDN browser-compat-data 8.1.2 (`webextensions.api.*`, `webextensions.manifest.*`, `api.MediaDevices`,
  `api.SpeechRecognition`): <https://github.com/mdn/browser-compat-data>
- WebKit `UserMediaPermissionRequestManagerProxy.cpp`, `UserMediaPermissionRequestProxy.cpp`,
  `SpeechRecognitionPermissionManager.cpp`, `UIProcess/Cocoa/UIDelegate.mm`:
  <https://github.com/WebKit/WebKit/tree/main/Source/WebKit/UIProcess>
- WebKit extension contexts, background and offscreen views:
  <https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/Extensions/Cocoa/WebExtensionContextCocoa.mm> ;
  <https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/Extensions/Cocoa/API/WebExtensionContextAPIOffscreenCocoa.mm>
- Offscreen enabled on `main`: <https://commits.webkit.org/320085@main> (<https://bugs.webkit.org/show_bug.cgi?id=322752>)
- getDisplayMedia and user gestures: <https://bugs.webkit.org/show_bug.cgi?id=198040>
- MediaRecorder WebM in Safari 18.4: <https://webkit.org/blog/16574/webkit-features-in-safari-18-4/>
- Safari extension permissions: <https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions>
- Running an unsigned or temporary extension: <https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension>
