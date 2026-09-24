// Voice Command matching and the silence gate (PRD P0-8), on synthetic VAD traces and transcripts.
import { describe, expect, it } from 'vitest';
import { type ActivityEdge, createSpeechActivityTracker } from '../src/speech-activity';
import type { TimelineEvent } from '../src/timeline';
import { resolvePinTarget, resolveScratchTarget, stripCommandPhrase } from '../src/voice-command-effects';
import {
  type ActivityInput,
  createCommandWatcher,
  findCommands,
  MIN_SILENCE_MS,
  matchCommand,
  tokenize,
  type WatchedSegment,
} from '../src/voice-commands';

describe('normalizing and matching phrases', () => {
  it('lower-cases, drops punctuation and fillers, spells out numbers', () => {
    expect(tokenize('Um, Scratch THAT!').map((t) => t.norm)).toEqual(['scratch', 'that']);
    expect(tokenize('snap 2 of them').map((t) => t.norm)).toEqual(['snap', 'two', 'of', 'them']);
    expect(tokenize("that's it").map((t) => t.norm)).toEqual(["that's", 'it']);
  });

  it.each([
    ['scratch that', 'scratch_that', 'fuzzy'],
    ['Scratch that.', 'scratch_that', 'fuzzy'],
    ['scratch dat', 'scratch_that', 'fuzzy'],
    ['Next', 'next', 'fuzzy'],
    ['new note', 'next', 'fuzzy'],
    ['pin that', 'pin_that', 'fuzzy'],
    ['Snap!', 'snap', 'fuzzy'],
    ['Pause.', 'pause', 'fuzzy'],
    ['paws', 'pause', 'phonetic'],
    ['resume', 'resume', 'fuzzy'],
    ['okay resume', 'resume', 'fuzzy'],
  ] as const)('"%s" → %s (%s)', (text, command, via) => {
    expect(matchCommand(text)).toMatchObject({ command, via, whole: true });
  });

  it.each(['text', 'this button', 'make it smaller', 'snapshot', 'rest', 'scratch'])(
    '"%s" is not a command',
    (text) => {
      expect(matchCommand(text)).toBeNull();
    },
  );

  it('finds a phrase inside a longer sentence but marks it as not the whole segment', () => {
    const [m] = findCommands('The video should pause here');
    expect(m).toMatchObject({ command: 'pause', phrase: 'pause', whole: false });
  });

  it('keeps the original spelling of the phrase for stripping', () => {
    expect(matchCommand('Okay, Scratch that.')!.phrase).toBe('Scratch that');
  });
});

/** A VAD trace: speech spans in ms, VAD ready at `ready`. */
function trace(watcher: ReturnType<typeof createCommandWatcher>, spans: [number, number][], ready = 0) {
  watcher.activity({ type: 'ready', t: ready });
  for (const [a, b] of spans) {
    watcher.activity({ type: 'speech_start', t: a });
    watcher.activity({ type: 'speech_end', start: a, t: b });
  }
}
const approx = (text: string, t: number, t_end: number, segment_id = 'g1'): WatchedSegment => ({
  segment_id,
  text,
  t,
  t_end,
  timestamp_quality: 'approximate',
  words: null,
});
const wordSeg = (words: [string, number, number][], segment_id = 'g1'): WatchedSegment => ({
  segment_id,
  text: words.map((w) => w[0]).join(' '),
  t: words[0]![1],
  t_end: words.at(-1)![2],
  timestamp_quality: 'word',
  words: words.map(([text, t, t_end]) => ({ text, t, t_end })),
});

