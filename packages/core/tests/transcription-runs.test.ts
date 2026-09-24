import { describe, expect, it } from 'vitest';
import { applyTranscriptEdits } from '../src/review-edits';
import type { EventOf, TimelineEvent } from '../src/timeline';
import {
  activeRunId,
  activeTranscript,
  buildRunEvents,
  groupWords,
  joinWords,
  transcriptionRuns,
} from '../src/transcription-runs';

const seg = (
  id: string,
  t: number,
  text: string,
  run_id: string | null = null,
  words: { text: string; t: number; t_end: number }[] | null = null,
): EventOf<'transcript_segment'> => ({
  id: `e-${id}`,
  type: 'transcript_segment',
  segment_id: id,
  t,
  t_end: t + 1000,
  text,
  engine: run_id ? 'deepgram' : 'webspeech',
  local: !run_id,
  timestamp_quality: words ? 'word' : 'approximate',
  words,
  confidence: null,
  run_id,
  target: null,
});
const run = (run_id: string, t = 20_000): EventOf<'transcription_run'> => ({
  id: `r-${run_id}`,
  type: 'transcription_run',
  t,
  run_id,
  engine: 'deepgram',
  local: false,
  timestamp_quality: 'word',
  model: 'nova-3',
  segment_count: 1,
  created_at: '2026-09-22T12:00:00.000Z',
});

describe('active run', () => {
  const live = [seg('a', 1000, 'this button'), seg('b', 3000, 'scratch that')];
  const rerun = [
    seg('r1', 1000, 'this button scratch that', 'run-1', [
      { text: 'this', t: 1000, t_end: 1200 },
      { text: 'button', t: 1250, t_end: 1600 },
      { text: 'scratch', t: 3000, t_end: 3300 },
      { text: 'that', t: 3350, t_end: 3600 },
    ]),
  ];
  const command: EventOf<'voice_command'> = {
    id: 'vc',
    type: 'voice_command',
    t: 3000,
    t_end: 3600,
    command: 'scratch_that',
    phrase: 'scratch that',
    segment_id: 'b',
    target: null,
  };

  it('is the live run until a re-transcription is recorded', () => {
    expect(activeRunId(live)).toBeNull();
    expect(activeRunId([...live, ...rerun, run('run-1')])).toBe('run-1');
  });

  it('follows the latest selection, back to live or forward again', () => {
    const select = (run_id: string | null): EventOf<'transcript_select'> => ({
      id: `s${run_id}`,
      type: 'transcript_select',
      t: 20_000,
      run_id,
      edited_at: '2026-09-22T12:00:00.000Z',
    });
    expect(activeRunId([...rerun, run('run-1'), select(null)])).toBeNull();
    expect(activeRunId([...rerun, run('run-1'), select(null), select('run-1')])).toBe('run-1');
  });

  it('keeps only the active run and cuts Voice Command words out of a re-run', () => {
    const events: TimelineEvent[] = [...live, command, ...rerun, run('run-1')];
    const segs = activeTranscript(events).filter((e) => e.type === 'transcript_segment');
    expect(segs.map((s) => s.text)).toEqual(['this button']);
    expect((segs[0] as EventOf<'transcript_segment'>).words?.map((w) => w.text)).toEqual(['this', 'button']);
    // The live run keeps its segments; Process strips its command by segment_id elsewhere.
    expect(activeTranscript([...live, command]).filter((e) => e.type === 'transcript_segment')).toHaveLength(2);
  });

  it('scopes edits to the run they were made on', () => {
    const edit: EventOf<'transcript_edit'> = {
      id: 'x',
      type: 'transcript_edit',
      t: 20_000,
      segment_id: 'a',
      text: 'this big button',
      edited_at: '2026-09-22T12:00:00.000Z',
    };
    const onLive = applyTranscriptEdits([...live, edit]).filter((e) => e.type === 'transcript_segment');
    expect(onLive.map((s) => s.text)).toContain('this big button');
    const afterRerun = applyTranscriptEdits([...live, edit, ...rerun, run('run-1')]).filter(
      (e) => e.type === 'transcript_segment',
    );
    expect(afterRerun.map((s) => s.text)).toEqual(['this button scratch that']);
  });

  it('lists the runs', () => {
    expect(
      transcriptionRuns([...live, ...rerun, run('run-1')]).map((r) => [r.run_id, r.engine, r.segment_count]),
    ).toEqual([
      [null, 'webspeech', 2],
      ['run-1', 'deepgram', 1],
    ]);
  });
});

describe('groupWords and joinWords', () => {
  const w = (text: string, start_ms: number, end_ms = start_ms + 200) => ({ text, start_ms, end_ms });
  it('splits at sentence ends, pauses and the length cap', () => {
    const groups = groupWords([
      w('Make', 0),
      w('it', 250),
      w('bigger.', 500),
      w('And', 800),
      w('blue', 1100),
      w('here', 3000),
    ]);
    expect(groups.map((g) => g.map((x) => x.text).join(' '))).toEqual(['Make it bigger.', 'And blue', 'here']);
    const long = Array.from({ length: 100 }, (_, i) => w('la', i * 300));
    expect(groupWords(long).length).toBeGreaterThan(1);
  });
  it('attaches punctuation tokens', () => {
    expect(joinWords(['Hello', ',', 'world', '.'])).toBe('Hello, world.');
  });
});

describe('buildRunEvents', () => {
  it('maps media time to Session time through the pause gaps, keeping words monotonic', () => {
    let n = 0;
    const { segments, run: r } = buildRunEvents({
      run_id: 'run-9',
      engine: 'deepgram',
      model: 'nova-3',
      local: false,
      groups: [
        [
          { text: 'before', start_ms: 500, end_ms: 900 },
          { text: 'pause', start_ms: 900, end_ms: 1100 },
        ],
        [{ text: 'after', start_ms: 1500, end_ms: 1800 }],
      ],
      // Recorder started at 200; paused 1200–5200 (Session time), i.e. media 1000.
      clock: { start_offset_ms: 200, gaps: [{ start: 1200, end: 5200 }] },
      duration_ms: 9000,
      created_at: '2026-09-22T12:00:00.000Z',
      newId: () => `s${++n}`,
    });
    expect(segments.map((s) => [s.segment_id, s.text, s.t, s.run_id])).toEqual([
      ['s1', 'before pause', 700, 'run-9'],
      ['s2', 'after', 5700, 'run-9'],
    ]);
    // "pause" ends in media at 1100 → Session 5300 (after the gap), not inside it.
    expect(segments[0]!.words![1]).toEqual({ text: 'pause', t: 1100, t_end: 5300 });
    const ts = segments.flatMap((s) => s.words!.map((x) => x.t));
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(r).toMatchObject({
      type: 'transcription_run',
      t: 9000,
      run_id: 'run-9',
      segment_count: 2,
      timestamp_quality: 'word',
    });
  });
});
