// Stroke-to-speech pairing (PRD P0-11): a demonstrative pairs with an Annotation inside the pairing window,
// 2s with word-level timestamps, 2.5s with approximate ones moved onto the VAD's speech spans (./align.ts), and 4s
// with approximate ones still stamped on arrival. The prompt builder precomputes the pairs as hints ("near #3"); the
// model makes the final call.
import type { EventOf, TimestampQuality } from '../timeline.ts';
import { isVadAligned, type VadAlignment } from './align.ts';
import { demonstrativesInText, isDemonstrative } from './locale/en.ts';

/** How precise speech times are when pairing: the recorded quality, or `vad` for a VAD-aligned segment. */
export type PairingQuality = TimestampQuality | 'vad';

export const PAIRING_WINDOW_MS: Record<PairingQuality, number> = { word: 2000, vad: 2500, approximate: 4000 };

export interface Span {
  t: number;
  t_end: number;
}

/** Distance between two spans in ms; 0 when they overlap. */
export const gapMs = (a: Span, b: Span): number => Math.max(0, b.t - a.t_end, a.t - b.t_end);

type QualitySource = Pick<EventOf<'transcript_segment'>, 'timestamp_quality'> & { vad?: VadAlignment };

/** One segment's pairing quality. */
export const segmentQuality = (seg: QualitySource): PairingQuality =>
  isVadAligned(seg) ? 'vad' : seg.timestamp_quality;

/**
 * The Session's pairing quality, the loosest of its segments': approximate if any segment is still stamped on arrival,
 * else vad if any was VAD-aligned. No speech: word (the window is moot).
 */
export function sessionTimestampQuality(segments: readonly QualitySource[]): PairingQuality {
  const qs = new Set(segments.map(segmentQuality));
  return qs.has('approximate') ? 'approximate' : qs.has('vad') ? 'vad' : 'word';
}

export interface SpeechAnchor extends Span {
  /** The demonstrative, or null when the anchor is the whole segment. */
  word: string | null;
}

/**
 * Moments in a segment that point at the page. Word-level: each demonstrative word with its own timing.
 * Approximate (or no words): each demonstrative gets the whole segment span; no demonstrative, the segment itself.
 */
export function speechAnchors(
  segment: Pick<EventOf<'transcript_segment'>, 't' | 't_end' | 'text' | 'words'>,
): SpeechAnchor[] {
  if (segment.words && segment.words.length > 0) {
    const hits = segment.words.filter((w) => isDemonstrative(w.text));
    if (hits.length > 0)
      return hits.map((w) => ({ word: w.text.toLowerCase().replace(/[^a-z']/g, ''), t: w.t, t_end: w.t_end }));
  } else {
    const hits = demonstrativesInText(segment.text);
    if (hits.length > 0) return hits.map((d) => ({ word: d.word, t: segment.t, t_end: segment.t_end }));
  }
  return [{ word: null, t: segment.t, t_end: segment.t_end }];
}

export interface AnchorPairing {
  anchor: SpeechAnchor;
  /** Annotation indexes inside the window, nearest first. */
  annotations: number[];
}

/** Pairs each anchor of a segment with the Annotations inside the window, nearest first. */
export function pairSegment(
  segment: Pick<EventOf<'transcript_segment'>, 't' | 't_end' | 'text' | 'words'>,
  annotations: readonly Pick<EventOf<'annotation'>, 'index' | 't' | 't_end'>[],
  quality: PairingQuality,
): AnchorPairing[] {
  const window = PAIRING_WINDOW_MS[quality];
  return speechAnchors(segment).map((anchor) => ({
    anchor,
    annotations: annotations
      .map((a) => ({ index: a.index, gap: gapMs(anchor, a) }))
      .filter((x) => x.gap <= window)
      .sort((x, y) => x.gap - y.gap || x.index - y.index)
      .map((x) => x.index),
  }));
}
