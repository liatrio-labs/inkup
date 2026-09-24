// `pnpm fixtures:sessions`: writes the Process fixtures in fixtures/sessions (PRD P0-11 (a), (b), (c), (d)).
//
// Each scenario re-times real Annotations captured from the fixture site (fixtures/sessions/captured, made by
// tests/e2e/fixture-capture.spec.ts) and adds hand-authored speech with word timings. Every scenario is written
// in two timestamp modes:
// - word: word-level engine, segments carry words, stamped at the audio time.
// - approximate: Web Speech style, no words, whole segments stamped on arrival (ARRIVAL_DELAY_MS late).
// expected.json holds what `pnpm eval` asserts for each scenario.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSessionDocument, type SessionDocument } from '../packages/core/src/session-document.ts';
import type { EventOf, TimelineEvent, TimestampQuality } from '../packages/core/src/timeline.ts';

export const SESSIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sessions');
/** Captured Sessions, by scenario source: five circled Annotations, or one arrow Connector with no speech. */
export const CAPTURED = {
  annotations: join(SESSIONS_DIR, 'captured', 'pricing-annotations.session.json'),
  arrow: join(SESSIONS_DIR, 'captured', 'pricing-arrow.session.json'),
} as const;
const ARRIVAL_DELAY_MS = 800;

interface Utterance {
  /** Words with start offsets (ms since t0); each word lasts until the next, the last one `lastMs`. */
  words: [string, number][];
  lastMs?: number;
}

interface Scenario {
  name: string;
  description: string;
  /** Which captured Session the Annotations come from (default `annotations`). */
  source?: keyof typeof CAPTURED;
  /** Captured Annotation index → when its first Stroke starts in this scenario (ms since t0). */
  annotations: [number, number][];
  speech: Utterance[];
  expected: {
    category: string;
    /** Role → acceptable selectors (the first is the intended one). */
    locations: Partial<Record<'subject' | 'reference' | 'destination', string[]>>;
  };
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'a-move-here',
    description:
      '"this button" at A (hero CTA), then "should go here" at B (header nav next to Docs): one layout item, subject A, destination B.',
    annotations: [
      [1, 1000],
      [2, 7000],
    ],
    speech: [
      {
        words: [
          ['okay', 800],
          ['so', 1050],
          ['this', 1300],
          ['button', 1500],
        ],
        lastMs: 400,
      },
      {
        words: [
          ['should', 7300],
          ['go', 7550],
          ['here', 7700],
          ['in', 8000],
          ['the', 8100],
          ['header', 8200],
          ['next', 8600],
          ['to', 8800],
          ['docs', 8900],
        ],
        lastMs: 400,
      },
    ],
    expected: {
      category: 'layout',
      locations: { subject: ['button.cta'], destination: ['nav', 'a:nth-of-type(3)', 'header.site-header'] },
    },
  },
  {
    name: 'b-same-height',
    description:
      '"make this card the same height as that one": subject the Basic plan card, reference the Pro plan card.',
    annotations: [
      [5, 1000],
      [4, 3400],
    ],
    speech: [
      {
        words: [
          ['make', 900],
          ['this', 1150],
          ['card', 1400],
          ['the', 2600],
          ['same', 2750],
          ['height', 3000],
          ['as', 3350],
          ['that', 3500],
          ['one', 3750],
        ],
        lastMs: 400,
      },
    ],
    expected: { category: 'layout', locations: { subject: ['#plan-basic'], reference: ['#plan-pro'] } },
  },
  {
    name: 'c-arrow-connector',
    description:
      'An arrow Connector from A (hero CTA) to B (header nav next to Docs) and no speech: one layout item, subject A, destination B.',
    source: 'arrow',
    annotations: [[1, 1000]],
    speech: [],
    expected: {
      category: 'layout',
      locations: { subject: ['button.cta'], destination: ['nav', 'a:nth-of-type(3)', 'header.site-header'] },
    },
  },
  {
    name: 'd-loose-circle-button',
    description:
      'A loose circle around the hero card containing button.cta, with "this button": resolves to the button.',
    annotations: [[3, 1000]],
    speech: [
      {
        words: [
          ['this', 1300],
          ['button', 1500],
          ['should', 1900],
          ['be', 2100],
          ['a', 2200],
          ['darker', 2300],
          ['blue', 2650],
        ],
        lastMs: 400,
      },
    ],
    expected: { category: 'style', locations: { subject: ['button.cta'] } },
  },
  {
    name: 'd-loose-circle-card',
    description: 'The same loose circle, with "this card": resolves to the card.',
    annotations: [[3, 1000]],
    speech: [
      {
        words: [
          ['this', 1300],
          ['card', 1500],
          ['needs', 1900],
          ['a', 2150],
          ['stronger', 2250],
          ['border', 2700],
        ],
        lastMs: 400,
      },
    ],
    expected: { category: 'style', locations: { subject: ['div.hero-card'] } },
  },
];

