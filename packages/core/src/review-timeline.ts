// The review page's one timeline: what was said, drawn and commented, in the order it happened. Transcript
// segments come from the active run with the reviewer's edits in place (review-edits.ts); Annotations and Text
// Comments sit at their start time between them.
import { transcriptEdits } from './review-edits.ts';
import type { EventOf, TimelineEvent } from './timeline.ts';
import { activeTranscript } from './transcription-runs.ts';

export type ReviewEntry =
  | { kind: 'segment'; t: number; segment: EventOf<'transcript_segment'>; text: string; edited: boolean }
  | { kind: 'annotation'; t: number; annotation: EventOf<'annotation'> }
  | { kind: 'text_comment'; t: number; comment: EventOf<'text_comment'> };

/** `events` in timeline order (sortTimeline: by start time, then the order they were appended), and so is the result. */
export function reviewTimeline(events: readonly TimelineEvent[]): ReviewEntry[] {
  const edits = transcriptEdits(events);
  const out: ReviewEntry[] = [];
  for (const e of activeTranscript(events)) {
    if (e.type === 'transcript_segment') {
      const text = edits.get(e.segment_id) ?? e.text;
      out.push({ kind: 'segment', t: e.t, segment: e, text, edited: text !== e.text });
    } else if (e.type === 'annotation') out.push({ kind: 'annotation', t: e.t, annotation: e });
    else if (e.type === 'text_comment') out.push({ kind: 'text_comment', t: e.t, comment: e });
  }
  return out;
}
