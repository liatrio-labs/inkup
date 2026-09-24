import { describe, expect, it } from 'vitest';
import {
  activeElapsed,
  expectedMediaDuration,
  type MediaClock,
  mediaToSession,
  mutedSpans,
  pauseGaps,
  sessionToMedia,
} from '../src/media-time';

const ev = (type: 'session_pause' | 'session_resume' | 'annotation', t: number) => ({ type, t });

describe('mutedSpans', () => {
  const m = (type: 'mic_muted' | 'mic_unmuted' | 'session_end' | 'session_pause', t: number) => ({ type, t });
  it('pairs each mute with the unmute after it, whatever pauses fall inside', () => {
    expect(
      mutedSpans([
        m('mic_muted', 2000),
        m('session_pause', 3000),
        m('mic_unmuted', 7000),
        m('mic_muted', 9000),
        m('mic_unmuted', 9500),
      ]),
    ).toEqual([
      { start: 2000, end: 7000 },
      { start: 9000, end: 9500 },
    ]);
  });
  it('a Session that ended muted is muted to its end', () => {
    expect(mutedSpans([m('mic_muted', 4000), m('session_end', 10_000)])).toEqual([{ start: 4000, end: 10_000 }]);
    expect(mutedSpans([m('mic_muted', 4000)])).toEqual([{ start: 4000, end: Infinity }]);
  });
});

describe('pauseGaps', () => {
  it('pairs each pause with the resume after it', () => {
    expect(
      pauseGaps([
        ev('session_pause', 5000),
        ev('annotation', 6000),
        ev('session_resume', 8000),
        ev('session_pause', 12_000),
        ev('session_resume', 12_500),
      ]),
    ).toEqual([
      { start: 5000, end: 8000 },
      { start: 12_000, end: 12_500 },
    ]);
  });
  it('sorts by t, ignores a stray resume and leaves an unmatched pause open', () => {
    expect(pauseGaps([ev('session_pause', 9000), ev('session_resume', 1000)])).toEqual([
      { start: 9000, end: Infinity },
    ]);
  });
  it('drops zero-length pauses', () => {
    expect(pauseGaps([ev('session_pause', 3000), ev('session_resume', 3000)])).toEqual([]);
  });
  it('no pauses, no gaps', () => {
    expect(pauseGaps([ev('annotation', 100)])).toEqual([]);
  });
});

describe('sessionToMedia', () => {
  const clock: MediaClock = {
    start_offset_ms: 400,
    gaps: [
      { start: 5000, end: 8000 },
      { start: 12_000, end: 12_500 },
    ],
  };

  it('subtracts the recorder start offset before any pause', () => {
    expect(sessionToMedia(2400, clock)).toBe(2000);
  });
  it('clamps times before the recorder started to 0', () => {
    expect(sessionToMedia(100, clock)).toBe(0);
    expect(sessionToMedia(400, clock)).toBe(0);
  });
  it('subtracts every pause that ended before t', () => {
    expect(sessionToMedia(10_000, clock)).toBe(10_000 - 400 - 3000);
    expect(sessionToMedia(20_000, clock)).toBe(20_000 - 400 - 3000 - 500);
  });
  it('maps a time inside a pause to where the pause began', () => {
    expect(sessionToMedia(6500, clock)).toBe(5000 - 400);
    expect(sessionToMedia(5000, clock)).toBe(4600);
    expect(sessionToMedia(8000, clock)).toBe(4600);
  });
  it('counts only the part of a pause after the recorder started', () => {
    expect(sessionToMedia(3000, { start_offset_ms: 1000, gaps: [{ start: 500, end: 1500 }] })).toBe(1500);
  });
  it('an open pause freezes media time', () => {
    const open: MediaClock = { start_offset_ms: 0, gaps: [{ start: 4000, end: Infinity }] };
    expect(sessionToMedia(60_000, open)).toBe(4000);
  });
});

describe('mediaToSession', () => {
  const clock: MediaClock = {
    start_offset_ms: 400,
    gaps: [
      { start: 5000, end: 8000 },
      { start: 12_000, end: 12_500 },
    ],
  };

  it('inverts sessionToMedia outside pauses', () => {
    for (const t of [400, 1000, 4999, 8001, 11_999, 12_501, 30_000])
      expect(mediaToSession(sessionToMedia(t, clock), clock)).toBe(t);
  });
  it('lands after the pause at a pause boundary', () => {
    expect(mediaToSession(4600, clock)).toBe(8000);
  });
  it('with no pauses it only adds the start offset', () => {
    expect(mediaToSession(1234, { start_offset_ms: 250, gaps: [] })).toBe(1484);
  });
});

describe('expectedMediaDuration', () => {
  it('is the Session length minus the start offset and every pause', () => {
    expect(expectedMediaDuration(30_000, { start_offset_ms: 300, gaps: [{ start: 10_000, end: 14_000 }] })).toBe(
      30_000 - 300 - 4000,
    );
  });
});

describe('activeElapsed', () => {
  const events = [ev('session_pause', 5000), ev('session_resume', 8000), ev('session_pause', 12_000)];

  it('is the Session time without the paused time, from the timeline', () => {
    expect(activeElapsed(4000, pauseGaps(events))).toBe(4000);
    expect(activeElapsed(10_000, pauseGaps(events))).toBe(7000);
  });
  it('stands still inside an open pause', () => {
    expect(activeElapsed(12_000, pauseGaps(events))).toBe(9000);
    expect(activeElapsed(15_000, pauseGaps(events))).toBe(9000);
  });
  it('gives the same answer from a running total and the open pause start', () => {
    for (const t of [4000, 10_000, 12_000, 15_000]) {
      const closed = t < 8000 ? 0 : 3000;
      const since = t >= 12_000 ? 12_000 : null;
      expect(activeElapsed(t, { paused_ms: closed, since })).toBe(activeElapsed(t, pauseGaps(events)));
    }
  });
  it('never goes below zero', () => {
    expect(activeElapsed(-50, [])).toBe(0);
    expect(activeElapsed(100, { paused_ms: 500, since: null })).toBe(0);
  });
});
