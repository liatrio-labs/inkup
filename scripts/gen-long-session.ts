// `pnpm fixtures:long [out.json] [minutes]`: a synthetic long Session (PRD P0-11 long Sessions) for the windowed
// Process proof (tests/unit/adapters/long-session.test.ts). Deterministic.
//
// It re-times the five real Annotations captured from the fixture site (fixtures/sessions/captured) over the whole
// Session, one about every 45 s, so some land right on the 10-minute window boundaries and inside the overlaps.
// Most Annotations get word-timed speech naming them; every 11th gets none (a model may drop it); every 7th is taken
// back with "scratch that". Two Draft Items are pinned (one just before a window boundary, inside the next window's
// overlap) and one is discarded.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSessionDocument, type SessionDocument, screenshotPath } from '../packages/core/src/session-document.ts';
import type { EventOf, TimelineEvent } from '../packages/core/src/timeline.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURED = join(ROOT, 'fixtures/sessions/captured/pricing-annotations.session.json');

type Ev<T extends TimelineEvent['type']> = EventOf<T>;

export interface LongSessionOptions {
  minutes?: number;
  /** ms between Annotation starts. */
  everyMs?: number;
}

/** What the generator put in, for the proof to check against. */
export interface LongSessionTruth {
  annotations: number;
  scratched: number[];
  silent: number[];
  pinned: { draft_id: string; annotation: number; title: string }[];
  discarded: string[];
}

const COLORS = ['blue', 'green', 'orange', 'purple', 'teal', 'gray', 'red'];
const NOUN: Record<string, string> = {
  'button.cta': 'button',
  nav: 'navigation',
  'div.hero-card': 'card',
  '#plan-pro': 'card',
  '#plan-basic': 'card',
};

