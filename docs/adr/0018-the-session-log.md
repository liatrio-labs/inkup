---
status: accepted
date: 2026-09-22
---

# The Session is an append-only event log with one writer, versioned with an upgrade step per version; review edits, Undo and Redo are ops appended to it

A Session is recorded once and read many times: by the review page, by Process, by the Host and its agents, from an
exported `session.json` years later. Everything that reads it must agree on what happened, and a reader must be able to
open a file written by an older version.

**One log, one writer.** Every event has a UUID and is appended through one writer (`appendEvent`), so replay to the
Host is an idempotent upsert (ADR 0004). Span events (Strokes, Annotations, transcript segments) carry `t` as the span
start and `t_end`; the log sorts by `t`, then append order. Nothing is rewritten: an alignment, a re-transcription or a
correction is a reading of the log or a new event, never an edit of an old one. The one exception is a screenshot
nothing uses, which is deleted with its image (ADR 0013).

**Review edits are events.** `transcript_edit` (the latest per segment wins) and `item_edit` (one op: `edit`, `delete`,
`merge`, `split`, `reorder`, `undo`, `redo`) are appended after `session_end`, only for an ended Session, by the review
page. `packages/core/src/review-edits.ts` folds them: `effectiveItemEdits` replays Undo and Redo as two stacks (a new
step clears what can be redone), and everything that reads edits (the review page, `session.json`'s `change_items`, the
acceptance rate, the Host's items, Combine) goes through it. A merge and its Combine answer are one step. Edits belong
to one Process run; transcript edits carry over. An edited segment loses its word times.

**Derived output is not in the log.** Change Items live in the `processRuns` table, not in `events`: they are
re-runnable output. `session.json` carries the latest `done` run with its edits applied, and a `process_runs` list for
the failure rate.

**Versions and upgrades.** `SCHEMA_VERSION` (in `packages/core/src/timeline.ts`) rises with every schema change, and
`UPGRADES[v]` turns version v into v+1. A file runs every step up to the current version and is then validated
(`packages/core/src/session-file.ts`); a unit test fails while any version lacks a step. Most steps are the identity,
because new fields default or are optional. A newer version, a version below 1, or a failed validation is refused with
a message naming the first problems. Prefer additive, optional fields; a rename or a new required meaning gets a real
step (as v12→13 mapped `inspect_pick` to `object_select`). Schema changes are part of the contract with the Host
(ADR 0007).

## Considered options

- Mutable Session rows with edits applied in place: loses the acceptance rate, Undo, and the Host's replay.
- Undo by deleting the undone op: the Host has it already, and the log would stop being append-only.
- Change Items as timeline events: they are derived, and a re-run would have to retract them.

## Consequences

- Parallel work that bumps the schema renumbers on merge; the upgrade chain must stay contiguous.
- An undone edit does not count against the acceptance rate.
- A bare `session.json` restores without screenshots, so it can be reviewed but not exported or processed again
  (ADR 0019).

## History

- 2026-09-22 (Slice 4): schema v4 made review edits appended events.
- 2026-09-23 (U1): the upgrade shim and restore from a file.
- 2026-09-23 (E12): Combine's answer became an `edit` op with `origin: 'combine'`; there was no Undo on the review page.
  2026-09-23 (F5): `undo` and `redo` ops (schema v19).
