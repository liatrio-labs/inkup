// The review page's timeline (PRD P0-11, P0-12): what was said, drawn and commented, in one chronological list
// (packages/core/src/review-timeline.ts). Speech is a chat bubble on the right; Annotations and Text Comments sit
// on the left at the time they were made, so each mark lines up with the words around it. A bubble is the
// transcript's editor: click it to fix misheard words, and leaving it appends a `transcript_edit` (Process reads
// the edited text). The time beside a line seeks the recording there.

import { formatElapsed } from '@inkup/core/clock';
import { type ReviewEntry, reviewTimeline } from '@inkup/core/review-timeline';
import { type EventOf, isObjectSelectPick, type TimelineEvent } from '@inkup/core/timeline';
import { useMemo, useState } from 'react';
import { EvidenceShot, type ShotIndex, strokesOf } from '@/components/evidence-shot';
import { Textarea } from '@/components/ui/textarea';
import { appendReviewEvent } from '@/db/review';
import { cn } from '@/lib/utils';

export function Timeline({
  sessionId,
  events,
  shots,
  onSeek,
  canSeek,
}: {
  sessionId: string;
  /** Sorted (sortTimeline). */
  events: readonly TimelineEvent[];
  shots: ShotIndex;
  onSeek: (ms: number) => void;
  canSeek: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const entries = useMemo(() => reviewTimeline(events), [events]);
  // Annotations the reviewer took back with "scratch that".
  const scratched = useMemo(
    () =>
      new Set(
        events.flatMap((e) => (e.type === 'voice_command' && e.target?.kind === 'annotation' ? [e.target.id] : [])),
      ),
    [events],
  );
  const spoken = entries.some((e) => e.kind === 'segment');

  async function save(entry: Extract<ReviewEntry, { kind: 'segment' }>, text: string) {
    if (text === entry.text) return;
    try {
      await appendReviewEvent(sessionId, { type: 'transcript_edit', segment_id: entry.segment.segment_id, text });
      setError(null);
    } catch (e) {
      setError(`Could not save the edit: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const seek = (t: number, testId: string) => (
    <button
      type="button"
      className="rounded px-1 font-mono text-xs text-primary tabular-nums underline-offset-2 hover:underline disabled:text-muted-foreground disabled:no-underline"
      onClick={() => onSeek(t)}
      disabled={!canSeek}
      aria-label={`Play from ${formatElapsed(t)}`}
      data-testid={testId}
    >
      {formatElapsed(t)}
    </button>
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground">
        {spoken
          ? 'Click a line to fix misheard words before you Process. Process reads the edited text; the recording is unchanged.'
          : 'No speech was transcribed.'}
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <ol
        className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-3 lg:grid-cols-[auto_minmax(0,2fr)_minmax(0,3fr)]"
        data-testid="transcript"
      >
        {entries.map((entry) => {
          if (entry.kind === 'segment') {
            const s = entry.segment;
            return (
              <li
                key={s.segment_id}
                className="col-span-full grid grid-cols-subgrid items-start"
                data-testid="transcript-segment"
                data-segment-id={s.segment_id}
              >
                <div className="pt-2">{seek(s.t, 'seek-segment')}</div>
                <div className="flex flex-col items-start gap-0.5 lg:col-start-3">
                  <Textarea
                    className="min-h-0 w-auto max-w-full cursor-text resize-none rounded-2xl rounded-tl-sm border-transparent bg-muted shadow-none hover:bg-muted/70 focus-visible:w-full focus-visible:cursor-auto focus-visible:bg-background dark:bg-muted"
                    rows={1}
                    defaultValue={entry.text}
                    onBlur={(e) => void save(entry, e.currentTarget.value)}
                    aria-label={`Transcript at ${formatElapsed(s.t)}`}
                    title="Click to fix misheard words"
                    spellCheck={false}
                    data-testid="segment-text"
                  />
                  {entry.edited && (
                    <span className="px-3 text-xs text-muted-foreground">Edited. Heard: “{s.text}”</span>
                  )}
                </div>
              </li>
            );
          }
          if (entry.kind === 'annotation') {
            const a = entry.annotation;
            return (
              <li key={a.annotation_id} className="col-span-full grid grid-cols-subgrid items-start">
                <div className="pt-3">{seek(a.t, 'seek-annotation')}</div>
                <AnnotationCard a={a} shots={shots} discarded={scratched.has(a.annotation_id)} />
              </li>
            );
          }
          const c = entry.comment;
          return (
            <li key={c.comment_id} className="col-span-full grid grid-cols-subgrid items-start">
              <div className="pt-3">{seek(c.t, 'seek-text-comment')}</div>
              <TextCommentCard c={c} shots={shots} />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function AnnotationCard({ a, shots, discarded }: { a: EventOf<'annotation'>; shots: ShotIndex; discarded: boolean }) {
  const pick = a.pick !== null ? a.candidates[a.pick] : undefined;
  const endPick = (end: NonNullable<typeof a.connector>['tail']) =>
    (end.pick !== null ? end.candidates[end.pick]?.selector : null) ?? 'a region';
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-card p-3 sm:flex-row lg:col-start-2',
        discarded && 'opacity-50',
      )}
      data-testid="annotation"
      data-discarded={discarded}
    >
      {a.screenshot_id && (
        <EvidenceShot
          id={a.screenshot_id}
          shot={shots.shots.get(a.screenshot_id)}
          strokes={strokesOf(shots, a.screenshot_id, [a.index])}
          crop={a.crop}
          className="w-full shrink-0 self-start sm:w-40"
          alt={
            a.crop ? 'The picked element, cropped from the screenshot' : 'Screenshot taken when the Annotation closed'
          }
          testId="annotation-screenshot"
        />
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-medium">
          #{a.index} at {formatElapsed(a.t)} ·{' '}
          {a.source !== 'page_api' && isObjectSelectPick(a) ? (
            'picked with Object Select'
          ) : a.source === 'page_api' ? (
            'from the page API'
          ) : (
            <>
              {a.stroke_ids.length} {a.stroke_ids.length === 1 ? 'Stroke' : 'Strokes'} ·{' '}
              {a.close_reason === 'cleared' ? (
                <span data-testid="annotation-cleared">closed by Clear all (no screenshot)</span>
              ) : (
                `closed by ${a.close_reason.replaceAll('_', ' ')}`
              )}
            </>
          )}
          {discarded && (
            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">Discarded by “scratch that”</span>
          )}
        </p>
        {a.comment && <p data-testid="annotation-comment">“{a.comment}”</p>}
        {a.page_api && <p data-testid="annotation-page-api">“{a.page_api.comment}”</p>}
        {a.connector && (
          <p data-testid="connector">
            Arrow from <code className="rounded bg-muted px-1">{endPick(a.connector.tail)}</code> to{' '}
            <code className="rounded bg-muted px-1">{endPick(a.connector.head)}</code>
          </p>
        )}
        {pick ? (
          <p className="break-words">
            Geometric pick: <code className="rounded bg-muted px-1">{pick.selector}</code>{' '}
            {pick.name && `“${pick.name}”`}
          </p>
        ) : (
          <p>Region only (nothing resolvable under the Strokes).</p>
        )}
        <p className="text-muted-foreground">
          {a.candidates.length} Candidates · {new URL(a.url).pathname}
        </p>
      </div>
    </div>
  );
}

function TextCommentCard({ c, shots }: { c: EventOf<'text_comment'>; shots: ShotIndex }) {
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border bg-card p-3 sm:flex-row lg:col-start-2"
      data-testid="timeline-text-comment"
      data-comment-id={c.comment_id}
    >
      {c.screenshot_id && (
        <EvidenceShot
          id={c.screenshot_id}
          shot={shots.shots.get(c.screenshot_id)}
          strokes={[]}
          className="w-full shrink-0 self-start sm:w-40"
          alt="Screenshot taken with the selection on screen"
          testId="text-comment-screenshot"
        />
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-medium">
          t{c.index} at {formatElapsed(c.t)} · Text Comment
        </p>
        <blockquote className="border-l-2 pl-2 text-muted-foreground">“{c.selected_text}”</blockquote>
        <p>{c.comment}</p>
        <p className="text-muted-foreground">{new URL(c.url).pathname}</p>
      </div>
    </div>
  );
}