type Ev<T extends TimelineEvent['type']> = EventOf<T>;

export function build(captured: SessionDocument, s: Scenario, mode: TimestampQuality): SessionDocument {
  const events: TimelineEvent[] = [];
  const blobs: SessionDocument['blobs'] = [];
  const all = captured.events;
  let end = 0;
  const first = all.find((e): e is Ev<'session_start'> => e.type === 'session_start')!;
  events.push({ ...first, t: 0 });

  s.annotations.forEach(([capturedIndex, at], i) => {
    const ann = all.find((e): e is Ev<'annotation'> => e.type === 'annotation' && e.index === capturedIndex)!;
    const delta = at - ann.t;
    const shift = (t: number) => t + delta;
    for (const id of ann.stroke_ids) {
      const st = all.find((e): e is Ev<'stroke'> => e.type === 'stroke' && e.stroke_id === id)!;
      events.push({
        ...st,
        t: shift(st.t),
        t_end: shift(st.t_end),
        points: st.points.map((p) => ({ ...p, t: shift(p.t) })),
      });
    }
    events.push({ ...ann, index: i + 1, t: shift(ann.t), t_end: shift(ann.t_end) });
    const shot = all.find(
      (e): e is Ev<'screenshot'> => e.type === 'screenshot' && e.screenshot_id === ann.screenshot_id,
    )!;
    events.push({ ...shot, t: shift(ann.t_end) + 1500 });
    blobs.push(captured.blobs.find((b) => b.id === shot.screenshot_id)!);
    end = Math.max(end, shift(ann.t_end) + 1500);
  });

  s.speech.forEach((u, i) => {
    const words = u.words.map(([text, t], j) => ({
      text,
      t,
      t_end: j + 1 < u.words.length ? u.words[j + 1]![1] - 50 : t + (u.lastMs ?? 300),
    }));
    const t = words[0]!.t;
    const t_end = words.at(-1)!.t_end;
    const text = words.map((w) => w.text).join(' ');
    const common = {
      id: `seg-${s.name}-${i + 1}`,
      type: 'transcript_segment' as const,
      segment_id: `g${i + 1}`,
      text,
      confidence: null,
      run_id: null,
      target: null,
    };
    events.push(
      mode === 'word'
        ? { ...common, t, t_end, engine: 'elevenlabs', local: false, timestamp_quality: 'word', words }
        : {
            ...common,
            t: t + ARRIVAL_DELAY_MS,
            t_end: t_end + ARRIVAL_DELAY_MS,
            engine: 'webspeech',
            local: true,
            timestamp_quality: 'approximate',
            words: null,
          },
    );
    end = Math.max(end, t_end + ARRIVAL_DELAY_MS);
  });
  end += 1000;
  events.push({ id: `end-${s.name}`, type: 'session_end', t: end, reason: 'stop', duration_ms: end });

  const transcription =
    mode === 'word'
      ? { engine: 'elevenlabs', local: false, timestamp_quality: 'word' as const }
      : { engine: 'webspeech', local: true, timestamp_quality: 'approximate' as const };
  return buildSessionDocument({
    session: {
      ...captured.session,
      id: `fixture-${s.name}-${mode}`,
      duration_ms: end,
      transcription,
      ended_at: new Date(captured.session.t0 + end).toISOString(),
    },
    events,
    blobs,
    audio: null,
    now: new Date('2026-09-22T12:00:00.000Z'),
  });
}

export const loadCaptured = (s: Scenario): SessionDocument =>
  JSON.parse(readFileSync(CAPTURED[s.source ?? 'annotations'], 'utf8')) as SessionDocument;

export const fixtureFile = (name: string, mode: TimestampQuality) => join(SESSIONS_DIR, `${name}.${mode}.json`);

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const s of SCENARIOS) {
    const captured = loadCaptured(s);
    for (const mode of ['word', 'approximate'] as const) {
      writeFileSync(fixtureFile(s.name, mode), `${JSON.stringify(build(captured, s, mode), null, 2)}\n`);
    }
  }
  const expected = Object.fromEntries(SCENARIOS.map((s) => [s.name, { description: s.description, ...s.expected }]));
  writeFileSync(join(SESSIONS_DIR, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
  console.log(`wrote ${SCENARIOS.length * 2} fixtures and expected.json to ${SESSIONS_DIR}`);
}