describe('silence gate, approximate timestamps (Web Speech)', () => {
  it('confirms "scratch that" said between silences, once the trailing silence has passed', () => {
    const w = createCommandWatcher();
    // "this button" … 1.5 s … "scratch that" … silence (the fixture WAV's shape)
    trace(w, [
      [500, 1300],
      [2800, 3600],
    ]);
    expect(w.segment(approx('scratch that', 3300, 4100))).toMatchObject({ command: 'scratch_that' });
    expect(w.tick(4200)).toEqual({ confirmed: [], rejected: [] });
    expect(w.pending).toBe(1);
    const { confirmed } = w.tick(3600 + MIN_SILENCE_MS + 300);
    expect(confirmed).toEqual([
      expect.objectContaining({
        command: 'scratch_that',
        phrase: 'scratch that',
        segment_id: 'g1',
        t: 2800,
        t_end: 3600,
      }),
    ]);
    expect(w.pending).toBe(0);
  });

  it('"the video should pause here" in one segment is not a command', () => {
    const w = createCommandWatcher();
    trace(w, [[1000, 2600]]);
    expect(w.segment(approx('the video should pause here', 1500, 3200))).toBeNull();
    expect(w.pending).toBe(0);
  });

  it('a recognizer that splits "pause" out of continuous speech does not pause: the speech island is too long', () => {
    const w = createCommandWatcher();
    trace(w, [[1000, 3400]]);
    w.segment(approx('the video should', 1300, 2300, 'a'));
    w.segment(approx('pause', 2300, 2900, 'b'));
    w.segment(approx('here when it loads', 2900, 3900, 'c'));
    expect(w.tick(6000)).toEqual({
      confirmed: [],
      rejected: [{ phrase: 'pause', reason: 'speech too long for the phrase' }],
    });
  });

  it('rejects when speech resumes within the silence window', () => {
    const w = createCommandWatcher();
    trace(w, [
      [2000, 2500],
      [2900, 4200],
    ]);
    w.segment(approx('pause', 2400, 3100));
    expect(w.tick(6000).rejected).toHaveLength(1);
  });

  it('rejects when the VAD had not seen a second of silence before the phrase', () => {
    const w = createCommandWatcher();
    trace(w, [[1600, 2100]], 1200);
    w.segment(approx('snap', 1900, 2600));
    expect(w.tick(4000).rejected).toEqual([{ phrase: 'snap', reason: 'no silence observed before the phrase' }]);
  });

  it('rejects everything without VAD data', () => {
    const w = createCommandWatcher();
    w.segment(approx('next', 1000, 1500));
    expect(w.tick(4000).rejected).toEqual([{ phrase: 'next', reason: 'no voice activity data' }]);
  });

  it('waits while speech is still going on, then decides', () => {
    const w = createCommandWatcher();
    w.activity({ type: 'ready', t: 0 });
    w.activity({ type: 'speech_start', t: 2000 });
    w.segment(approx('resume', 2300, 2600));
    expect(w.tick(3000)).toEqual({ confirmed: [], rejected: [] });
    w.activity({ type: 'speech_end', start: 2000, t: 2500 });
    expect(w.tick(3200)).toEqual({ confirmed: [], rejected: [] });
    expect(w.tick(3600).confirmed.map((c) => c.command)).toEqual(['resume']);
  });
});

describe('silence gate, word-level timestamps', () => {
  it('confirms an isolated phrase whose words sit inside the speech island', () => {
    const w = createCommandWatcher();
    trace(w, [[3000, 3500]]);
    w.segment(wordSeg([['pause', 3050, 3450]]));
    expect(w.tick(5000).confirmed.map((c) => [c.command, c.t, c.t_end])).toEqual([['pause', 3000, 3500]]);
  });

  it('"the video should pause here" spoken continuously is rejected: speech right before the phrase', () => {
    const w = createCommandWatcher();
    trace(w, [[1000, 2700]]);
    w.segment(
      wordSeg([
        ['the', 1000, 1150],
        ['video', 1150, 1500],
        ['should', 1500, 1800],
        ['pause', 1800, 2250],
        ['here', 2250, 2650],
      ]),
    );
    expect(w.tick(5000)).toEqual({
      confirmed: [],
      rejected: [{ phrase: 'pause', reason: 'speech right before the phrase' }],
    });
  });

  it('a phrase at the end of a segment after a real pause counts, and only the phrase is reported', () => {
    const w = createCommandWatcher();
    trace(w, [
      [1000, 3000],
      [4200, 5000],
    ]);
    const seg = wordSeg([
      ['make', 1000, 1300],
      ['it', 1300, 1450],
      ['smaller', 1450, 2950],
      ['Scratch', 4250, 4600],
      ['that.', 4600, 4950],
    ]);
    w.segment(seg);
    expect(w.tick(6100).confirmed).toEqual([
      expect.objectContaining({ command: 'scratch_that', phrase: 'Scratch that', t: 4200, t_end: 5000 }),
    ]);
  });

  it('rejects a phrase followed too closely by more speech', () => {
    const w = createCommandWatcher();
    trace(w, [[3000, 4400]]);
    w.segment(
      wordSeg([
        ['next', 3000, 3400],
        ['we', 3500, 3700],
        ['look', 3700, 4000],
      ]),
    );
    expect(w.tick(6000).rejected.map((r) => r.reason)).toEqual(['speech right after the phrase']);
  });
});

describe('speech activity tracker', () => {
  const run = (probs: number[], ms = 32) => {
    const tr = createSpeechActivityTracker();
    const edges: ActivityEdge[] = [];
    probs.forEach((p, i) => {
      edges.push(...tr.frame(i * ms, p, ms));
    });
    return { edges, flush: (t: number) => tr.flush(t) };
  };

  it('emits a start once speech lasts 90 ms and an end after 160 ms of quiet, stamped at the first quiet frame', () => {
    const probs = [...Array(10).fill(0.05), ...Array(20).fill(0.9), ...Array(10).fill(0.05)];
    const { edges } = run(probs);
    expect(edges).toEqual([
      { type: 'speech_start', t: 320 },
      { type: 'speech_end', start: 320, t: 960 },
    ]);
  });

  it('ignores clicks shorter than 90 ms', () => {
    expect(run([0, 0.9, 0.9, 0, 0, 0, 0, 0, 0, 0]).edges).toEqual([]);
  });

  it('bridges dips shorter than the hangover', () => {
    const probs = [...Array(10).fill(0.9), 0.1, 0.1, 0.1, ...Array(10).fill(0.9), ...Array(8).fill(0)];
    expect(run(probs).edges.map((e) => e.type)).toEqual(['speech_start', 'speech_end']);
  });

  it('flush closes open speech', () => {
    const { edges, flush } = run(Array(10).fill(0.9));
    expect(edges).toEqual([{ type: 'speech_start', t: 0 }]);
    expect(flush(400)).toEqual([{ type: 'speech_end', start: 0, t: 400 }]);
  });

  it('feeds the watcher end to end', () => {
    // 1 s silence, 0.6 s "snap", 1.2 s silence.
    const probs = [...Array(31).fill(0.02), ...Array(19).fill(0.95), ...Array(38).fill(0.02)];
    const tr = createSpeechActivityTracker();
    const w = createCommandWatcher();
    w.activity({ type: 'ready', t: 0 });
    probs.forEach((p, i) => {
      tr.frame(i * 32, p, 32).forEach((e) => {
        w.activity(e as ActivityInput);
      });
    });
    w.segment(approx('snap', 1500, 1900));
    expect(w.tick(88 * 32).confirmed.map((c) => c.command)).toEqual(['snap']);
  });
});

