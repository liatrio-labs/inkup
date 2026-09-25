---
status: accepted
date: 2026-09-22
---

# Strokes group into Annotations in the page, Candidates are ranked in code, and Object Select and Select Text never modify the page

An Annotation is the unit everything downstream reads: pairing with speech, Draft Items, Signals on the Host, the
review page and Process. It must say what the reviewer pointed at, as a person would read it, without the model having
to guess from pixels. This ADR records how Strokes become Annotations, how the element is picked, and the two other
ways to point: Object Select and Select Text (Text Comments).

**Grouping in the content script, ranking in the service worker.** The content script owns the pointer and the DOM, so
it groups Strokes (`packages/core/src/grouping.ts`, a pure state machine with a `signal` input) and snapshots elements.
The service worker ranks the snapshots (`packages/core/src/candidates.ts`) and records the `annotation` event. Strokes
are sent when their Annotation closes, so `detectConnector` sees the whole group and can mark a two-Stroke arrow. A
group closes on: a gap in drawing, a scroll of more than 25% of the viewport on either axis, a Speech Boundary (a final
segment closes an Annotation begun before its boundary), a navigation (`pagehide` closes it synchronously), draw mode
turning off, a pause, Stop (`session_end`), Clear all, and a pick or a Text Comment starting.

**Context is read at each Stroke's pointer-up.** Candidates, Connector ends and page context are snapshotted then, and
the screenshot is asked for 120 ms later with the Strokes still on screen; the close only finalizes. A scroll between
pointer-up and close no longer moves the pick or the screenshot.

**The pick is the element the Strokes enclose.** Among elements at least 80% inside the Annotation's bbox that fill at
least a quarter of it, the one that fills most. When nothing that size is enclosed (underlines, scribbles over text),
the fallback is the deepest element covering at least 70% of the bbox. Candidates list the pick, ancestors, siblings
and up to 8 `descendant`s (elements under the pick at least 80% inside the bbox), each with its classes (generated and
utility classes removed). `html` and `body` are never Candidates; nothing under the Strokes, only `html`/`body`, or a
`canvas`, `iframe`, `frame`, `embed` or `object` pick gives a region Annotation.

**Selectors a person could read.** A unique test attribute (`data-testid`, `data-test`, `data-cy`, `data-qa`, in that
order) wins, then a unique human-looking id, then css-selector-generator trying class-only selectors first, with
hashed CSS-in-JS, CSS-module and Tailwind classes blacklisted. The library's `ignoreGeneratedClassNames` is off, since
it rejects real short names such as `cta`. Inside an open shadow root the selector is `host >>> inner` (Playwright's
and Puppeteer's piercing form). The last resort is a readable `:nth-of-type()` path.

**Only clicks, never keystrokes.** Clicks on interactive elements are logged, with no typed text.

**Draw, Object Select and Select Text are one at a time**, and the modes live on the Session in the service worker
(`draw_mode`, `select_mode`; `background/modes.ts`). The toolbar, Alt+Shift+D, Alt+Shift+O, Alt+Shift+T and Esc all ask
the worker; Alt+Shift+O and T are matched in the page because Chrome allows four command slots.

**Object Select picks an element and never changes it.** Hover, ↑/↓ and a click or ⏎ pick; the pick closes the open
drawn Annotation (close reason `object_select`), is screenshotted with its outline, and opens a one-line comment box.
Enter records it as an Annotation with no Strokes, the picked element as its one Candidate (`relation: pick`), an
optional typed `comment`, and a span from pick to Enter so speech in it attaches as it would to a drawing. "Is a pick"
is `isObjectSelectPick` (the reason and no Strokes). Esc drops the pick and deletes its screenshot (ADR 0013).

**Select Text makes a Text Comment.** While it is on, a finished selection opens the same comment box
(`content/comment-box.ts`). The comment is anchored with a W3C TextQuoteSelector (`packages/core/src/text-quote.ts`):
`exact` is the source text (`textContent`, so an agent can grep it), with up to 32 characters of prefix and suffix
from an ancestor holding enough text; `selected_text` is what the page showed. `t` is the selection, `t_end` the save,
and speech overlapping that span belongs to the comment, with no slack. The screenshot is taken at the save with the
selection put back, so the image shows the selected text.

## Considered options

- The deepest element covering at least 70% of the bbox as the only rule (PRD P0-4 as written): a loose circle around a
  button picked the card. The owner's feedback asked for the enclosed element instead; the PRD notes the change.
- Sending each Stroke on pointer-up: shape detection needs the whole group.
- Reading context and the screenshot at close: a scroll close happens after the page moved, so the Strokes landed
  outside the image.
- Live style editing in the page (Inspect, see History): it changed the page under review and needed its own revert.

## Consequences

- Close reasons are part of the Session schema; a new grouping signal needs a schema version (ADR 0018).
- Scrolling inside an inner container does not close an Annotation: the 25% rule reads only the window.
- Text Comments carry before and after texts in the title, intent and agent prompt, not in new Change Item fields
  (ADR 0015).

## History

- 2026-09-22 (Slice 1): the pick was the deepest element covering at least 70% of the bbox. Slice 2 added the
  `descendant` relation so a loose circle still lists the button. 2026-09-23 (U2): the pick became the enclosed
  element, with the 70% rule as the fallback.
- 2026-09-22 (Slice 1): Candidates and the screenshot were taken at close. 2026-09-23 (U2): at each pointer-up.
- 2026-09-23 (E2): **Inspect** picked an element and let the reviewer edit its styles live, as `!important` inline
  values that Stop reverted, recorded as `style_edit` diffs. 2026-09-23 (E7): Inspect became **Object Select**: the
  page is never modified, the style panel is gone, close reason `inspect_pick` became `object_select` (schema v13),
  and `style_edit` survives only as the page API's data path (ADR 0022).
- 2026-09-23 (E3): Text Comments came from an always-on chip on any selection. 2026-09-23 (E7): the chip is gone;
  Select Text is a mode, and selection does nothing special while it is off.
- 2026-09-23 (E7): Esc left the dropped pick's screenshot behind. 2026-09-23 (F3): it is deleted with the pick.
