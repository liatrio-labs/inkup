// VAD alignment of late speech (PRD P0-11 pairing). Web Speech stamps a segment's `t` when its first interim result
// arrives and its `t_end` when the final arrives: both late by the recognizer's latency (0.3–2 s, and it varies).
// Strokes are stamped at the pointer event, and the VAD's `speech_activity` spans are on the PCM clock, so they say
// when the reviewer actually spoke. Process moves each approximate segment onto the VAD speech that explains it before
// it pairs speech with Annotations. Segments are taken in log order; `floor` is where the previous one ended.
//
// - Start: the speech had begun by the first interim, and not long before it (SPEECH_LEAD_MS). The latest span that
//   started by `t` and runs past the floor, joined with earlier spans across short pauses (JOIN_GAP_MS: one
//   utterance); it starts no earlier than the floor. The recognizer can split one VAD span into two finals, so the
//   later segment then starts where the earlier one ended: two segments may share a span, never reorder.
// - End: the latest span from there that ended by `t_end` (a final arrives after the speech it transcribes). None
//   (the final came while that speech was still going): `t_end` itself.
// - No such span, or a sliver shorter than MIN_SPEECH_MS: the segment keeps its times, and later ones start after it
//   ends (its speech ran until then, as far as anything knows).
// - An aligned segment keeps its arrival times in `vad`. In memory only, at processing time: the log keeps the
//   arrival times, and `vad` is never written.
import { applyTranscriptEdits } from '../review-edits.ts';
import type { EventOf, TimelineEvent } from '../timeline.ts';
import type { Span } from './pairing.ts';

/**
 * How long before the first interim result the speech may have begun. Measured on real Web Speech Sessions: 0.3–1.3 s,
 * rarely 2 s.
 */
export const SPEECH_LEAD_MS = 2500;
/** Spans this close together are one utterance with a pause in it. */
export const JOIN_GAP_MS = 1000;
/** A shorter aligned span is a leftover of the previous segment's speech, not this one's. */
export const MIN_SPEECH_MS = 250;

/** The times a segment arrived with, kept on a VAD-aligned segment. */
export interface VadAlignment {
  t_arrived: number;
  t_end_arrived: number;
}

/** A transcript segment as Process reads it: `vad` is set when its times were moved onto VAD spans. */
export type ProcessSegment = EventOf<'transcript_segment'> & { vad?: VadAlignment };

export const isVadAligned = (seg: object): boolean => (seg as { vad?: VadAlignment }).vad !== undefined;

/** Late times only: an approximate segment with no word timings. */
const alignable = (seg: EventOf<'transcript_segment'>) => seg.timestamp_quality === 'approximate' && !seg.words?.length;

/**
 * Where a late segment was said, from `spans` (sorted by start, disjoint), starting no earlier than `floor`; null when
 * no VAD speech explains it.
 */
function spokenFrom(seg: Span, spans: readonly Span[], floor: number): Span | null {
  let s = -1;
  for (let i = 0; i < spans.length && spans[i]!.t <= seg.t; i++) if (spans[i]!.t_end > floor) s = i;
  if (s < 0) return null;
  const earliest = Math.max(floor, seg.t - SPEECH_LEAD_MS);
  while (s > 0 && spans[s - 1]!.t >= earliest && spans[s]!.t - spans[s - 1]!.t_end <= JOIN_GAP_MS) s--;
  const t = Math.max(spans[s]!.t, floor);
  if (t < seg.t - SPEECH_LEAD_MS) return null;
  let t_end: number | null = null;
  for (let i = s; i < spans.length && spans[i]!.t <= seg.t_end; i++)
    if (spans[i]!.t_end <= seg.t_end) t_end = spans[i]!.t_end;
  const end = t_end ?? seg.t_end;
  return end - t >= MIN_SPEECH_MS ? { t, t_end: end } : null;
}

/** Where a late segment was said, or null when no VAD speech explains it. `spans` in any order. */
export function spokenSpan(seg: Span, spans: readonly Span[]): Span | null {
  return spokenFrom(
    seg,
    [...spans].sort((a, b) => a.t - b.t),
    -Infinity,
  );
}

/**
 * The events with each approximate segment moved onto the VAD speech that explains it (see the top of this file).
 * Everything else, and segments nothing explains, are returned as they were. Idempotent.
 */
export function alignSegments<E extends TimelineEvent>(events: readonly E[]): E[] {
  const spans = events
    .filter((e): e is E & EventOf<'speech_activity'> => e.type === 'speech_activity')
    .map((e) => ({ t: e.t, t_end: Math.max(e.t, e.t_end) }))
    .sort((a, b) => a.t - b.t);
  if (spans.length === 0) return [...events];
  let floor = -Infinity;
  return events.map((e) => {
    if (e.type !== 'transcript_segment') return e;
    if (isVadAligned(e)) {
      floor = e.t_end;
      return e;
    }
    const said = alignable(e) ? spokenFrom(e, spans, floor) : null;
    if (!said) {
      floor = Math.max(floor, e.t_end);
      return e;
    }
    floor = said.t_end;
    const vad: VadAlignment = { t_arrived: e.t, t_end_arrived: e.t_end };
    return { ...e, ...said, vad } as E;
  });
}

/** The timeline as Process reads it: the active transcript with its edits (applyTranscriptEdits), VAD-aligned. */
export function processEvents<E extends TimelineEvent>(events: readonly E[]): E[] {
  return alignSegments(applyTranscriptEdits(events));
}