describe('command targets and stripping', () => {
  const ann = (id: string, t: number): TimelineEvent =>
    ({ id, type: 'annotation', t, t_end: t + 500, annotation_id: id }) as unknown as TimelineEvent;
  const scratch = (id: string, t: number): TimelineEvent => ({
    id: `v${t}`,
    type: 'voice_command',
    t,
    t_end: t,
    command: 'scratch_that',
    phrase: 'scratch that',
    segment_id: null,
    target: { kind: 'annotation', id },
  });
  const draft = (draft_id: string, t: number): TimelineEvent => ({
    id: draft_id,
    type: 'draft_item',
    t,
    draft_id,
    pass_id: 'p1',
    model: 'm',
    title: 'x',
    category: 'layout',
    intent: 'x',
    transcript: '',
    locations: [],
    annotation_ids: [],
  });

  it('scratch that takes the latest Annotation, then the one before it', () => {
    const events = [ann('a1', 1000), ann('a2', 5000)];
    expect(resolveScratchTarget(events)).toEqual({ kind: 'annotation', id: 'a2' });
    expect(resolveScratchTarget([...events, scratch('a2', 7000)])).toEqual({ kind: 'annotation', id: 'a1' });
    expect(resolveScratchTarget([...events, scratch('a2', 7000), scratch('a1', 8000)])).toBeNull();
  });

  it('a newer Draft Item wins over the Annotation it covers (Slice 5)', () => {
    expect(resolveScratchTarget([ann('a1', 1000), draft('d1', 3000)])).toEqual({ kind: 'draft_item', id: 'd1' });
    expect(resolveScratchTarget([draft('d1', 500), ann('a1', 1000)])).toEqual({ kind: 'annotation', id: 'a1' });
    const discarded: TimelineEvent = {
      id: 'x',
      type: 'draft_action',
      t: 3500,
      draft_id: 'd1',
      action: 'discard',
      source: 'click',
    };
    expect(resolveScratchTarget([ann('a1', 1000), draft('d1', 3000), discarded])).toEqual({
      kind: 'annotation',
      id: 'a1',
    });
  });

  it('pin that takes the latest Draft Item not yet pinned, or nothing', () => {
    expect(resolvePinTarget([ann('a1', 1000)])).toBeNull();
    expect(resolvePinTarget([draft('d1', 1000), draft('d2', 2000)])).toEqual({ kind: 'draft_item', id: 'd2' });
    const pinned: TimelineEvent = {
      id: 'p',
      type: 'draft_action',
      t: 2500,
      draft_id: 'd2',
      action: 'pin',
      source: 'voice',
    };
    expect(resolvePinTarget([draft('d1', 1000), draft('d2', 2000), pinned])).toEqual({ kind: 'draft_item', id: 'd1' });
  });

  it('the latest action on a draft wins: a pinned draft can still be scratched, and pin that skips discarded ones', () => {
    const pin: TimelineEvent = {
      id: 'p',
      type: 'draft_action',
      t: 2500,
      draft_id: 'd1',
      action: 'pin',
      source: 'voice',
    };
    const discard: TimelineEvent = {
      id: 'q',
      type: 'draft_action',
      t: 2600,
      draft_id: 'd1',
      action: 'discard',
      source: 'click',
    };
    expect(resolveScratchTarget([draft('d1', 2000), pin])).toEqual({ kind: 'draft_item', id: 'd1' });
    expect(resolvePinTarget([draft('d1', 2000), pin, discard])).toBeNull();
    expect(resolveScratchTarget([draft('d1', 2000), pin, discard])).toBeNull();
  });

  it.each([
    ['scratch that', 'scratch that', ''],
    ['Scratch that.', 'Scratch that', ''],
    ['make it smaller. Scratch that.', 'Scratch that', 'make it smaller.'],
    ['okay, next', 'next', 'okay'],
    ['this button', 'pause', 'this button'],
  ])('strip(%j, %j) → %j', (text, phrase, out) => {
    expect(stripCommandPhrase(text, phrase)).toBe(out);
  });
});
