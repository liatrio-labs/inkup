// Budgeted sections (packages/core/src/process/sections.ts): natural cuts, never between an Annotation and its speech,
// packing within half the output cap, and splitting a chunk that ran out of tokens.
import { describe, expect, it } from 'vitest';
import { buildLongSession } from '../../../scripts/gen-long-session.ts';
import { estimateOutputTokens } from '../src/process/cost';
import {
  cutSections,
  naturalCuts,
  planChunks,
  renumberWindows,
  sectionEstimate,
  splitWindow,
} from '../src/process/sections';
import { owns, sessionLength } from '../src/process/windows';
import { applyTranscriptEdits } from '../src/review-edits';
import type { TimelineEvent } from '../src/timeline';

const MIN = 60_000;
let n = 0;
const seg = (t: number, t_end: number, text = 'this should be blue'): TimelineEvent =>
  ({
    id: `s${++n}`,
    type: 'transcript_segment',
    t,
    t_end,
    segment_id: `seg${n}`,
    text,
    engine: 'deepgram',
    local: false,
    timestamp_quality: 'word',
    words: null,
    confidence: 1,
    run_id: null,
  }) as TimelineEvent;
const ann = (index: number, t: number, t_end: number): TimelineEvent =>
  ({
    id: `a${index}`,
    type: 'annotation',
    t,
    t_end,
    annotation_id: `ann${index}`,
    index,
    stroke_ids: [],
    candidates: [],
    pick: null,
    close_reason: 'time_gap',
    screenshot_id: null,
  }) as unknown as TimelineEvent;
const nav = (t: number): TimelineEvent =>
  ({ id: `n${t}`, type: 'navigation', t, url: '/x', title: 'x' }) as TimelineEvent;
const next = (t: number): TimelineEvent =>
  ({
    id: `v${t}`,
    type: 'voice_command',
    t,
    t_end: t + 400,
    command: 'next',
    phrase: 'next',
    segment_id: 'x',
    target: null,
  }) as unknown as TimelineEvent;
const pause = (t: number): TimelineEvent => ({ id: `p${t}`, type: 'session_pause', t, via: 'button' }) as TimelineEvent;

describe('naturalCuts', () => {
  it('cuts at navigation, pause, `next`, Annotation close and the middle of a long silence', () => {
    const events = [
      seg(1_000, 3_000),
      nav(10_000),
      pause(20_000),
      next(25_000),
      seg(30_000, 32_000),
      seg(50_000, 52_000),
      ann(1, 60_000, 61_000),
    ];
    // Silences ≥ 8 s: 3 s → 30 s (middle 16.5 s) and 32 s → 50 s (middle 41 s). The Annotation closes at 61 s.
    expect(naturalCuts(events, 90_000)).toEqual([10_000, 16_500, 20_000, 25_000, 41_000, 61_000]);
  });

  it('ignores silences shorter than 8 s', () => {
    expect(naturalCuts([seg(0, 2_000), seg(9_000, 11_000)], 20_000)).toEqual([]);
  });

  it('never separates an Annotation from speech inside its pairing window: the cut moves to the end of that speech', () => {
    // Word timestamps: 2 s pairing window. Speech 1 s after the Annotation closes pairs with it.
    const events = [ann(1, 10_000, 12_000), seg(13_000, 16_000), nav(14_000)];
    expect(naturalCuts(events, 60_000)).toEqual([16_000]);
    // Speech 3 s later does not pair, so the close is a cut.
    expect(naturalCuts([ann(1, 10_000, 12_000), seg(15_000, 16_000)], 60_000)).toEqual([12_000]);
  });

  it('never cuts inside a transcript segment', () => {
    expect(naturalCuts([seg(5_000, 9_000), nav(7_000)], 30_000)).toEqual([9_000]);
  });
});

describe('cutSections', () => {
  it('counts live Annotations and segments per section; empty sections join their neighbour; the last one owns everything after its start', () => {
    // Cuts: close at 2.5 s, silence middle at 7 s, navigation at 10 s, close at 12.5 s.
    const events = [
      ann(1, 1_000, 2_000),
      seg(1_500, 2_500),
      nav(10_000),
      ann(2, 11_000, 12_000),
      seg(11_500, 12_500),
      ann(3, 70_000, 71_000),
    ];
    const s = cutSections(events, 65_000);
    expect(s.map((x) => [x.start, x.end, x.annotations, x.segments])).toEqual([
      [0, 10_000, 1, 1],
      [10_000, 12_500, 1, 1],
      [12_500, 65_000, 1, 0],
    ]);
  });
});

