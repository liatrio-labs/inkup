---
status: accepted
date: 2026-09-22
---

# Live Draft Items: small passes on what is new, only adding, triggered by silence; the reviewer's pin or discard is binding on Process

With a key saved, the side panel shows Draft Items while the reviewer is still talking, so they can pin what is right
and discard what is wrong before Process runs. The passes must be cheap, must not interrupt speech, and must never
rewrite what the reviewer already judged.

**When a pass runs** (`packages/core/src/draft-trigger.ts`, pure). After an Annotation closes, once 3 s of silence
follow the latest of its close, a VAD speech end or a segment's arrival; each restarts the wait, so a burst becomes one
pass. With speech but no Annotation, 30 s after the last pass. Never while the VAD says someone is speaking, never while
paused, and one pass at a time: signals during a pass set at most one more. Without a VAD, only segment arrivals count.

**What a pass sees.** Only the events since the previous successful pass (by Dexie `seq`; the cursor advances only on
success, so a failed pass's events go into the next), rendered by the same `renderEvents` as Process, plus the last 2
drafts with their state. Text only, no screenshots. At most 5 items, output capped at 2,000 tokens, with the Draft
role's model (ADR 0016). A pass with no new Annotation and no new speech makes no call; a Voice Command phrase alone is
not speech. Speech is the aligned transcript (ADR 0014).

**A pass only adds.** It never revises an earlier draft; that is Process's job. Drafts are numbered `d1`, `d2`, …
across the Session and stamped later than what they cover. A result that lands after Stop, or for another Session, is
dropped; Stop runs no final pass. A failure shows an amber note in the panel and capture goes on; the next triggered
pass retries.

**State is the `draft_action` log; the latest action wins** (`packages/core/src/drafts.ts`). Pin and discard by click
or by voice ("pin that", "scratch that"); a pinned draft can still be discarded, a discarded one pinned again by click.

**Pins bind Process** (`packages/core/src/process/pins.ts`, right after the main call). A draft's cover is its set of
Annotation numbers. A model item marked pinned with the same cover keeps the draft's title, category and intent, with
confidence at least 0.6 and no ambiguity; otherwise the draft is converted in code and inserted in time order. Every
other item with exactly the same cover is dropped as a rewrite, and a pin the model invents is removed. Pinned items
skip the second pass. Discarded drafts are listed to the model as rejected. Pins belong to the Session, edits to one
run: every Process run applies the pins again.

## Considered options

- Windowing draft passes like Process: each pass sends only new events, so its size stays bounded.
- Letting a pass revise earlier drafts: the reviewer may already have pinned or discarded them.
- A final pass at Stop: Process covers the end.

## Consequences

- The P0-15 notice says the transcript and element descriptions go to the provider every few seconds while a key is
  saved, and that screenshots never go with Draft Items.
- A key added mid-Session takes effect at the next Start.

## History

- 2026-09-22 (Slice 5): schema v5 gave `draft_item` its Locations, intent and transcript, so a pin can become a Change
  Item in code when the model leaves it out; v4 drafts without them are refused on restore.
- 2026-09-24 (#38): the Draft model became the Draft role, with a provider and effort.
