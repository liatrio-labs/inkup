// Live Draft Items in the service worker (PRD P0-10). Only with an Anthropic key, decided at Start.
//
// - Capture handlers report signals (an Annotation recorded, a transcript segment, VAD speech edges) to the pure
//   trigger (packages/core/src/draft-trigger.ts); a 500 ms tick asks it whether a pass is due.
// - A pass sends the events appended since the previous successful pass (by the log's `seq`), plus the last 2
//   Draft Items, to the Draft model. Its Draft Items are appended as `draft_item` events stamped now, which is
//   after the Annotations they cover, so "scratch that" sees them as newer.
// - Capture never waits for a pass. One pass runs at a time and at most one more is queued. A result that lands
//   after Stop is dropped. A failure is a non-fatal note in the panel; its events go into the next pass.
// - Discard and pin, by click (panel) or voice (./voice.ts), are `draft_action` events.
import { createDraftTrigger, type DraftPassReason, type DraftTrigger } from '@inkup/core/draft-trigger';
import { nextDraftId } from '@inkup/core/process/draft';
import { type EventOf, sortTimeline, type TimelineEvent } from '@inkup/core/timeline';
import { ProcessError } from '@/adapters/llm';
import { db } from '@/db';
import { activeSession } from '@/session-state';
import type { ActiveSession } from '@/settings';
import { appendEvent } from './event-log';
import { llm } from './process';
import { getActive, offsetOf, patchActive } from './session';

const TICK_MS = 500;

interface Live {
  session_id: string;
  trigger: DraftTrigger;
  /** Highest event seq sent in a successful pass. */
  cursor: number;
  paused: boolean;
}

let live: Live | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** The draft state for the active Session, created on first use (also after a service worker restart). */
async function current(): Promise<{ s: ActiveSession; l: Live } | null> {
  const s = await getActive();
  if (!s || s.stopping || !s.drafts?.enabled) return null;
  if (live?.session_id !== s.id) {
    // After a restart the cursor is lost: resume after the last Draft Item written, the best record there is.
    const last = await db.eventsOfType(s.id, 'draft_item').sortBy('seq');
    live = {
      session_id: s.id,
      trigger: createDraftTrigger({ startAt: offsetOf(s) }),
      cursor: last.at(-1)?.seq ?? 0,
      paused: !!s.paused,
    };
  }
  if (!timer) timer = setInterval(() => void tick().catch((e) => console.warn('draft tick failed', e)), TICK_MS);
  return { s, l: live };
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  live = null;
}

/** Follows the active Session: starts with it, resets the trigger on pause and resume, stops with it. */
export function initDrafts(): void {
  activeSession.watch((s) => {
    if (!s || s.stopping || !s.drafts?.enabled) return stop();
    void current().then((c) => {
      if (!c) return;
      const paused = !!s.paused;
      if (paused !== c.l.paused) {
        c.l.paused = paused;
        c.l.trigger.reset(offsetOf(s));
      }
    });
  });
  void current();
}

const signal = (fn: (trigger: DraftTrigger, t: number) => void) => async () => {
  const c = await current();
  if (c) fn(c.l.trigger, offsetOf(c.s));
};
export const draftSignals = {
  annotationClosed: signal((tr, t) => tr.annotationClosed(t)),
  segment: signal((tr, t) => tr.segment(t)),
  speechStarted: signal((tr, t) => tr.speechStarted(t)),
  speechEnded: signal((tr, t) => tr.speechEnded(t)),
};

async function tick(): Promise<void> {
  const c = await current();
  if (!c) return stop();
  if (c.s.paused) return;
  const reason = c.l.trigger.take(offsetOf(c.s));
  if (reason) void runPass(c.s, c.l, reason);
}

async function runPass(s: ActiveSession, l: Live, reason: DraftPassReason): Promise<void> {
  const setState = (running: boolean, note?: string | null) =>
    patchActive((a) =>
      a.id !== s.id ? a : { ...a, drafts: { ...a.drafts, running, ...(note !== undefined ? { note } : {}) } },
    );
  try {
    const rows = await db.events.where('session_id').equals(s.id).toArray();
    const cursor = Math.max(l.cursor, ...rows.map((r) => r.seq ?? 0));
    const fresh = new Set(rows.filter((r) => (r.seq ?? 0) > l.cursor).map((r) => r.id));
    const events = sortTimeline(rows) as TimelineEvent[];
    const a = await llm();
    if (!a) return;
    await setState(true);
    const start = events.find((e): e is EventOf<'session_start'> => e.type === 'session_start');
    const result = await a.adapter.draft({ events, fresh, start_url: start?.url ?? s.tab_url, model: a.draftModel });
    l.cursor = cursor;
    const now = await getActive();
    // Stopped (or a new Session) meanwhile: the result is dropped.
    if (!now || now.id !== s.id || now.stopping) return;
    if (result.skipped) return void (await setState(false));
    const pass_id = crypto.randomUUID();
    const ends = new Map(
      events.filter((e): e is EventOf<'annotation'> => e.type === 'annotation').map((e) => [e.annotation_id, e.t_end]),
    );
    const written: TimelineEvent[] = [...events];
    for (const item of result.items) {
      const t = Math.max(offsetOf(now), ...item.annotation_ids.map((id) => (ends.get(id) ?? 0) + 1));
      const e = await appendEvent(s.id, {
        type: 'draft_item',
        t,
        draft_id: nextDraftId(written),
        pass_id,
        model: a.draftModel,
        ...item,
      });
      written.push(e);
    }
    console.debug(`[var] draft pass (${reason}): ${result.items.length} Draft Items`);
    await setState(false, null);
  } catch (e) {
    const message = e instanceof ProcessError || e instanceof Error ? e.message : String(e);
    console.warn('draft pass failed', e);
    await setState(
      false,
      `Draft Items paused: the last pass failed (${message}). Capture goes on; the next pass retries.`,
    );
  } finally {
    l.trigger.done();
  }
}

/** A click on a panel card, or a voice pin/scratch (source voice). Ignored for an unknown draft or after Stop. */
export async function recordDraftAction(
  draft_id: string,
  action: 'discard' | 'pin',
  source: 'click' | 'voice',
): Promise<{ ok: boolean }> {
  const s = await getActive();
  if (!s || s.stopping) return { ok: false };
  const known = await db
    .eventsOfType(s.id, 'draft_item')
    .filter((e) => e.draft_id === draft_id)
    .count();
  if (!known) return { ok: false };
  await appendEvent(s.id, { type: 'draft_action', t: offsetOf(s), draft_id, action, source });
  return { ok: true };
}
