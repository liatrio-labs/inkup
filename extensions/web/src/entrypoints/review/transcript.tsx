// Transcript view (PRD P0-11, P0-12): one auto-growing textarea per segment, and a timestamp button that seeks
// the recording. Leaving a changed textarea appends a `transcript_edit`; Process runs on the edited text.

import { formatElapsed } from '@inkup/core/clock';
import type { EventOf } from '@inkup/core/timeline';
import { useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { appendReviewEvent } from '@/db/review';

export function TranscriptEditor({
  sessionId,
  segments,
  edits,
  onSeek,
  canSeek,
}: {
  sessionId: string;
  segments: EventOf<'transcript_segment'>[];
  edits: Map<string, string>;
  onSeek: (ms: number) => void;
  canSeek: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  if (segments.length === 0) return <p className="text-muted-foreground">No speech was transcribed.</p>;

  async function save(segment: EventOf<'transcript_segment'>, text: string) {
    const current = edits.get(segment.segment_id) ?? segment.text;
    if (text === current) return;
    try {
      await appendReviewEvent(sessionId, { type: 'transcript_edit', segment_id: segment.segment_id, text });
      setError(null);
    } catch (e) {
      setError(`Could not save the edit: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground">
        Fix misheard words here before you Process. Process reads the edited text; the recording is unchanged.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <ol className="flex flex-col gap-2" data-testid="transcript">
        {segments.map((s) => {
          const edited = edits.has(s.segment_id) && edits.get(s.segment_id) !== s.text;
          return (
            <li
              key={s.segment_id}
              className="flex items-start gap-2"
              data-testid="transcript-segment"
              data-segment-id={s.segment_id}
            >
              <button
                type="button"
                className="mt-2 shrink-0 rounded px-1 font-mono text-xs text-primary underline-offset-2 hover:underline disabled:text-muted-foreground disabled:no-underline"
                onClick={() => onSeek(s.t)}
                disabled={!canSeek}
                aria-label={`Play from ${formatElapsed(s.t)}`}
                data-testid="seek-segment"
              >
                {formatElapsed(s.t)}
              </button>
              <div className="flex w-full flex-col gap-0.5">
                <Textarea
                  className="min-h-0"
                  rows={1}
                  defaultValue={edits.get(s.segment_id) ?? s.text}
                  onBlur={(e) => void save(s, e.currentTarget.value)}
                  aria-label={`Transcript at ${formatElapsed(s.t)}`}
                  data-testid="segment-text"
                />
                {edited && <span className="text-xs text-muted-foreground">Edited. Heard: “{s.text}”</span>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
