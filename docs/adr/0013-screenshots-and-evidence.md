---
status: accepted
date: 2026-09-22
---

# Screenshots go through one throttled queue, show the page as the reviewer saw it with no InkUp UI, and are deleted when nothing uses them

Screenshots are the evidence an agent reads with each Change Item, so each one must show what the reviewer was looking
at, at the moment they meant, with their ink and without our controls. Chrome's `captureVisibleTab` shoots whatever is
showing, allows about two captures a second, and cannot be told which tab to shoot.

**One queue, one 500 ms window, a policy per trigger.** Every capture (screenshots, background samples for the toolbar
theme) goes through one queue in the service worker (`background/screenshots.ts`). Annotation, navigation, voice
command, Snap and shortcut shots wait for the window; a click shot is dropped when the window is busy. An Annotation
closed by a navigation cannot be shot, because its page is gone: it takes its own shot if one landed, else the latest
shot of its URL taken since it began, which is usually the click on the link.

**Only while the Session's tab is visible.** While the reviewer looks at another tab the Session keeps recording that
tab's Strokes, clicks and speech, but a screenshot request is skipped (`screenshot_id: null`) and the panel says so.

**The page as it was.** A click shot is asked for at `pointerdown` over an interactive element, because a link can
commit the next page within about 20 ms of release; a click with no press in the previous 2 s (keyboard activation) is
shot at click time. Every capture re-reads the page after `captureVisibleTab` and drops the image if the scroll or the
URL changed. Crops of the picked element (`<screenshot_id>.crop`, kind `screenshot_crop`) are cut from the Annotation's
own screenshot in the service worker, to the pick's box plus 16 CSS px (ADR 0022).

**No InkUp UI in the image, ink kept.** Each capture asks the tab's overlay to hide the toolbar, comment boxes and
toasts, and waits for a painted frame before capturing (`content/paint.ts`, `nextPaint()`: two animation frames, or
150 ms in a tab that is not painting), whether or not any UI is on the page. The canvas is a sibling of the UI, so the
Strokes stay in the shot. Object Select's outline is shown on purpose, like ink.

**A screenshot nothing uses is deleted.** A dropped Object Select pick hands its screenshot back, and the service worker
deletes the blob, its `screenshot` event and their outbox rows not sent yet (`discardScreenshots`), and tells a paired
Host with `screenshot_discard` (ADR 0020). It deletes only a screenshot taken for an Annotation that no Annotation or
Text Comment uses, so a page cannot delete other evidence. At Stop, `finishStopped` sweeps every such screenshot
(`unusedAnnotationShots`, `packages/core/src/annotation-shot.ts`). Screenshots of their own (a click, a navigation,
Snap) are evidence and are never swept. This is the one place events leave the append-only log (ADR 0018): the image
they describe no longer exists.

## Considered options

- Reusing the last shot for an Annotation within the window: it pointed at an image without that Annotation's Strokes.
- Taking the Text Comment shot when the box opens: Esc would leave an orphan screenshot.
- Leaving the toolbar in the shot and masking it on the review page: an agent reading the file would still see it.

## Consequences

- A navigation close's screenshot can be a shot taken a moment before the Annotation closed.
- Chrome counts a dropped or failed capture against its quota, so the next capture still waits the window out.
- Any new overlay UI must hide for captures through the same path.

## History

- 2026-09-22 (Slice 3): the Annotation trigger reused the last shot within 500 ms. 2026-09-23 (U2): it waits
  (`defer`) instead.
- 2026-09-23 (E1): the toolbar hid for each capture and waited for two animation frames. 2026-09-24 (#34): the wait
  was skipped when nothing was visible, and a Text Comment's box showed in about one shot in four; every capture now
  waits for a painted frame.
- 2026-09-23 (E7): a dropped pick left its screenshot. 2026-09-23 (F3): it is deleted, on the Host too, and Stop
  sweeps what a lost message missed.
