// The host outbox (ADR 0004): while paired, every event and screenshot also gets a row here, written with it, and
// so does each change to a Session's Change Items (a Process run, a review edit). The service worker's host client
// sends the rows in order and deletes each once the Host acknowledges it. A never-paired extension writes nothing
// here.
import type { TimelineEvent } from '@inkup/core/timeline';
import { sendMessage } from '@/messaging';
import { hostPairing } from '@/settings';
import { db } from './index';

// Whether a Host is paired, cached per context and kept current by a watch, so a capture event costs no storage read.
let paired: Promise<boolean> | null = null;
/** Read before a transaction: Dexie transactions cannot await chrome.storage. */
export function outboxEnabled(): Promise<boolean> {
  if (!paired) {
    paired = hostPairing.getValue().then((p) => p !== null);
    hostPairing.watch((p) => (paired = Promise.resolve(p !== null)));
  }
  return paired;
}

let onAdded: (() => void) | null = null;
/** The service worker's host client listens here; other contexts wake it with a message. */
export function onOutboxAdded(listener: () => void) {
  onAdded = listener;
}

/** Call after a transaction that queued rows has committed. */
export function notifyOutbox() {
  if (onAdded) onAdded();
  else void sendMessage('hostDrain').catch(() => {});
}

/**
 * Stores events of a Session and, when `outbox`, queues them for the Host. Call inside a transaction that includes
 * `events` and `outbox`, then `notifyOutbox()` once it has committed.
 */
export async function addEventRows(sessionId: string, events: TimelineEvent[], outbox: boolean): Promise<void> {
  const seqs = await db.events.bulkAdd(
    events.map((e) => ({ ...e, session_id: sessionId })),
    { allKeys: true },
  );
  if (!outbox) return;
  const now = Date.now();
  await db.outbox.bulkAdd(
    seqs.map((seq) => ({ kind: 'event' as const, session_id: sessionId, event_seq: seq, created_at: now })),
  );
}

/** Stores events and queues them for the Host if paired. */
export async function storeEvents(sessionId: string, events: TimelineEvent[]): Promise<void> {
  const outbox = await outboxEnabled();
  await db.transaction('rw', db.events, db.outbox, () => addEventRows(sessionId, events, outbox));
  if (outbox) notifyOutbox();
}

/** Queues blobs already in `blobs` (a screenshot as it is taken, audio and video at Stop) if paired. */
export async function queueBlobs(sessionId: string, blobIds: (string | null | undefined)[]): Promise<void> {
  const ids = blobIds.filter((id): id is string => !!id);
  if (ids.length === 0 || !(await outboxEnabled())) return;
  const now = Date.now();
  await db.outbox.bulkAdd(
    ids.map((id) => ({ kind: 'blob' as const, session_id: sessionId, blob_id: id, created_at: now })),
  );
  notifyOutbox();
}

/** Queues the Session's Change Items for the Host if paired: after a Process run, and after each review edit of them. */
export async function queueItems(sessionId: string): Promise<void> {
  if (!(await outboxEnabled())) return;
  await db.outbox.add({ kind: 'items', session_id: sessionId, created_at: Date.now() });
  notifyOutbox();
}

/** The blob kinds a Session sends the Host: what a live Session queues (screenshots and crops as taken, media at Stop). */
const HOST_BLOB_KINDS = new Set(['screenshot', 'screenshot_crop', 'audio', 'video']);

/**
 * Queues a whole stored Session for the Host if paired, as if it had streamed: every event in order, its screenshots,
 * crops, audio and video, then its Change Items. For Sessions the Host never saw (recorded before pairing, restored
 * from a file). A resend is harmless: the Host upserts events on their id and replaces a blob's bytes. Returns
 * whether anything was queued.
 */
export async function queueSessionForHost(sessionId: string): Promise<boolean> {
  if (!(await outboxEnabled())) return false;
  const now = Date.now();
  await db.transaction('rw', db.events, db.blobs, db.outbox, async () => {
    // In append order: entries of one index key come in primary key order.
    const seqs = await db.events.where('session_id').equals(sessionId).primaryKeys();
    const blobs = await db.blobs
      .where('session_id')
      .equals(sessionId)
      .filter((b) => HOST_BLOB_KINDS.has(b.kind))
      .primaryKeys();
    await db.outbox.bulkAdd([
      ...(seqs as number[]).map((seq) => ({
        kind: 'event' as const,
        session_id: sessionId,
        event_seq: seq,
        created_at: now,
      })),
      ...blobs.map((id) => ({ kind: 'blob' as const, session_id: sessionId, blob_id: id, created_at: now })),
      { kind: 'items' as const, session_id: sessionId, created_at: now },
    ]);
  });
  notifyOutbox();
  return true;
}
