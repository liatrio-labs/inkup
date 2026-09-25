---
status: accepted
date: 2026-09-23
---

# A paired extension streams its Sessions to the Host through an outbox of references; capture never waits on the Host, and every removal is a message

ADR 0004 made the Host the system of record while a Client is paired. This ADR records how a Session gets there, and
how deletions, discards and unpairing reach it, without capture ever depending on the Host being up.

**The outbox holds references, not copies.** An `outbox` row names an `events` seq or a `blobs` id, and is written in
the same Dexie transaction as its event, only while `hostPairing` is set: a never-paired extension writes nothing extra.
The service worker sends rows in order; consecutive events go together, each acked by its message id, and a blob is a
`PUT /blobs/<id>` between them. A dropped socket keeps the rows; the resend is harmless because the Host upserts on the
event id and replaces a blob's bytes. A refusal (`bad_message`, `conflict`, a 400 or 413) drops that row with a warning
rather than block the queue. Screenshots go as they are taken; audio and video once, whole, after Stop.

**Reconnect** from 0.5 s doubling to 10 s with ±20% jitter. `unknown_token` stops retrying and asks the reviewer to
pair again.

**Capabilities gate every kind of message.** The Host's `welcome` lists what it can do (`hostCapabilities()`), and the
extension sends events, blobs, `screenshot_discard`, `session_discard` and `forget` only to a Host that has the
capability. A new message is always a new capability (ADR 0007).

**The Host stores events loosely and reads them strictly.** On the wire the Host sees `WireTimelineEvent`, loose, so it
can store events from a newer timeline version than it was built with; the TypeScript side checks the full schema.
Every Host read of an event or item field goes through `store::fields::Fields`, and `crates/server/src/contract.rs`
feeds every generated fixture through every reader and fails on a path the Session schema lacks, has with another type,
or no fixture fills. A source scan fails any raw read that bypasses `Fields`.

**Change Items go as the whole current set.** After a Process run and each review edit, an `items` row sends the
Session's latest done run with the edits applied. The Host replaces the Session's set: an item left out is withdrawn,
never deleted, so a Resolution always keeps its item (ADR 0021).

**Removals are messages, queued like anything else.**

- `session_discard` (Cancel, ADR 0010): queued after the Session's own rows are deleted, so it goes whenever the Host is
  next reachable. The Host deletes the Session's events, items, Resolutions and blobs. During the Undo window the
  outbox holds that Session's rows.
- `screenshot_discard` (ADR 0013): always queued after the blob's own row while paired, so whether the upload went out
  or not, the Host ends up without it.
- Both are acked when the target is unknown, so a resend is harmless, and refused (`conflict`) for another Client's
  Session.

**Earlier Sessions are found by asking the Host.** A Session is offered for upload when it is ended, not being
cancelled, has no outbox rows, and the Host's `/api/sessions` lists fewer of its events than Dexie holds. A backfill
(`queueSessionForHost`) is the live path replayed in one transaction, so a second upload lands nothing twice. A Session
restored from a file while paired goes the same way.

**Forget stops the outbox, then revokes.** `halted` stops the drain; Forget waits up to 10 s for what is on the wire,
sends `forget` (the Host revokes the token and closes the connection), then clears the pairing and the outbox. The
Client's Sessions stay on the Host for its agents. A Host that cannot be reached keeps the token in
`hostRevokePending`, asked again at start and before each pairing.

## Considered options

- Copying data into the outbox: doubles storage for media, and the copy can drift from the source.
- Diffs of Change Items: the Host would need the review-edit fold; the whole set is small.
- Marking Sessions as uploaded locally: wrong after pairing with a different Host.
- Closing the WebSocket to stop Forget's uploads: blobs go over HTTP, so uploads continued.

## Consequences

- Capture, Process and export never wait on the Host; a Host down mid-Session means a longer drain later.
- A Host without a capability silently gets less, by design; the options page says when a revoke is still owed.

## History

- 2026-09-23 (H1): the outbox and live streaming. (H3): `items` pushes and `ack.event_id` optional.
- 2026-09-23 (E10): `session_discard`. (F3): `screenshot_discard`. (F6): backfill and Forget with revoke.
- 2026-09-23 (F7): the Host's reads checked against the schema; the check found Text Comments missing from the TUI's
  timeline and a Signal reading a field the schema lacks.
