# E1 spike: video for a Session started from the page toolbar

Date: 2026-09-23. Playwright 1.63 with its Chromium 153.0.8010.12 and Firefox 155.0, macOS 26.6 (arm64). Safari was
not run (see `docs/spikes/safari.md` for why no automation can load a Safari extension).

## The question

Until E1, video needed a click on Start in the side panel (ADR 0001, ADR 0002): `getDisplayMedia` needs a user
activation, and the panel was the one extension page with a click in it. The floating toolbar lives in the web page,
in the content script's shadow root, so a click on it gives the *page* an activation, not the extension. The plan
named three ways to get video anyway, in order:

1. an extension-origin iframe inside the toolbar, with `allow="display-capture"`, whose click calls `getDisplayMedia`;
2. `chrome.tabCapture.getMediaStreamId` from the toolbar icon or the shortcut, consumed in the media context;
3. audio only.

## How it was run

A copy of the Chrome build with `tabCapture`, a web-accessible `spike-frame.html` (a button whose click calls
`getDisplayMedia` and records a few seconds) and a service-worker hook that calls `getMediaStreamId`, driven by a
Playwright script against the fixture site. The Firefox build got the same frame, driven through the existing RDP
harness (`tests/e2e-firefox`). Every result below was observed, not read from docs.

## Results

| # | Probe | Chrome (Chromium 153) | Firefox 155 |
| --- | --- | --- | --- |
| 1a | Frame in the page, `allow="display-capture"`, real click, `getDisplayMedia` | **Fails.** `InvalidStateError: Invalid state`, whatever the constraints (`{video:true}`, Chrome's picker hints, `preferCurrentTab`), whichever tab the picker would pick, with focus and a live user activation in the frame | **Works.** The stream opens (the fake-media prefs grant it here; a person sees Firefox's window/screen picker) and a MediaRecorder in the frame writes chunks |
| 1b | The same frame without `allow` | `NotAllowedError … disallowed by permissions policy`: the attribute is needed and is honoured; the refusal in 1a comes after it | not run |
| 1c | For comparison, `getDisplayMedia` from a click in the web page itself, and from an extension page in its own tab | Both work | Page: works |
| 1d | Hand the frame's stream to the background page so it outlives the page | n/a | **No.** `runtime.getBackgroundPage()` returns null in the frame, so a navigation ends the frame's recording |
| 2a | `tabCapture.getMediaStreamId({targetTabId})` in the service worker with no gesture, after a dispatched (fake) command, from the frame's click, and from the worker after the frame's click | **Refused** in all four: "Extension has not been invoked for the current page (see activeTab permission)". A click in our frame is not an invocation | no `tabCapture` |
| 2b | The same with `--allowlisted-extension-id=<id>` (stands in for the icon click or shortcut that invokes the extension on the tab) | **Works**: an id in all four cases | n/a |
| 2c | Open that id in an extension page with `getUserMedia({video: {mandatory: {chromeMediaSource: 'tab', chromeMediaSourceId}}})`, record, then navigate the tab to another origin | **Works**: 1280×720 at 15 fps, and the track stays `live` and keeps recording across the cross-origin navigation | n/a |
| 2d | A second `getMediaStreamId` for a tab that is already being captured | "Cannot capture a tab with an active stream." | n/a |
| 3 | Audio only | Always available | Always available |

Chrome's rule for 2a is the documented one: `getMediaStreamId` works once the extension was invoked on the tab (its
toolbar icon, a keyboard shortcut, a context menu) and until that tab navigates. So in real use the order is the
natural one: the icon click that shows the toolbar also invokes the extension, and Start then gets tab video; Alt+Shift+R
invokes it and starts in one go.

## What was built

`Platform.capabilities().toolbarVideo` says, per browser, how a toolbar or shortcut Start gets video, and the UI
follows it (no control is shown that cannot work):

| Browser | `toolbarVideo` | Behaviour |
| --- | --- | --- |
| Chrome | `tab_capture` | Start from the toolbar or Alt+Shift+R: the service worker mints a `tabCapture` id for the tab (`Platform.tabVideo.captureId`), `offscreenStart` carries it, and the offscreen document records it with the panel's recorder (`src/media/tab-video.ts`, `src/entrypoints/offscreen/video.ts`). No picker; it is always the right tab and follows it across navigations. When Chrome refuses the id (the tab navigated since the icon click, or the toolbar was shown from a Session started elsewhere), the Session starts without video and the picker window opens: its click opens the panel's screen picker and the window records the video (ADR 0010). |
| Firefox | `frame_picker` | The toolbar's Start is `toolbar-start.html` in an extension frame (web-accessible in the Firefox build only). Its click opens Firefox's picker (windows or screens: Firefox has no tab surface), starts the Session for the frame's tab and records in the frame, holding the panel Port as a video owner that does not stop the Session. If the tab navigates, the frame goes and the video ends there ("sharing ended"); audio, Strokes and screenshots carry on. If a page's CSP refuses the frame, Start falls back to a plain button without video after 4 s. |
| Safari | `none` | Not tried in Safari. Start from the toolbar records audio, Strokes and screenshots; video still comes from Start in the panel window (S3). Manual check S5 tries the frame; if it works, Safari can switch to `frame_picker`. |

The panel's own Start and picker are unchanged on every browser.

## Tests

- `tests/e2e/toolbar-session.spec.ts` runs the Chrome path end to end with `ALLOW_TAB_CAPTURE` (the switch in 2b) in
  place of the icon click, standalone and paired with the real host, and checks the Session row has a video.
- `tests/e2e-firefox/toolbar.spec.ts` clicks the real Start frame in Firefox and checks the frame's video chunks were
  assembled.
- The real icon click and shortcut in installed Chrome, and the Firefox picker, are manual checks C19 and F6.
