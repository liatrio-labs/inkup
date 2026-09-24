// Cancel (E10): the red button stops the Session at once and discards it, with Undo for DISCARD_UNDO_MS.
//
// - Cancel turns the mic off first, then runs Stop's pipeline (./session.ts `discard`): the open Annotation is
//   closed and the page's ink cleared, the media are finalized (so Undo can keep them), but nothing is queued for a
//   Host and no review page opens. The Session goes into `discardPending` with its deadline, in storage.local, so a
//   restarted worker (or a restarted browser) still honours it.
// - While it is pending, the host outbox holds that Session's rows (./host-client.ts).
// - Undo keeps it as a stopped Session: what Stop does last (media to the Host, the review page) happens now.
// - At the deadline its rows, blobs and unsent outbox rows are deleted and, while paired, a `discard` row goes in the
//   outbox so the Host deletes it too. A timer does it; an alarm and the sweep on every worker start are backstops.
import { db } from '@/db';
import { notifyOutbox, outboxEnabled } from '@/db/outbox';
import { deleteSession } from '@/db/sessions';
import { sendMessage } from '@/messaging';
import { type DiscardPending, devOverrides, discardPending } from '@/settings';
import { finishStopped, getActive, stopInProgress, stopSession } from './session';

export const DISCARD_UNDO_MS = 10_000;
const ALARM = 'discard-sweep';

let timer: ReturnType<typeof setTimeout> | undefined;
/** Discards and Undos run one at a time, so a sweep never races an Undo. */
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(run: () => Promise<T>): Promise<T> => {
  const next = chain.then(run);
  chain = next.catch((e: unknown) => console.warn('discard', e));
  return next;
};

export async function cancelSession(): Promise<{ ok: boolean; session_id: string | null }> {
  const s = await getActive();
  if (!s || s.stopping) return { ok: false, session_id: null };
  const undoMs = (await devOverrides.getValue())?.discardUndoMs ?? DISCARD_UNDO_MS;
  const pending: DiscardPending = { session_id: s.id, deadline: Date.now() + undoMs, window_id: s.window_id };
  // Held before anything else is written, so no row of it reaches the Host during the window.
  await discardPending.setValue([...(await discardPending.getValue()).filter((p) => p.session_id !== s.id), pending]);
  void sendMessage('offscreenMute', true).catch(() => {});
  arm();
  return stopSession('stop', { discard: true });
}

/** Undo: the Session stays, as if it had been stopped. Too late once its deadline passed. */
export function undoDiscard(sessionId: string): Promise<{ ok: boolean }> {
  return serial(async () => {
    const pending = (await discardPending.getValue()).find((p) => p.session_id === sessionId);
    if (!pending) return { ok: false };
    await stopInProgress();
    await discardPending.setValue((await discardPending.getValue()).filter((p) => p.session_id !== sessionId));
    notifyOutbox();
    await finishStopped(sessionId, pending.window_id);
    arm();
    return { ok: true };
  });
}

/** Deletes every Session whose deadline has passed, and arms the next timer. Safe to call any time. */
export function sweepDiscards(): Promise<void> {
  return serial(async () => {
    const now = Date.now();
    const all = await discardPending.getValue();
    const due = all.filter((p) => p.deadline <= now);
    if (due.length > 0) {
      // Not while its Stop is still writing: that would recreate rows after the delete.
      await stopInProgress();
      for (const p of due) await discard(p.session_id);
      await discardPending.setValue(
        (await discardPending.getValue()).filter((p) => !due.some((d) => d.session_id === p.session_id)),
      );
    }
    arm();
  });
}

async function discard(sessionId: string): Promise<void> {
  await deleteSession(db, sessionId);
  const paired = await outboxEnabled();
  await db.transaction('rw', db.outbox, async () => {
    await db.outbox.where('session_id').equals(sessionId).delete();
    // The Host already has what streamed live: it deletes the Session too, whenever it is next reachable.
    if (paired) await db.outbox.add({ kind: 'discard', session_id: sessionId, created_at: Date.now() });
  });
  if (paired) notifyOutbox();
}

/** A timer for the next deadline, and an alarm in case this worker is stopped before it fires. */
function arm(): void {
  void discardPending.getValue().then((all) => {
    clearTimeout(timer);
    if (all.length === 0) return void chrome.alarms?.clear(ALARM);
    const next = Math.min(...all.map((p) => p.deadline));
    timer = setTimeout(() => void sweepDiscards(), Math.max(0, next - Date.now()) + 50);
    void chrome.alarms?.create(ALARM, { when: next + 50 });
  });
}

export function initDiscards(): void {
  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void sweepDiscards();
  });
  void sweepDiscards();
}
