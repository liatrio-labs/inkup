---
status: accepted
date: 2026-09-22
---

# The review page is where a Session is judged: one tab per Session, evidence inside each card, edits undoable, and a zip export that restores to the same Session

After Stop the reviewer checks what Process made of their review, fixes it, and hands it on: to an agent through the
Host (ADR 0021), or as a zip. The review page must show each Change Item with its evidence, keep every edit reversible,
and never leave the reviewer unsure which copy they are looking at.

**One review tab per Session.** Stop, the Sessions page and side panel rows, and Restore's "Open review" and "Open
existing" ask the background to `openReview(sessionId)` (`background/review-tab.ts`), which focuses the tab already
showing that Session (matched on the `session` parameter only) or opens one. It finds tabs with `tabs.query({})`,
filtered in code: the manifest already holds `tabs`, a `url` match pattern would have to cover each browser's extension
scheme and could not ignore other parameters, `runtime.getContexts` is not in every browser, and `clients.matchAll`
exists only in Chrome's service worker. `ReviewLink` keeps its `href`, so a middle, Cmd, Ctrl or Shift click still opens
a new tab on purpose.

**Evidence inside the card.** Each Location in a Change Item card shows its own screenshot (the Location's
`screenshot`, else its Annotation's) directly under its row, with only the Strokes of the Annotation it cites drawn over
it (`strokeIdsForShot`, `packages/core/src/evidence-strokes.ts`; all of them when it cites none). Strokes are drawn in
their recorded colour with a halo (ADR 0011). The right pane holds only the recording, and selecting an item seeks it
through `media-time.ts` (ADR 0010).

**Editing.** Edit, delete, split, reorder and merge are ops in the log (ADR 0018). Merge keeps the first item's id,
title and category, unions Locations, Evidence and crops, spans both video ranges, joins intents, transcripts and agent
prompts so every screenshot stays cited, and takes the lower confidence; Combine then rewrites the words (ADR 0015).
Split inserts an editable copy. Editing a title, intent or category does not rewrite the agent prompt, and the form
says so. Undo and Redo (Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z) work anywhere except a text field, a select or an editable
element, where the field's own undo runs; an Undo or Redo while Combine is answering drops its answer.

**Export.** `packages/core/src/export/bundle.ts` plans the folder: `review.md`, `session.json`, `audio.webm`,
`recording.webm` (with video) and every referenced screenshot and crop. Export is refused, with reasons, if a
referenced screenshot has no image or an agent prompt cites a path the folder lacks. `review.md` links each item's time
range in media time. The zip is built with client-zip, which streams, and saved through `chrome.downloads`. After an
export the reviewer may delete the media (audio, video, chunks); the transcript, Annotations, screenshots and items
stay, and `media_deleted_at` is recorded.

**Restore.** A zip or a bare `session.json` restores to the same Session id, upgraded (ADR 0018) and written back in
one transaction (`src/db/session-import.ts`) over sessions, events, blobs and Process runs only; Zod strips unknown
fields, and a restore never touches `chrome.storage`. An id that exists offers Open existing or Replace, and a failed
Replace keeps the stored copy. Zips are read with unzipit, which reads a `Blob` lazily through its central directory,
so a long recording is never copied into memory.

## Considered options

- A new tab for every "Open review": repeat clicks piled up copies of the same Session.
- An evidence pane beside the list (see History): the reviewer had to match screenshots to Locations by eye.
- fflate for unzipping: `unzipSync` needs the whole zip in memory, and its streaming reader finds entries by scanning
  for a signature that WebM or PNG bytes can contain.
- Rewriting the agent prompt when the title changes: the prompt carries citations and grounding the reviewer did not
  write.

## Consequences

- A bare `session.json` restore has no screenshot bytes, so it cannot be exported or processed again; restore the zip
  for a working copy.
- The review page reads no time from its URL, so focusing an existing tab passes no seek.

## History

- 2026-09-22 (Slice 2): the review page drew Strokes in orange over each screenshot. 2026-09-23 (E8): in the Stroke's
  own colour with a halo.
- 2026-09-22 (Slice 4): the right pane showed the selected item's screenshots (`EvidencePane`). 2026-09-23 (U3):
  screenshots moved into each Location's row, and the pane keeps only the recording.
- 2026-09-23 (E12): there was no merge undo; Delete and Split remained. 2026-09-23 (F5): Undo and Redo.
- 2026-09-24 (#40): every "Open review" opened another tab; now one tab per Session.
