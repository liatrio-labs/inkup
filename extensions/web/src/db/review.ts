// Review-page writes (PRD P0-11, P0-12, P0-13). Review edits are appended to the Session's timeline, stamped at
// its end, so the log stays append-only (packages/core/src/review-edits.ts folds them in). The service worker writes
// every capture event; the review page writes only these, and only for an ended Session.
import type { ChangeItem } from '@inkup/core/process/change-item';
import { applyItemEdits, itemEditsFor } from '@inkup/core/review-edits';
import { type EventOf, type TimelineEvent, TimelineEventSchema } from '@inkup/core/timeline';
import { buildRunEvents, type RunInput } from '@inkup/core/transcription-runs';
import { db } from './index';
import { addEventRows, notifyOutbox, outboxEnabled, queueItems, storeEvents } from './outbox';

type ReviewEvent =
  | Omit<EventOf<'transcript_edit'>, 'id' | 't' | 'edited_at'>
  | Omit<EventOf<'item_edit'>, 'id' | 't' | 'edited_at'>;

export async function appendReviewEvent(sessionId: string, event: ReviewEvent): Promise<TimelineEvent> {
  const row = await db.sessions.get(sessionId);
  if (row?.status !== 'ended') throw new Error('Only a finished Session can be edited.');
  const parsed = TimelineEventSchema.parse({
    ...event,
    id: crypto.randomUUID(),
    t: row.duration_ms ?? 0,
    edited_at: new Date().toISOString(),
  });
  await storeEvents(sessionId, [parsed]);
  if (parsed.type === 'item_edit') await queueItems(sessionId);
  return parsed;
}

/** The Session's Change Items as the review page shows them: its latest done run with the review edits applied. */
export async function currentChangeItems(sessionId: string): Promise<{ run_id: string; items: ChangeItem[] } | null> {
  const run = await db.latestRun(sessionId, 'done');
  if (!run?.items) return null;
  const edits = await db.eventsOfType(sessionId, 'item_edit').toArray();
  return { run_id: run.id, items: applyItemEdits(run.items, itemEditsFor(edits, run.id)).items };
}

/**
 * After an export (P0-13): drop the Session's audio and video, keeping the transcript, Annotations, screenshots
 * and Change Items. session.json then has no media and records when it was deleted.
 */
export async function deleteSessionMedia(sessionId: string): Promise<number> {
  return db.transaction('rw', db.blobs, db.sessions, async () => {
    const media = await db.blobs
      .where('session_id')
      .equals(sessionId)
      .filter((b) => b.kind === 'audio' || b.kind === 'video' || b.kind === 'audio_chunk' || b.kind === 'video_chunk')
      .primaryKeys();
    await db.blobs.bulkDelete(media);
    await db.sessions.update(sessionId, { audio: null, video: null, media_deleted_at: new Date().toISOString() });
    return media.length;
  });
}

/**
 * Appends a re-transcription (P0-12): its segments and the `transcription_run` event, in one transaction, so a
 * half-written run never shows. The new run becomes the active one.
 */
export async function appendTranscriptionRun(
  sessionId: string,
  input: Omit<RunInput, 'duration_ms' | 'created_at' | 'run_id'>,
): Promise<EventOf<'transcription_run'>> {
  const outbox = await outboxEnabled();
  const run = await db.transaction('rw', db.sessions, db.events, db.outbox, async () => {
    const row = await db.sessions.get(sessionId);
    if (row?.status !== 'ended') throw new Error('Only a finished Session can be re-transcribed.');
    const { segments, run } = buildRunEvents({
      ...input,
      run_id: crypto.randomUUID(),
      duration_ms: row.duration_ms ?? 0,
      created_at: new Date().toISOString(),
    });
    const parsed = [...segments, run].map((e) => TimelineEventSchema.parse({ ...e, id: crypto.randomUUID() }));
    await addEventRows(sessionId, parsed, outbox);
    return parsed.at(-1) as EventOf<'transcription_run'>;
  });
  if (outbox) notifyOutbox();
  return run;
}

/** Makes another run the active one (null: the live run). */
export async function selectTranscriptRun(sessionId: string, runId: string | null): Promise<void> {
  const row = await db.sessions.get(sessionId);
  if (row?.status !== 'ended') throw new Error('Only a finished Session can be edited.');
  const parsed = TimelineEventSchema.parse({
    type: 'transcript_select',
    run_id: runId,
    id: crypto.randomUUID(),
    t: row.duration_ms ?? 0,
    edited_at: new Date().toISOString(),
  });
  await storeEvents(sessionId, [parsed]);
}
