// Session time ↔ media time (PRD §7 "Session clock", P0-5 "video is aligned to the Session clock").
//
// A recorder starts `start_offset_ms` after t0 and is paused while the Session is paused. Chromium's
// MediaRecorder leaves no gap in the file for a pause, so after the first pause media time runs behind Session
// time by the paused time so far. The pauses are the session_pause/session_resume pairs of the timeline. The
// same mapping serves the audio and the video recording.
import type { TimelineEvent } from './timeline.ts';

/** A paused span of the Session, in ms since t0. `end` is Infinity while still paused. */
export interface PauseGap {
  start: number;
  end: number;
}

export interface MediaClock {
  /** Recorder start, ms since t0. */
  start_offset_ms: number;
  /** Paused spans, sorted, non-overlapping. */
  gaps: readonly PauseGap[];
}

/**
 * Paused spans from the timeline: each session_resume closes the pause before it. A pause without a resume is
 * open-ended. Stop while paused logs a balancing resume, so a finished Session has none.
 */
export function pauseGaps(events: readonly Pick<TimelineEvent, 'type' | 't'>[]): PauseGap[] {
  const gaps: PauseGap[] = [];
  let open: number | null = null;
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (e.type === 'session_pause' && open === null) open = e.t;
    else if (e.type === 'session_resume' && open !== null) {
      if (e.t > open) gaps.push({ start: open, end: e.t });
      open = null;
    }
  }
  if (open !== null) gaps.push({ start: open, end: Infinity });
  return gaps;
}

/**
 * Muted spans (E10): each mic_unmuted closes the mic_muted before it. Unlike a pause the recorders keep running, so
 * media time is unaffected; the audio holds silence there. A Session that ended muted is muted to its end.
 */
export function mutedSpans(events: readonly Pick<TimelineEvent, 'type' | 't'>[]): PauseGap[] {
  const spans: PauseGap[] = [];
  let open: number | null = null;
  let end = Infinity;
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (e.type === 'mic_muted' && open === null) open = e.t;
    else if (e.type === 'mic_unmuted' && open !== null) {
      if (e.t > open) spans.push({ start: open, end: e.t });
      open = null;
    } else if (e.type === 'session_end') end = e.t;
  }
  if (open !== null) spans.push({ start: open, end });
  return spans;
}

/** Paused ms inside [from, to]. */
function pausedBetween(from: number, to: number, gaps: readonly PauseGap[]): number {
  let total = 0;
  for (const g of gaps) total += Math.max(0, Math.min(to, g.end) - Math.max(from, g.start));
  return total;
}

/** Pauses of a live Session: the closed pauses' total and where the open one began (null when not paused). */
export interface RunningPauses {
  paused_ms: number;
  since: number | null;
}

/**
 * Session time `t` minus the time spent paused before it: what the panel timer and the soft caps count. Takes the
 * timeline's pause gaps or, while recording, the running total the active Session keeps.
 */
export function activeElapsed(t: number, pauses: readonly PauseGap[] | RunningPauses): number {
  const paused =
    'paused_ms' in pauses
      ? pauses.paused_ms + (pauses.since !== null ? Math.max(0, t - pauses.since) : 0)
      : pausedBetween(0, t, pauses);
  return Math.max(0, t - paused);
}

/**
 * Media time (ms into the recording) for a Session time. A time inside a pause maps to where the pause began;
 * a time before the recorder started maps to 0.
 */
export function sessionToMedia(t: number, clock: MediaClock): number {
  const inside = clock.gaps.find((g) => t > g.start && t < g.end);
  const at = inside ? inside.start : t;
  if (at <= clock.start_offset_ms) return 0;
  return at - clock.start_offset_ms - pausedBetween(clock.start_offset_ms, at, clock.gaps);
}

/** Session time for a media time: the inverse of sessionToMedia, landing after any pause at that point. */
export function mediaToSession(m: number, clock: MediaClock): number {
  let t = clock.start_offset_ms + Math.max(0, m);
  for (const g of [...clock.gaps].sort((a, b) => a.start - b.start)) {
    if (g.end <= clock.start_offset_ms) continue;
    const start = Math.max(g.start, clock.start_offset_ms);
    if (start < t || (start === t && m > 0)) t += g.end - start;
    else break;
  }
  return t;
}

/** How long a recording that ran from its start to `sessionEnd` should be: Session time minus the pauses. */
export function expectedMediaDuration(sessionEnd: number, clock: MediaClock): number {
  return sessionToMedia(sessionEnd, clock);
}
