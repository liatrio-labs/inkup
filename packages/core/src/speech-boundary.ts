// Speech Boundary (CONTEXT.md, PRD P0-3): a point in the transcript where a new demonstrative ("this", "here",
// "that") or a new sentence begins. When one is spoken after the open Annotation began, the reviewer has moved
// on to the next thing, so that Annotation closes.

import { SPEECH_LEAD_MS } from './process/align.ts';
import { isDemonstrative } from './process/locale/en.ts';
import type { EventOf } from './timeline.ts';

type Segment = Pick<EventOf<'transcript_segment'>, 't' | 'text' | 'words'>;

/**
 * The latest boundary in a segment (ms since t0). Word-level: each demonstrative word and each sentence start
 * (the first word, and a word after one ending in . ? or !). Approximate: the segment itself starts a sentence
 * and has no word times. Its `t` is when the first interim arrived, late by the recognizer's latency, so the
 * sentence starts at the latest VAD speech start (`speechStarts`) at or before it, within SPEECH_LEAD_MS; with none,
 * at `t`. An Annotation begun while the sentence was being said is then not closed by it.
 */
export function speechBoundaryAt(seg: Segment, speechStarts: readonly number[] = []): number {
  if (!seg.words || seg.words.length === 0) {
    const began = speechStarts.filter((s) => s <= seg.t && s >= seg.t - SPEECH_LEAD_MS);
    return began.length ? Math.max(...began) : seg.t;
  }
  let at = seg.words[0]!.t;
  seg.words.forEach((w, i) => {
    const sentenceStart = i > 0 && /[.?!]["')\]]*$/.test(seg.words![i - 1]!.text);
    if (sentenceStart || isDemonstrative(w.text)) at = Math.max(at, w.t);
  });
  return at;
}