describe('planChunks', () => {
  const long = buildLongSession({ minutes: 40 }).doc;
  const events = applyTranscriptEdits(long.events);
  const length = sessionLength(long);

  it('keeps a short Session whose answer fits in one chunk', () => {
    const short = buildLongSession({ minutes: 8 }).doc;
    const w = planChunks(applyTranscriptEdits(short.events), sessionLength(short), { outputCap: 128_000 });
    expect(w).toEqual([{ index: 0, count: 1, start: 0, end: Infinity, from: 0, to: Infinity }]);
  });

  it('cuts 40 minutes into 4 chunks of about 10 minutes, at natural cuts, with the 1-minute overlap', () => {
    const w = planChunks(events, length, { outputCap: 128_000 });
    expect(w).toHaveLength(4);
    const cuts = naturalCuts(events, length);
    for (const x of w.slice(1)) {
      expect(cuts).toContain(x.start);
      expect(x.from).toBe(x.start - MIN);
    }
    for (const x of w.slice(0, -1)) expect(x.to).toBe(x.end + MIN);
    w.slice(1).forEach((x, i) => {
      expect(Math.abs(x.start - (i + 1) * 10 * MIN)).toBeLessThan(MIN);
    });
    // Every Annotation's speech starts in the same chunk as the Annotation.
    for (const e of events) {
      if (e.type !== 'annotation') continue;
      const said = events.find((s) => s.type === 'transcript_segment' && s.segment_id === `seg-${e.index}`);
      if (!said) continue;
      expect(
        w.findIndex((x) => owns(x, e.t)),
        `#${e.index}`,
      ).toBe(w.findIndex((x) => owns(x, said.t)));
    }
  });

  it('adds chunks until each estimated answer is within half the output cap', () => {
    const cap = 12_000;
    const w = planChunks(events, length, { outputCap: cap });
    const sections = cutSections(events, length);
    expect(w.length).toBeGreaterThan(4);
    for (const x of w) {
      const inside = sections.filter((s) => owns(x, s.start));
      const est = estimateOutputTokens(
        inside.reduce((a, s) => a + s.annotations, 0),
        inside.reduce((a, s) => a + s.segments, 0),
      );
      expect(est).toBeLessThanOrEqual(cap / 2);
    }
  });

  it('splits one oversized section at its largest internal silence', () => {
    // Continuous talk (gaps under 8 s) with an Annotation every 3 s: one section. The largest gap is 6 s at 60 s.
    const talk: TimelineEvent[] = [];
    for (let t = 0, i = 1; t < 120_000; t += 3_000, i++) {
      talk.push(ann(i, t, t + 500), seg(t + 600, t + 2_400));
      if (t === 57_000) t += 3_600;
    }
    expect(cutSections(talk, 125_000).length).toBeGreaterThan(1); // the Annotations still close
    const tiny = planChunks(talk, 125_000, { outputCap: 2 * estimateOutputTokens(24, 24), singleMaxMs: 60 * MIN });
    expect(tiny.length).toBeGreaterThan(1);
    // A section with no Annotation close inside: speech only, split at the 6 s gap.
    const speech: TimelineEvent[] = [];
    for (let t = 0; t < 60_000; t += 3_000) speech.push(seg(t, t + (t === 30_000 ? 0 : 2_500)));
    const oneSection = cutSections(speech, 61_000);
    expect(oneSection).toHaveLength(1);
    const split = planChunks(speech, 61_000, { outputCap: 2 * (sectionEstimate(oneSection[0]!) - 700) });
    expect(split).toHaveLength(2);
    expect(split[1]!.start).toBe(31_500);
  });
});

describe('splitWindow', () => {
  const long = buildLongSession({ minutes: 12, everyMs: 12_000 }).doc;
  const events = applyTranscriptEdits(long.events);
  const length = sessionLength(long);

  it('cuts a chunk that ran out of tokens in two at the natural cut that best halves its estimate', () => {
    const [only] = planChunks(events, length, { outputCap: 128_000 });
    const halves = splitWindow(events, only!, length);
    expect(halves).not.toBeNull();
    const [a, b] = renumberWindows(halves!);
    expect([a!.index, b!.index, a!.count, b!.count]).toEqual([0, 1, 2, 2]);
    expect(a!.start).toBe(0);
    expect(a!.end).toBe(b!.start);
    expect(b!.end).toBe(Infinity);
    expect(a!.to).toBe(a!.end + MIN);
    expect(b!.from).toBe(b!.start - MIN);
    expect(naturalCuts(events, length)).toContain(b!.start);
    const count = (x: typeof a) => events.filter((e) => e.type === 'annotation' && owns(x!, e.t)).length;
    expect(Math.abs(count(a) - count(b))).toBeLessThanOrEqual(2);
  });

  it('returns null when there is nothing to cut at', () => {
    const w = { index: 0, count: 1, start: 0, end: Infinity, from: 0, to: Infinity };
    expect(splitWindow([ann(1, 1_000, 2_000), seg(2_100, 3_000)], w, 5_000)).toBeNull();
  });
});
