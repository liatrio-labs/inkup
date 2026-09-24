# @inkup/core (packages/core)

Pure TypeScript domain logic. Never imports `chrome.*`, `browser.*` or WXT, and never touches the DOM.
Enforced by `tests/core-boundary.test.ts`, and the tests run in plain Node. Imports use explicit `.ts` extensions so
Node scripts (`pnpm schema`) can load these files directly. The extension imports `@inkup/core/<module>` (the TS
source, no build step); `pnpm -C packages/core test` runs just these tests.

The modules below live in `src/`.

- `clock.ts`: Session clock (t0, offsets, mm:ss).
- `geometry.ts`: rect math in page coordinates.
- `timeline.ts`: versioned Zod schema for every P0-9 event type.
- `session-document.ts`: the `session.json` document schema and builder.
- `grouping.ts`: Strokes → Annotations state machine (time gap; other close signals plug in as inputs).
- `candidates.ts`: geometric pick, Candidate list and region fallback from element snapshots.
- `throttle.ts`: 500ms screenshot debounce.
- `annotation-shot.ts`: which screenshot a closing Annotation uses (its own, taken after a Stroke, or none once
  the page scrolled away).
- `evidence-strokes.ts`: which Strokes the review page draws over an evidence screenshot.
- `target.ts`: what a Session can do on a URL (overlay, our own page, no overlay, or not a target).
- `stroke-path.ts`: perfect-freehand Stroke outlines as SVG paths (review page overlay).
- `audio-offsets.ts`: streaming engine audio offsets → Session time through the frames sent (pauses,
  reconnects, replays), plus the PCM16 conversions.
- `transcription-runs.ts`: the live run and re-transcriptions; the active run, Voice Command words cut from a
  re-run, batch words grouped into segments on the Session clock.
- `media-time.ts`: Session time ↔ media time around pause gaps (recorders leave no gap for a pause).
- `vad-feed.ts`: the voice activity detector's frames from the PCM buffered since Start, each with its own Session
  time, and speech spans held for a listener that subscribes late.
- `drafts.ts`: Draft Item state (latest `draft_action` wins), views and the discard rate (PRD §8).
- `draft-trigger.ts`: when a live Draft Item pass runs (Annotation close + 3 s silence, 30 s fallback, one in
  flight, one queued). Clock-free.
- `review-edits.ts`: folds `transcript_edit` and `item_edit` events: edited transcript, edited Change Items,
  merge/split, acceptance rate.
- `export/`: the export folder (P0-13). `review-md.ts` (review.md renderer), `bundle.ts` (file plan and the
  citation checks), `prompts.ts` (Copy all prompts).
- `process/`: Process (P0-11). `change-item.ts` (Change Item schema and review order), `script.ts` (the PRD §7
  script, system prompt, repair and second-pass messages, screenshot aliases), `pairing.ts` (2s/4s pairing
  window), `cost.ts` (dated price table and estimate), `locale/en.ts` (demonstrative and noun tables),
  `draft.ts` (the live Draft Item pass: incremental prompt, output schema, checks), `pins.ts` (pinned Draft Items
  enforced on the Process output).
