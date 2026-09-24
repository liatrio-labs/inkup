// VAD alignment of late speech (src/process/align.ts): approximate segments are moved onto the VAD's speech spans
// before pairing, so pairing compares when the reviewer spoke with when they drew.
import { describe, expect, it } from 'vitest';
import { alignSegments, isVadAligned, type ProcessSegment, spokenSpan } from '../src/process';
import { type TimelineEvent, TimelineEventSchema } from '../src/timeline';

let n = 0;
const seg = (t: number, t_end: number, text = 'make this bigger', quality: 'approximate' | 'word' = 'approximate') =>
  TimelineEventSchema.parse({
    id: `seg-${++n}`,
    type: 'transcript_segment',
    t,
    t_end,
    segment_id: `s${n}`,
    text,
    engine: quality === 'word' ? 'deepgram' : 'webspeech',
    local: true,
    timestamp_quality: quality,
    words: quality === 'word' ? [{ text, t, t_end }] : null,
    confidence: null,
    run_id: null,
    target: null,
  });
const vad = (t: number, t_end: number) =>
  TimelineEventSchema.parse({ id: `vad-${++n}`, type: 'speech_activity', t, t_end });

const segments = (events: readonly TimelineEvent[]) =>
  events.filter((e): e is ProcessSegment => e.type === 'transcript_segment');
const times = (events: readonly TimelineEvent[]) => segments(events).map((s) => [s.t, s.t_end]);

describe('alignSegments', () => {
  it('fixed 0.5 s lag: the segment moves onto its span and keeps its arrival times', () => {
    const out = segments(alignSegments([vad(1000, 2500), seg(1500, 3000)]));
    expect(out[0]).toMatchObject({ t: 1000, t_end: 2500, vad: { t_arrived: 1500, t_end_arrived: 3000 } });
    expect(isVadAligned(out[0]!)).toBe(true);
  });

  it('fixed 1.5 s lag', () => {
    expect(times(alignSegments([vad(1000, 2500), seg(2500, 4000)]))).toEqual([[1000, 2500]]);
  });

  it('variable lag: each segment finds its own utterance', () => {
    const events = [
      vad(1000, 2000),
      seg(1400, 2600), // 0.4 s to the first interim, 0.6 s to the final
      vad(4000, 5200),
      seg(5000, 7000), // 1.0 s, 1.8 s
      vad(8000, 9000),
      seg(9500, 11_000), // 1.5 s, 2.0 s
    ];
    expect(times(alignSegments(events))).toEqual([
      [1000, 2000],
      [4000, 5200],
      [8000, 9000],
    ]);
  });

  it('a long utterance spans several VAD spans with short gaps', () => {
    const events = [vad(1000, 2000), vad(2400, 3500), vad(3900, 5000), seg(1800, 5600)];
    expect(times(alignSegments(events))).toEqual([[1000, 5000]]);
  });

  it('one final across a long pause: from the span its first interim came in to the last one before the final', () => {
    expect(times(alignSegments([vad(1000, 1200), vad(3300, 5000), seg(1100, 5700)]))).toEqual([[1000, 5000]]);
  });

  it('speech that began long before the first interim is not this segment', () => {
    // The VAD heard only an earlier "um" (1.0–1.4 s); the words that gave the first interim at 5.0 s were not heard.
    expect(times(alignSegments([vad(1000, 1400), seg(5000, 6000)]))).toEqual([[5000, 6000]]);
  });

  it('without VAD spans nothing changes', () => {
    const events = [seg(1500, 3000), seg(4000, 5000)];
    const out = alignSegments(events);
    expect(out).toEqual(events);
    expect(segments(out).some(isVadAligned)).toBe(false);
  });

  it('two segments near one span share it in order: the second starts where the first ended', () => {
    // Web Speech split one breath into two finals; the first arrived while the speech went on.
    const out = segments(alignSegments([vad(1000, 4000), seg(1500, 2600, 'this one'), seg(2800, 4600, 'and that')]));
    expect(out.map((s) => [s.t, s.t_end, isVadAligned(s)])).toEqual([
      [1000, 2600, true],
      [2600, 4000, true],
    ]);
  });

  it('never gives a span to a later segment once an earlier one ended after it', () => {
    const out = segments(alignSegments([vad(1000, 2000), seg(1400, 2600), seg(2700, 3100, 'um')]));
    expect(out.map(isVadAligned)).toEqual([true, false]);
    expect(out[1]).toMatchObject({ t: 2700, t_end: 3100 });
  });

  it('a segment nothing explains holds back the ones after it, so none moves before it', () => {
    // The span began 2.6 s before the first segment's first interim: too long before to be its speech.
    const out = segments(alignSegments([vad(1000, 5000), seg(3600, 4000, 'unheard'), seg(3700, 5600)]));
    expect(out.map((s) => [s.t, s.t_end, isVadAligned(s)])).toEqual([
      [3600, 4000, false],
      [4000, 5000, true],
    ]);
  });

  it('a span that starts after the first interim does not explain the segment', () => {
    // The VAD missed this utterance; the next one began before its final arrived.
    expect(times(alignSegments([vad(3000, 3400), seg(2000, 3200)]))).toEqual([[2000, 3200]]);
  });

  it('leaves word-level segments alone and is idempotent', () => {
    const events = [vad(1000, 2000), seg(1100, 1900, 'this', 'word'), vad(4000, 5000), seg(4600, 5600)];
    const once = alignSegments(events);
    expect(times(once)).toEqual([
      [1100, 1900],
      [4000, 5000],
    ]);
    expect(alignSegments(once)).toEqual(once);
  });

  it('spokenSpan takes unsorted spans', () => {
    expect(
      spokenSpan({ t: 1800, t_end: 5600 }, [
        { t: 3900, t_end: 5000 },
        { t: 1000, t_end: 2000 },
        { t: 2400, t_end: 3500 },
      ]),
    ).toEqual({ t: 1000, t_end: 5000 });
  });
});
