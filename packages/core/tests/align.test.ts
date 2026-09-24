// VAD alignment of late speech (src/process/align.ts): approximate segments are moved onto the VAD's speech spans
// before pairing, so pairing compares when the reviewer spoke with when they drew.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixtureFile } from '../../../scripts/gen-session-fixtures.ts';
import { alignmentRows, alignmentTable, loadEvents, VAD_FIXTURES_DIR } from '../../../scripts/vad-alignment-report.ts';
import {
  alignSegments,
  buildProcessPrompt,
  buildSystemPrompt,
  isVadAligned,
  MIN_SPEECH_MS,
  PAIRING_WINDOW_MS,
  type ProcessSegment,
  pairSegment,
  SPEECH_LEAD_MS,
  segmentQuality,
  sessionTimestampQuality,
  spokenSpan,
} from '../src/process';
import { type SessionDocument, SessionDocumentSchema } from '../src/session-document';
import { speechBoundaryAt } from '../src/speech-boundary';
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

describe('pairing with VAD-aligned speech', () => {
  const ann = (index: number, t: number, t_end: number) => ({ index, t, t_end });

  it('aligned segments pair within 2.5 s and do not make the Session approximate', () => {
    const [aligned, late] = segments(alignSegments([vad(1000, 2000), seg(1600, 2700), seg(8000, 9000)]));
    expect(PAIRING_WINDOW_MS.vad).toBe(2500);
    expect(segmentQuality(aligned!)).toBe('vad');
    expect(sessionTimestampQuality([aligned!])).toBe('vad');
    expect(sessionTimestampQuality([aligned!, late!])).toBe('approximate');
  });

  it('pairs "this" with the Annotation drawn while it was said, not the next one', () => {
    // Said 1.2–2.4 s while circling #1 (1.0–2.0 s); Web Speech stamped it 3.2–4.4 s. #2 was drawn at 5.0–6.0 s.
    const annotations = [ann(1, 1000, 2000), ann(2, 5000, 6000)];
    const raw = seg(3200, 4400);
    const before = pairSegment(raw as ProcessSegment, annotations, 'approximate');
    expect(before[0]!.annotations).toEqual([2, 1]);

    const [aligned] = segments(alignSegments([vad(1200, 2400), raw]));
    const after = pairSegment(aligned!, annotations, segmentQuality(aligned!));
    expect(after[0]!.annotations).toEqual([1]);
  });
});

describe('script with VAD-aligned speech', () => {
  const load = (): SessionDocument =>
    SessionDocumentSchema.parse(JSON.parse(readFileSync(fixtureFile('a-move-here', 'approximate'), 'utf8')));
  // a-move-here: #1 drawn 1.0–1.8 s, "okay so this button" stamped 1.6–2.7 s; #2 drawn 7.0–7.8 s, "should go here…"
  // stamped 8.1–10.1 s.
  const withSpans = (doc: SessionDocument, spans: [number, number][]): SessionDocument => ({
    ...doc,
    events: [...doc.events, ...spans.map(([t, t_end]) => vad(t, t_end))],
  });

  it('says the speech is VAD-aligned and uses its times', () => {
    const { script, context } = buildProcessPrompt(
      withSpans(load(), [
        [800, 1900],
        [7300, 9300],
      ]),
    );
    expect(script.split('\n').slice(0, 2)).toEqual([
      'TIMESTAMP QUALITY: approximate, VAD-aligned',
      'PAIRING WINDOW: 2.5s',
    ]);
    expect(context.quality).toBe('vad');
    expect(script).toContain('SPEECH "okay so this button" · 00:00.8–00:01.9 · demonstratives: "this" near #1');
    expect(script).toContain('00:07.3–00:09.3 · demonstratives: "here" near #2');
    expect(script).not.toContain(' · late');
  });

  it('marks the speech still stamped on arrival when only some was aligned', () => {
    const { script } = buildProcessPrompt(withSpans(load(), [[800, 1900]]));
    expect(script.split('\n').slice(0, 2)).toEqual([
      'TIMESTAMP QUALITY: approximate, VAD-aligned except SPEECH marked "late"',
      'PAIRING WINDOW: 2.5s (4s for late speech)',
    ]);
    expect(script).toMatch(/SPEECH "okay so this button" · 00:00\.8–00:01\.9 · demonstratives/);
    expect(script).toMatch(/SPEECH "should go here in the header next to docs" · 00:08\.1–00:10\.1 · late · /);
  });

  it('without spans the script is as before', () => {
    const doc = load();
    expect(buildProcessPrompt(withSpans(doc, [])).script).toBe(buildProcessPrompt(doc).script);
    expect(buildProcessPrompt(doc).script.split('\n')[0]).toBe('TIMESTAMP QUALITY: approximate');
  });
});

