// Speech Boundary (CONTEXT.md, PRD P0-3): a point in the transcript where a new demonstrative ("this", "here",
// "that") or a new sentence begins. When one is spoken after the open Annotation began, the reviewer has moved
// on to the next thing, so that Annotation closes.

import { isDemonstrative } from './process/locale/en.ts';
import type { EventOf } from './timeline.ts';

type Segment = Pick<EventOf<'transcript_segment'>, 't' | 'text' | 'words'>;

/**
 * The latest boundary in a segment (ms since t0). Word-level: each demonstrative word and each sentence start
 * (the first word, and a word after one ending in . ? or !). Approximate: the segment itself starts a sentence
 * and has no word times, so its start.
 */
export function speechBoundaryAt(seg: Segment): number {
  if (!seg.words || seg.words.length === 0) return seg.t;
  let at = seg.words[0]!.t;
  seg.words.forEach((w, i) => {
    const sentenceStart = i > 0 && /[.?!]["')\]]*$/.test(seg.words![i - 1]!.text);
    if (sentenceStart || isDemonstrative(w.text)) at = Math.max(at, w.t);
  });
  return at;
}
