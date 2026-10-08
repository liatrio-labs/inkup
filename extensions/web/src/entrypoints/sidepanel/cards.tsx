// The side panel's live list (PRD P0-10). With a key for the Draft model: Draft Item cards (title, Category, Location
// names) with Discard and Pin, drawn by @inkup/ui's ItemCard; Pin and Discard go to the service worker. Without one:
// Annotation cards (screenshot thumbnail, geometric pick, paired speech), and "scratch that" discards Annotations.
// Both read Dexie through useLiveQuery, newest first.

import { formatElapsed } from '@inkup/core/clock';
import { draftViews } from '@inkup/core/drafts';
import { pairSegment } from '@inkup/core/process/pairing';
import { type EventOf, sortTimeline, type TimelineEvent, type TimestampQuality } from '@inkup/core/timeline';
import { stripCommandPhrase } from '@inkup/core/voice-command-effects';
import { Card, cn, ItemCard, TONE } from '@inkup/ui';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db';
import { useBlobUrl } from '@/lib/use-blob-url';
import { sendMessage } from '@/messaging';

function useEventsOf<T extends TimelineEvent['type']>(
  sessionId: string,
  types: T[],
): Extract<TimelineEvent, { type: T }>[] | undefined {
  return useLiveQuery(
    async () =>
      sortTimeline(
        await db.events
          .where('session_id')
          .equals(sessionId)
          .filter((e) => (types as string[]).includes(e.type))
          .toArray(),
      ) as unknown as Extract<TimelineEvent, { type: T }>[],
    [sessionId, types.join()],
  );
}

export function DraftCards({
  sessionId,
  running,
  note,
  disabled,
}: {
  sessionId: string;
  running: boolean;
  note: string | null;
  disabled: boolean;
}) {
  const events = useEventsOf(sessionId, ['draft_item', 'draft_action']);
  const views = events ? draftViews(events).reverse() : [];
  const pin = (draft_id: string) => sendMessage('draftAction', { draft_id, action: 'pin' });
  const discard = (draft_id: string) => sendMessage('draftAction', { draft_id, action: 'discard' });
  return (
    <section aria-labelledby="drafts-heading" className="flex flex-col gap-2" data-testid="draft-list">
      <div className="flex items-baseline justify-between">
        <h2 id="drafts-heading" className="text-sm font-semibold">
          Draft Items
        </h2>
        {running && (
          <span className="text-xs text-muted-foreground" data-testid="drafting">
            Drafting…
          </span>
        )}
      </div>
      {note && (
        <p role="note" className={cn('rounded-md p-2 text-xs', TONE.note)} data-testid="draft-note">
          {note}
        </p>
      )}
      {views.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Draft Items appear a few seconds after you finish pointing and talking. Pin the right ones; discard the wrong
          ones.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {views.map((v) => (
            <ItemCard
              key={v.draft.draft_id}
              variant="draft"
              draft={v.draft}
              state={v.state}
              source={v.source}
              disabled={disabled}
              onPin={pin}
              onDiscard={discard}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

export function AnnotationCards({ sessionId, quality }: { sessionId: string; quality: TimestampQuality }) {
  const events = useEventsOf(sessionId, ['annotation', 'transcript_segment', 'voice_command']);
  if (!events) return null;
  const annotations = events.filter((e): e is EventOf<'annotation'> => e.type === 'annotation');
  const commands = events.filter((e): e is EventOf<'voice_command'> => e.type === 'voice_command');
  const scratched = new Set(commands.flatMap((c) => (c.target?.kind === 'annotation' ? [c.target.id] : [])));
  // Speech as Process reads it: Voice Command phrases removed.
  const segments = events
    // Dictation into a comment box (E11) is that comment's text, not speech about the Annotations.
    .filter((e): e is EventOf<'transcript_segment'> => e.type === 'transcript_segment' && !e.target)
    .map((s) => ({
      ...s,
      text: commands
        .filter((c) => c.segment_id === s.segment_id)
        .reduce((t, c) => stripCommandPhrase(t, c.phrase), s.text),
    }))
    .filter((s) => s.text);
  const spoken = (a: EventOf<'annotation'>) =>
    segments.filter((s) => pairSegment(s, [a], quality).some((p) => p.annotations.length > 0)).map((s) => s.text);
  return (
    <section aria-labelledby="annotation-cards-heading" className="flex flex-col gap-2" data-testid="annotation-list">
      <h2 id="annotation-cards-heading" className="text-sm font-semibold">
        Annotations
      </h2>
      <p className="text-xs text-muted-foreground">
        No key for the Draft model: the panel lists your Annotations instead of Draft Items. &ldquo;Scratch that&rdquo;
        discards the latest one.
      </p>
      <ol className="flex flex-col gap-2">
        {[...annotations].reverse().map((a) => (
          <AnnotationCard
            key={a.annotation_id}
            annotation={a}
            speech={spoken(a)}
            discarded={scratched.has(a.annotation_id)}
          />
        ))}
      </ol>
    </section>
  );
}

function AnnotationCard({
  annotation: a,
  speech,
  discarded,
}: {
  annotation: EventOf<'annotation'>;
  speech: string[];
  discarded: boolean;
}) {
  const thumb = useBlobUrl(a.screenshot_id);
  const pick = a.pick !== null ? a.candidates[a.pick] : undefined;
  return (
    <li data-testid="annotation-card" data-discarded={discarded}>
      <Card
        className={cn(
          'flex-row gap-2.5 rounded-lg p-2 shadow-xs transition-opacity duration-150',
          discarded && 'opacity-50 shadow-none',
        )}
      >
        {thumb ? (
          <img
            src={thumb}
            alt={`Screenshot of Annotation ${a.index}`}
            className={cn('h-14 w-20 shrink-0 rounded-sm border bg-muted object-contain', TONE.shotFrame)}
            data-testid="annotation-thumb"
          />
        ) : (
          <div className="h-14 w-20 shrink-0 rounded-sm border bg-muted" />
        )}
        <div className="flex min-w-0 flex-col gap-0.5 text-xs">
          <p className="font-medium">
            #{a.index} · <span className="font-mono font-normal text-muted-foreground">{formatElapsed(a.t)}</span>
            {discarded && <span className="ml-1 font-normal text-muted-foreground">Discarded</span>}
          </p>
          <p className="truncate" data-testid="annotation-pick" title={pick?.selector}>
            {pick ? (
              <>
                {pick.name ? `“${pick.name}” ` : ''}
                <span className="font-mono text-pen-ink">{pick.selector}</span>
              </>
            ) : (
              'Region only'
            )}
          </p>
          <p className="line-clamp-2 text-muted-foreground" data-testid="annotation-speech">
            {speech.length ? speech.map((s) => `“${s}”`).join(' ') : 'No speech nearby'}
          </p>
        </div>
      </Card>
    </li>
  );
}
