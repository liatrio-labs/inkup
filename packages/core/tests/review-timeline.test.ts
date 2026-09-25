import { describe, expect, it } from 'vitest';
import { localStamp } from '../src/clock';
import { sessionName } from '../src/review-edits';
import { reviewTimeline } from '../src/review-timeline';
import { type EventOf, sortTimeline, type TimelineEvent } from '../src/timeline';

const seg = (id: string, t: number, text: string, run_id: string | null = null) =>
  ({
    id: `e-${id}`,
    type: 'transcript_segment',
    segment_id: id,
    t,
    t_end: t + 1000,
    text,
    engine: 'webspeech',
    local: true,
    timestamp_quality: 'approximate',
    words: null,
    confidence: null,
    run_id,
    target: null,
  }) as EventOf<'transcript_segment'>;
const annotation = (index: number, t: number) =>
  ({
    id: `a-${index}`,
    type: 'annotation',
    annotation_id: `ann-${index}`,
    index,
    t,
    t_end: t + 500,
  }) as unknown as TimelineEvent;
const comment = (index: number, t: number) =>
  ({
    id: `c-${index}`,
    type: 'text_comment',
    comment_id: `tc-${index}`,
    index,
    t,
    t_end: t + 800,
  }) as unknown as TimelineEvent;
const stamped = <E extends TimelineEvent>(events: E[]) => events.map((e, seq) => ({ ...e, seq }));

describe('reviewTimeline', () => {
  it('interleaves segments, Annotations and Text Comments by start time', () => {
    const events = sortTimeline(
      stamped([
        seg('s1', 1000, 'this button'),
        seg('s2', 5000, 'and this heading'),
        // Appended when it closed, after s2, but it started before it.
        annotation(1, 2000),
        comment(1, 7000),
        seg('s3', 9000, 'done'),
      ]),
    );
    expect(reviewTimeline(events).map((e) => `${e.kind}@${e.t}`)).toEqual([
      'segment@1000',
      'annotation@2000',
      'segment@5000',
      'text_comment@7000',
      'segment@9000',
    ]);
  });

  it("shows the active run's segments with the latest edit, and drops the edit events", () => {
    const events: TimelineEvent[] = [
      seg('live', 1000, 'the live words'),
      seg('r1', 1000, 'this button', 'run-1'),
      { id: 'e1', type: 'transcript_edit', t: 20_000, segment_id: 'r1', text: 'this buton', edited_at: 'x' },
      { id: 'e2', type: 'transcript_edit', t: 20_000, segment_id: 'r1', text: 'this Button', edited_at: 'x' },
      {
        id: 'run',
        type: 'transcription_run',
        t: 20_000,
        run_id: 'run-1',
        engine: 'deepgram',
        local: false,
        timestamp_quality: 'word',
        model: 'nova-3',
        segment_count: 1,
        created_at: '2026-09-22T12:00:00.000Z',
      },
    ] as TimelineEvent[];
    const entries = reviewTimeline(events);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'segment', text: 'this Button', edited: true });
  });

  it('marks a segment edited back to its heard text as unedited', () => {
    const events = [
      seg('s1', 1000, 'heard'),
      { id: 'e1', type: 'transcript_edit', t: 5000, segment_id: 's1', text: 'heard', edited_at: 'x' },
    ] as TimelineEvent[];
    expect(reviewTimeline(events)[0]).toMatchObject({ text: 'heard', edited: false });
  });
});

describe('sessionName', () => {
  const session = { start_title: 'Pricing', start_url: 'http://localhost:4401/pricing.html' };
  const rename = (name: string) =>
    ({ id: name, type: 'session_rename', t: 9000, name, edited_at: '2026-09-24T12:00:00.000Z' }) as TimelineEvent;

  it('is the start title until the Session is renamed, then the latest name', () => {
    expect(sessionName(session, [seg('s1', 0, 'x')])).toBe('Pricing');
    expect(sessionName(session, [rename('First'), rename('Checkout review')])).toBe('Checkout review');
  });

  it('falls back to the start URL for a page with no title', () => {
    expect(sessionName({ ...session, start_title: '' }, [])).toBe(session.start_url);
  });
});

describe('localStamp', () => {
  it('is the local date, hour and minute', () => {
    const at = new Date(2026, 8, 4, 9, 5, 59).toISOString();
    expect(localStamp(at)).toBe('2026-09-04-0905');
    expect(localStamp(new Date(2026, 11, 31, 23, 59).toISOString())).toBe('2026-12-31-2359');
  });
});