export function buildLongSession(opts: LongSessionOptions = {}): { doc: SessionDocument; truth: LongSessionTruth } {
  const captured = JSON.parse(readFileSync(CAPTURED, 'utf8')) as SessionDocument;
  const templates = captured.events.filter((e): e is Ev<'annotation'> => e.type === 'annotation');
  const strokeOf = new Map(
    captured.events.filter((e): e is Ev<'stroke'> => e.type === 'stroke').map((s) => [s.stroke_id, s]),
  );
  const duration = (opts.minutes ?? 40) * 60_000;
  const every = opts.everyMs ?? 45_000;
  const start = captured.events.find((e): e is Ev<'session_start'> => e.type === 'session_start')!;

  const events: TimelineEvent[] = [{ ...start, t: 0, clicked_at: null }];
  const blobs: SessionDocument['blobs'] = [];
  const truth: LongSessionTruth = { annotations: 0, scratched: [], silent: [], pinned: [], discarded: [] };
  const annotationIds: string[] = [];
  let n = 0;
  for (let at = 5_000; at + 10_000 < duration; at += every) {
    n++;
    const tpl = templates[(n - 1) % templates.length]!;
    const delta = at - tpl.t;
    const shift = (t: number) => t + delta;
    const annId = `ann-${n}`;
    annotationIds.push(annId);
    const strokeIds = tpl.stroke_ids.map((id) => `${id}-${n}`);
    tpl.stroke_ids.forEach((id, i) => {
      const st = strokeOf.get(id)!;
      events.push({
        ...st,
        id: `ev-stroke-${n}-${i}`,
        stroke_id: strokeIds[i]!,
        t: shift(st.t),
        t_end: shift(st.t_end),
        points: st.points.map((p) => ({ ...p, t: shift(p.t) })),
      });
    });
    const shot = `shot-${String(n).padStart(3, '0')}`;
    events.push({
      ...tpl,
      id: `ev-ann-${n}`,
      annotation_id: annId,
      index: n,
      t: shift(tpl.t),
      t_end: shift(tpl.t_end),
      stroke_ids: strokeIds,
      screenshot_id: shot,
    });
    const shotAt = shift(tpl.t_end) + 300;
    events.push({
      id: `ev-shot-${n}`,
      type: 'screenshot',
      t: shotAt,
      screenshot_id: shot,
      path: screenshotPath(shot),
      mime: 'image/png',
      trigger: 'annotation',
      annotation_id: annId,
      url: tpl.url,
      scroll: tpl.scroll,
      viewport: tpl.viewport,
      dpr: tpl.dpr,
    });
    blobs.push({ id: shot, kind: 'screenshot', mime: 'image/png', size: 40_000, path: screenshotPath(shot) });

    const pick = tpl.pick !== null ? tpl.candidates[tpl.pick]!.selector : 'page';
    if (n % 11 === 0) {
      truth.silent.push(n);
    } else {
      const say = ['this', NOUN[pick] ?? 'part', 'should', 'be', COLORS[n % COLORS.length]!, 'number', String(n)];
      const t0 = shift(tpl.t) + 200;
      const words = say.map((text, i) => ({ text, t: t0 + i * 250, t_end: t0 + i * 250 + 200 }));
      events.push({
        id: `ev-seg-${n}`,
        type: 'transcript_segment',
        t: words[0]!.t,
        t_end: words.at(-1)!.t_end,
        segment_id: `seg-${n}`,
        text: say.join(' '),
        engine: 'deepgram',
        local: false,
        timestamp_quality: 'word',
        words,
        confidence: 0.95,
        run_id: null,
        target: null,
      });
    }
    if (n % 7 === 0) {
      truth.scratched.push(n);
      const t = shift(tpl.t_end) + 2_500;
      events.push({
        id: `ev-seg-scratch-${n}`,
        type: 'transcript_segment',
        t,
        t_end: t + 600,
        segment_id: `seg-scratch-${n}`,
        text: 'scratch that',
        engine: 'deepgram',
        local: false,
        timestamp_quality: 'word',
        words: [
          { text: 'scratch', t, t_end: t + 250 },
          { text: 'that', t: t + 300, t_end: t + 600 },
        ],
        confidence: 0.95,
        run_id: null,
        target: null,
      });
      events.push({
        id: `ev-vc-${n}`,
        type: 'voice_command',
        t,
        t_end: t + 600,
        command: 'scratch_that',
        phrase: 'scratch that',
        segment_id: `seg-scratch-${n}`,
        target: { kind: 'annotation', id: annId },
      });
    }
  }
  truth.annotations = n;

  // Draft Items: pin the Annotation just before the 10-minute boundary and one mid-Session; discard another.
  const annT = (i: number) => (events.find((e) => e.type === 'annotation' && e.index === i) as Ev<'annotation'>).t_end;
  const nearest = (ms: number) => {
    let best = 1;
    for (let i = 1; i <= n; i++)
      if (!truth.scratched.includes(i) && !truth.silent.includes(i) && annT(i) < ms && ms - annT(i) < ms - annT(best))
        best = i;
    return best;
  };
  const draft = (id: string, index: number, action: 'pin' | 'discard') => {
    const a = events.find((e) => e.type === 'annotation' && e.index === index) as Ev<'annotation'>;
    const pick = a.candidates[a.pick ?? 0]!;
    const title = `Recolor ${pick.selector} (#${index})`;
    events.push({
      id: `ev-${id}`,
      type: 'draft_item',
      t: a.t_end + 3_500,
      draft_id: id,
      pass_id: `pass-${id}`,
      model: 'claude-haiku-4-5-20251001',
      title,
      category: 'style',
      intent: `The reviewer wants ${pick.selector} in a different color.`,
      transcript: `this should be ${COLORS[index % COLORS.length]} number ${index}`,
      locations: [{ role: 'subject', element: pick.name || pick.selector, selector: pick.selector, annotation: index }],
      annotation_ids: [a.annotation_id],
    });
    events.push({
      id: `ev-${id}-action`,
      type: 'draft_action',
      t: a.t_end + 5_000,
      draft_id: id,
      action,
      source: action === 'pin' ? 'voice' : 'click',
    });
    if (action === 'pin') truth.pinned.push({ draft_id: id, annotation: index, title });
    else truth.discarded.push(id);
  };
  draft('d1', nearest(10 * 60_000 - 5_000), 'pin');
  draft('d2', nearest(25 * 60_000), 'pin');
  draft('d3', nearest(33 * 60_000), 'discard');

  events.push({ id: 'ev-end', type: 'session_end', t: duration, reason: 'stop', duration_ms: duration });
  const doc = buildSessionDocument({
    session: {
      ...captured.session,
      id: `synthetic-long-${opts.minutes ?? 40}min`,
      duration_ms: duration,
      ended_at: new Date(captured.session.t0 + duration).toISOString(),
      transcription: { engine: 'deepgram', local: false, timestamp_quality: 'word' },
    },
    events,
    blobs,
    audio: null,
    now: new Date('2026-09-22T12:00:00.000Z'),
  });
  return { doc, truth };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] ?? join(ROOT, 'fixtures/sessions/long-40min.json');
  const minutes = Number(process.argv[3] ?? 40);
  const { doc, truth } = buildLongSession({ minutes });
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(
    `wrote ${out}: ${minutes} min, ${truth.annotations} Annotations (${truth.scratched.length} scratched, ${truth.silent.length} without speech), ${truth.pinned.length} pinned drafts`,
  );
}
