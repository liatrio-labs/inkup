# E6 spike: resizing the page's viewport for a review

Date: 2026-09-23. Playwright 1.63 with its Chromium 153.0.8010.12 (headless and headed) and Firefox 155.0, macOS 26.6
(arm64). Safari was not run (see `docs/spikes/safari.md`).

## The question

The reviewer wants to see the page at a phone or tablet width without leaving the tab, and the Session has to record
what they saw at that width: media queries must fire, Annotations must carry the resized viewport, and screenshots
must be the resized page, not the whole tab. The plan named two mechanisms behind a `Platform.viewport` seam:

1. Chrome's DevTools protocol through `chrome.debugger`: `Emulation.setDeviceMetricsOverride`;
2. a frame host for every browser: our own extension page holds the page in an iframe of the chosen size.

## Results

| # | Probe | Result |
| --- | --- | --- |
| 1 | `setDeviceMetricsOverride {width: 375, height: 812, deviceScaleFactor: 0, mobile: false}` | The page's `innerWidth` is 375 and `matchMedia('(max-width: 600px)')` is true: the real viewport, so layout, media queries and `getBoundingClientRect` all follow. `mobile: true` would lay a page without a meta viewport out at 980 px, so it stays false |
| 2 | Where the emulated view is drawn (headed) | At the tab's top-left. The rest of the tab shows the page's own background, not a backdrop. `positionX`/`positionY` fail with "View position should be on the screen" unless `screenWidth` is set, and then move only `screen.x`, not the view. It cannot be centred |
| 3 | Chrome's "… started debugging this browser" bar | Shown while the extension is attached, and it takes about 56 px of the tab's height. It cannot be hidden without `--silent-debugger-extension-api` |
| 4 | Pointer events outside the emulated view | Not delivered to the page at all. A handle at the view's edge cannot be dragged outwards; the drag has to clear the override (the page gets the whole tab) until release |
| 5 | `captureVisibleTab` under emulation | Unreliable: it shoots the whole tab surface, including the uncovered area. `Page.captureScreenshot` returns exactly the view at the real pixel ratio: 750×1200 for 375×600 at dpr 2, and 3200×2000 for a 1600 px view scaled to 0.5 |
| 6 | Clearing the override | `Emulation.clearDeviceMetricsOverride` also clears Playwright's own viewport emulation in tests, so the e2e sets the tab's real size explicitly |
| 7 | Frame host in Chrome and Firefox | Works where the page allows framing. An all-frames probe content script finds the named frame and asks the service worker to inject the overlay there, so drawing, Snap and page context work inside the frame. `captureVisibleTab` cropped to the frame's rect is the frame |
| 8 | Frame host against `X-Frame-Options: DENY` / `frame-ancestors 'none'` | The frame is blank. The service worker reads the page's headers before offering sizes and reports the refusal per page |
| 9 | Playwright's Firefox following a tab to `moz-extension://` | Loses the tab (Juggler), so the Firefox e2e scripts the host page over RDP and cannot draw inside the frame; a Snap stands in |

## Decision

The debugger (1) resizes the real page in place: no reload, no framing restrictions, and sessions, cookies and
storage are untouched. It was built, but the user turned it down for its install warning and the bar (3), and it was
removed. The frame host (2) is the mechanism in every browser; see the E6 entry in `docs/decisions-log.md`. Safari
hides the control until manual check S6 confirms the frame host there. Probes 1–6 stay here in case the question
comes back.

Proofs: `tests/e2e/viewport.spec.ts` (standalone and paired, and a page that refuses framing) and
`tests/e2e-firefox/viewport.spec.ts`.
