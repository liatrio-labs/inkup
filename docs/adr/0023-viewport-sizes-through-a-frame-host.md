---
status: accepted
date: 2026-09-23
---

# Viewport sizes use a frame host in every browser, not `chrome.debugger`

A reviewer wants to check a page at a phone's width without leaving the Session. Chrome's `chrome.debugger`
(`Emulation.setDeviceMetricsOverride`) resizes the real page in place, with no reload, even on sites that refuse
framing. It was built and spiked (`docs/spikes/viewport.md`) and turned down by the product owner: it adds "Access the
page debugger backend" to the install prompt, and Chrome shows its "started debugging this browser" bar, about 56 px of
the tab, for as long as a size is set.

**The frame host.** The toolbar's Viewport control reloads the tab into our `viewport.html?u=<page>`, which frames the
page at the chosen size, centred, scaled down with a CSS transform when it does not fit (the readout says "at 80%").
An all-frames probe content script (`viewport-frame.content.ts`) asks the worker to inject the overlay into the named
frame, so drawing, Snap and page context work inside it. The host page mirrors the framed URL into its own with
`history.replaceState`, and `effectiveUrl()` maps it back wherever the worker reads a tab's URL, so a Session never logs
a navigation to our page. Resizing inside the frame does not reload; Reset loads the page back into the tab.

**Framing refusals are read, not guessed.** Before offering sizes the worker fetches the page (cached per URL) and reads
`X-Frame-Options` and CSP `frame-ancestors`; a page that refuses keeps the control, and its menu names the header. When
the fetch fails, the frame gets to try.

**Screenshots are the frame**, cropped from `captureVisibleTab` to the frame's rect, with `viewport` and `dpr` from the
framed page, so Strokes are in the resized page's coordinates.

**Remembered, not applied.** `viewportSizes` keeps the last size per origin and offers it as "Last used here"; applying
it on every visit would reload the page into a frame without the reviewer asking.

**Logged.** `viewport_change {width, height, scale, mechanism}` at every set, drag, reset and at Start on a resized tab.
Process tells the agent the size an item was seen at (ADR 0015). Behind `Platform.capabilities().viewport`: Safari is
off until manual check S6.

## Considered options

- `chrome.debugger`: resizes in place and works on every site, at the cost of an install warning and a permanent
  debugging bar. Turned down, and removed from the build.
- Applying the remembered size on every visit: reloads the page into a frame without the reviewer asking.

## Consequences

- The page reloads into the frame when a size is first set and again on Reset, losing in-page state both times.
- Sites that refuse framing cannot be resized, and say why.
- The framed page is a third-party frame of an extension page, so a signed-in site may treat it differently (SameSite
  cookies, partitioned storage): manual check C20 step 6. Record what it finds in this ADR's History.
