// The side panel's live list (PRD P0-10). With a key for the Draft model: Draft Item cards (title, Category, Location
// names) with Discard and Pin. Without one: Annotation cards (screenshot thumbnail, geometric pick, paired
// speech), and "scratch that" discards Annotations. Both read Dexie through useLiveQuery, newest first.

import { formatElapsed } from '@inkup/core/clock';
import { type DraftView, draftViews } from '@inkup/core/drafts';
import { pairSegment } from '@inkup/core/process/pairing';
import { type EventOf, sortTimeline, type TimelineEvent, type TimestampQuality } from '@inkup/core/timeline';
import { stripCommandPhrase } from '@inkup/core/voice-command-effects';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { TONE } from '@/components/tone';
import { Button } from '@/components/ui/button';
import { db } from '@/db';
import { useBlobUrl } from '@/lib/use-blob-url';
import { cn } from '@/lib/utils';
import { sendMessage } from '@/messaging';

const ROLE = { subject: 'Subject', reference: 'Reference', destination: 'Destination' } as const;

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
            <DraftCard key={v.draft.draft_id} view={v} disabled={disabled} />
          ))}
        </ol>
      )}
    </section>
  );
}

function DraftCard({ view, disabled }: { view: DraftView; disabled: boolean }) {
  const { draft, state, source } = view;
  const [busy, setBusy] = useState(false);
  const act = async (action: 'discard' | 'pin') => {
    setBusy(true);
    try {
      await sendMessage('draftAction', { draft_id: draft.draft_id, action });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li
      data-testid="draft-card"
      data-draft-id={draft.draft_id}
      data-state={state}
      className={cn(
        'flex flex-col gap-1.5 rounded-md border bg-card p-2',
        state === 'pinned' && 'border-primary',
        state === 'discarded' && 'opacity-50',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p
          className={cn('font-medium leading-snug', state === 'discarded' && 'line-through')}
          data-testid="draft-title"
        >
          {draft.title}
        </p>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs" data-testid="draft-category">
          {draft.category}
        </span>
      </div>
      {draft.locations.length > 0 && (
        <ul className="text-xs text-muted-foreground">
          {draft.locations.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Locations have no id, and a Draft Item's list is replaced as a whole
            <li key={i} data-testid="draft-location" data-role={l.role}>
              {ROLE[l.role]}: {l.element}
              {l.annotation !== null && ` (#${l.annotation})`}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground" data-testid="draft-state">
          {state === 'pinned'
            ? `Pinned${source === 'voice' ? ' by voice' : ''}`
            : state === 'discarded'
              ? `Discarded${source === 'voice' ? ' by voice' : ''}`
              : ''}
        </span>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || busy || state === 'discarded'}
            onClick={() => act('discard')}
            data-testid="draft-discard"
          >
            Discard
          </Button>
          <Button
            size="sm"
            variant={state === 'pinned' ? 'default' : 'outline'}
            disabled={disabled || busy || state === 'pinned'}
            onClick={() => act('pin')}
            data-testid="draft-pin"
            aria-pressed={state === 'pinned'}
          >
            {state === 'pinned' ? 'Pinned' : 'Pin'}
          </Button>
        </div>
      </div>
    </li>
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
    <li
      data-testid="annotation-card"
      data-discarded={discarded}
      className={cn('flex gap-2 rounded-md border bg-card p-2', discarded && 'opacity-50')}
    >
      {thumb ? (
        <img
          src={thumb}
          alt={`Screenshot of Annotation ${a.index}`}
          className={cn('h-14 w-20 shrink-0 rounded border bg-muted object-contain', TONE.shotFrame)}
          data-testid="annotation-thumb"
        />
      ) : (
        <div className="h-14 w-20 shrink-0 rounded border bg-muted" />
      )}
      <div className="flex min-w-0 flex-col gap-0.5 text-xs">
        <p className="font-medium">
          #{a.index} · {formatElapsed(a.t)}
          {discarded && <span className="ml-1 font-normal text-muted-foreground">Discarded</span>}
        </p>
        <p className="truncate" data-testid="annotation-pick" title={pick?.selector}>
          {pick ? `${pick.name ? `“${pick.name}” ` : ''}${pick.selector}` : 'Region only'}
        </p>
        <p className="line-clamp-2 text-muted-foreground" data-testid="annotation-speech">
          {speech.length ? speech.map((s) => `“${s}”`).join(' ') : 'No speech nearby'}
        </p>
      </div>
    </li>
  );
}
