---
status: accepted
date: 2026-09-23
---

# One overlay per page, always on top, readable on any background, and nothing it draws outlives its use

The overlay is everything InkUp puts into a reviewed page: the drawing canvas, the floating toolbar, comment boxes, the
Object Select outline and the toasts, all inside one shadow host. It runs on pages we do not control, next to code that
may raise its own layers, and it is the reviewer's only view of what is being recorded. Four rules keep it honest.

**One overlay per page.** The first live copy of the content script claims the page (`content/instance.ts`): a symbol on
`window` holding a check of that copy's runtime. A second copy in the same world finds the live claim and returns before
it does anything. After an extension update the old copy's script keeps running in its own world with its runtime gone,
so a new copy also announces its claim with a DOM event (`inkup:overlay-claim`), which crosses worlds; a copy whose own
runtime is dead removes itself on it, step by step, each step in its own `try`. The claiming copy also removes any
overlay host left in the page. `injectIntoOpenTabs` pings each tab first (`contentPing`) and skips a tab whose content
script answers. A leaving copy stops answering the page API.

**On top of everything the page can raise.** The overlay host is a manual popover in the browser's top layer
(`content/top-layer.ts`), shown again (last shown is on top) when the page opens a popover, a modal dialog or
fullscreen, debounced and capped at 10 times in 2 s so a page that re-raises in answer cannot loop with it. A modal
dialog or a fullscreen element makes everything outside it inert, so the host moves inside the newest one with
`moveBefore` and back under the root element when it closes. In Firefox it does not move while the toolbar's Start
frame records (`FRAME_RECORDING`), because Firefox reloads an iframe on any move. Without popover support the host keeps
the maximum z-index as the last child of the root element.

**Readable on any background.** The toolbar's theme is light over dark pages and dark over light ones
(`packages/core/src/contrast.ts`, `content/theme.ts`), switching only past luminance 0.35 and 0.65. The page's colour
under the toolbar comes from computed styles first (elements under five points, backgrounds composited down to the
canvas); where styles cannot tell (an image, a gradient, a video), a sample of a 12 px band around the toolbar in a
fresh `captureVisibleTab` decides (`sampleBackground`), rate-limited so samples and screenshots stay inside Chrome's two
captures a second. The reviewer can fix the theme (`toolbarTheme`: Auto, Light, Dark). Ink is the first of red, yellow,
cyan, magenta, white and black with at least 3:1 contrast against the page at the pen tip, with a halo 4 px wider in
black or white; the colour is stored on the Stroke (`Stroke.color`) so the review page draws what the reviewer saw.

**Nothing drawn stays on the page.** Ink, the Object Select outline and pick, and comment boxes are removed once idle
for the overlay cap (`DEFAULT_MAX_OVERLAY_MS`, 30 s, in `packages/core/src/overlay-lifetime.ts`), whatever happened to
any message. One sweeper runs on every frame, once a second, at Stop, on `pagehide` and when the tab becomes visible.
Every await that holds ink has a timeout: the Annotation screenshot (`SHOT_TIMEOUT_MS`, 5 s, then `screenshot_id:
null`) and the close (`CLOSE_TIMEOUT_MS`, 10 s). A note being typed is not a hung message: it waits, and the box has the
cap. A faded Stroke whose Annotation is not sent yet keeps its data off screen, so it is still recorded. **Clear all**
(toolbar button, Alt+Shift+C) closes the open Annotation with close reason `cleared` and no screenshot, then removes
every Stroke, the outline, a pick in progress, an open comment box and the page's selection, and logs `overlay_cleared`.
A `cleared` Annotation is kept: Clear all is for stuck ink, not a discard (Cancel and "scratch that" are).

**The toolbar renders pushed state.** The service worker pushes a `ToolbarState` to every tab that shows the toolbar,
coalesced over 30 ms. The toolbar's only state of its own is its position (`toolbarPosition`, `storage.local`). It
patches its children in place (`patchChildren`): a button replaced between press and release loses the click. A mode
change (Draw, Object Select, Select Text, Esc) is applied in the page at once and then sent; the worker's pushes have
the last word. Hide is not offered while recording, so the controls cannot be lost mid-Session. The toolbar is never in
a screenshot (ADR 0013).

**Page-side code imports no worker state.** `@wxt-dev/storage`'s `defineItem` reads its item at once, and content
scripts get no `storage.session`. The worker's `session:` items live in `src/session-state.ts`, imported only by the
service worker and extension pages, and the panel Port's contract lives in `src/lib/panel-port.ts`. The
`page-storage.spec.ts` tests walk the built page-side bundles and fail on any `session:` key.

## Considered options

- The maximum z-index: a modal dialog, a popover and fullscreen paint above any z-index, and a page element at the same
  z-index later in the document wins the tie.
- Sampling the screen for every theme decision: captures are rate-limited and shared with screenshots; computed styles
  answer most pages for free.
- One ink colour (orange): invisible on orange and weak on busy pages.
- Leaving cleanup to the messages that normally end each element: one hung message left ink on the page for good.

## Consequences

- Any new overlay element must register with the sweeper and take its theme the same way.
- Pages with `pointer-events: none` decorative layers are not seen by `elementsFromPoint`, so their colour is missed.
- An element that cannot have children (a `<video>` in fullscreen) leaves the toolbar painted but not clickable until
  fullscreen ends.

## History

- 2026-09-22 (Slice 1): Strokes were held on screen until their Annotation's screenshot was taken, fading at the later
  of pointer-up plus the fade and the screenshot. Still true; 2026-09-23 (E9) bounded that wait.
- 2026-09-23 (E1): the toolbar arrived, re-rendering its buttons on every push. 2026-09-23 (F1): it lost clicks that
  way, and now patches in place.
- 2026-09-23 (E8): the review page's ink moved from a fixed orange to the Stroke's own colour with a halo; Strokes from
  before schema v18 keep orange.
- 2026-09-23 (F2): a tab still loading at install got two overlays; the claim rules above fixed it.
- 2026-09-24 (#31): content scripts imported the worker's `session:` items and threw on every page in Firefox; the
  module boundary above fixed it.