describe('Speech Boundary with VAD speech starts', () => {
  const late = { t: 3200, text: 'and this card should match', words: null };
  it('an approximate segment starts at the latest VAD speech start before its first interim', () => {
    expect(speechBoundaryAt(late, [500, 1200, 2100, 3500])).toBe(2100);
  });
  it('only within 2.5 s; otherwise at its own start', () => {
    expect(speechBoundaryAt({ ...late, t: 9000 }, [6400])).toBe(9000);
    expect(speechBoundaryAt({ ...late, t: 9000 }, [6600])).toBe(6600);
    expect(speechBoundaryAt(late)).toBe(3200);
  });
  it('word-level segments ignore the VAD', () => {
    expect(speechBoundaryAt({ t: 1000, text: 'this', words: [{ text: 'this', t: 1000, t_end: 1200 }] }, [900])).toBe(
      1000,
    );
  });
});

describe('real Sessions (fixtures/vad-alignment: Web Speech with Silero VAD spans)', () => {
  const files = readdirSync(VAD_FIXTURES_DIR).filter((f) => f.endsWith('.json'));

  it.each(files)('%s: every aligned segment moved earlier, within the lead, in order', (file) => {
    const events = loadEvents(join(VAD_FIXTURES_DIR, file));
    const aligned = segments(alignSegments(events));
    expect(aligned.filter(isVadAligned).length).toBeGreaterThan(aligned.length / 2);
    let prevEnd = -Infinity;
    for (const s of aligned) {
      if (s.vad) {
        expect(s.t).toBeLessThanOrEqual(s.vad.t_arrived);
        expect(s.t).toBeGreaterThanOrEqual(s.vad.t_arrived - SPEECH_LEAD_MS);
        expect(s.t_end).toBeLessThanOrEqual(s.vad.t_end_arrived);
        expect(s.t_end - s.t).toBeGreaterThanOrEqual(MIN_SPEECH_MS);
        expect(s.t).toBeGreaterThanOrEqual(prevEnd);
      }
      prevEnd = s.t_end;
    }
  });

  it.each(files)('%s: before/after pairing table', (file) => {
    expect(alignmentTable(alignmentRows(loadEvents(join(VAD_FIXTURES_DIR, file))))).toMatchSnapshot();
  });
});

describe('a "that" with no mark near refers back (fixtures/vad-alignment/session-header.json, segment 5)', () => {
  // The fixture keeps only each Annotation's number and times: give them the rest from a captured one.
  const doc = (): SessionDocument => {
    const base = SessionDocumentSchema.parse(
      JSON.parse(readFileSync(fixtureFile('a-move-here', 'approximate'), 'utf8')),
    );
    const template = base.events.find((e) => e.type === 'annotation')!;
    const events = loadEvents(join(VAD_FIXTURES_DIR, 'session-header.json')).map((e) =>
      e.type === 'annotation' ? { ...template, ...e, stroke_ids: [], screenshot_id: null } : e,
    );
    return { ...base, events: [base.events[0]!, ...events] };
  };

  it('the aligned "that", 2.9 s after the title scribble #3, points back to what the sentence before pointed at', () => {
    const { script } = buildProcessPrompt(doc());
    const line = script.split('\n').find((l) => l.includes('SPEECH') && l.includes('00:29.1–00:35.8'));
    expect(line).toContain('"that" near none (refers back: #3, #2)');
    // The sentence before it, still stamped on arrival, pointed at the scribble.
    expect(script).toMatch(/SPEECH [^\n]*00:20\.8–00:29\.1 · late · demonstratives: "this" near #3, #2/);
  });

  it('the system prompt explains the hint, and the table says "that" refers back', () => {
    const system = buildSystemPrompt();
    expect(system).toContain('"(refers back: #n)"');
    expect(system).toMatch(
      /- "that": [^\n]*with no new mark near it refers back to what the previous speech pointed at/,
    );
  });

  it('a "that" with a mark near gets no hint', () => {
    const { script } = buildProcessPrompt(doc());
    expect(script).toMatch(/"that" near #3, #2$/m);
    expect(script).not.toMatch(/near #\d+(, #\d+)* \(refers back/);
  });
});
