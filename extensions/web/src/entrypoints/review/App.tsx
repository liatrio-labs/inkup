// Review page (PRD P0-12): the Session's name (renamed in place) with the exports in the corner (Copy all prompts,
// session.json, Export zip); the Change Item list on the left, each Location with its screenshot and Strokes, and
// the recording on the right, seeking to the selected item; then one timeline of what was said (editable), drawn
// and commented; and the Draft Items (pinned, discarded or neither).

import { formatElapsed, localStamp } from '@inkup/core/clock';
import { draftViews } from '@inkup/core/drafts';
import { applyItemEdits, itemEditsFor, sessionName } from '@inkup/core/review-edits';
import { sortTimeline, type TimelineEvent } from '@inkup/core/timeline';
import { activeRunId, transcriptionRuns } from '@inkup/core/transcription-runs';
import { useLiveQuery } from 'dexie-react-hooks';
import { DownloadIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShotIndex } from '@/components/evidence-shot';
import { Button } from '@/components/ui/button';
import { db } from '@/db';
import { loadSessionDocument } from '@/db/session-export';
import { platform } from '@/platform';
import { ChangeItemList, ProcessSection } from './change-items';
import { Player, type PlayerHandle, useRecording } from './evidence';
import { CopyAllPrompts, ExportControls } from './export';
import { TranscriptRuns } from './retranscribe';
import { SessionName } from './session-name';
import { Timeline } from './timeline';

const sessionId = new URLSearchParams(location.search).get('session') ?? '';

const VIDEO_OFF: Record<string, string> = {
  picker_cancelled: 'Video off: the screen picker was cancelled.',
  unavailable: 'Video off: screen capture is not available here.',
  failed: 'Video off: screen capture failed.',
};

export function App() {
  const session = useLiveQuery(() => db.sessions.get(sessionId), []);
  const rows = useLiveQuery(() => db.events.where('session_id').equals(sessionId).toArray(), []);
  const events = useMemo(() => sortTimeline(rows ?? []) as TimelineEvent[], [rows]);
  const processRuns = useLiveQuery(() => db.processRuns.where('session_id').equals(sessionId).sortBy('created_at'), []);
  const latest = processRuns?.at(-1);
  const done = processRuns?.filter((r) => r.status === 'done').at(-1);
  const itemEdits = useMemo(() => (done ? itemEditsFor(events, done.id) : []), [done, events]);
  const edited = useMemo(() => (done?.items ? applyItemEdits(done.items, itemEdits) : null), [done, itemEdits]);
  const items = edited?.items ?? null;

  const runs = useMemo(() => transcriptionRuns(events), [events]);
  const activeRun = useMemo(() => activeRunId(events), [events]);
  const drafts = useMemo(() => draftViews(events), [events]);
  const shotIndex = useShotIndex(events);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items?.find((i) => i.id === selectedId) ?? items?.[0] ?? null;
  const player = useRef<PlayerHandle>(null);
  // Selecting an item seeks the recording to where it was said.
  const seekTo = selected?.evidence.video?.start ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: selecting another item seeks again even when it starts at the same time
  useEffect(() => {
    if (seekTo !== null) player.current?.seek(seekTo * 1000);
  }, [selected?.id, seekTo]);

  const [status, setStatus] = useState<string | null>(null);
  async function download() {
    setStatus(null);
    try {
      const doc = await loadSessionDocument(db, sessionId);
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
      // The local start time tells two Sessions' files apart; the id, two Sessions started in the same minute.
      const saved = await platform.saveFile(
        blob,
        `session-${localStamp(doc.session.started_at)}-${sessionId.slice(0, 8)}.json`,
      );
      if (!saved.ok) throw new Error(`the download failed (${saved.error})`);
      setStatus(`Downloading session.json (${doc.events.length} events).`);
      if (saved.downloadId !== null) document.body.dataset.downloadId = String(saved.downloadId);
    } catch (e) {
      setStatus(`Could not build session.json: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const recording = useRecording(session, events);
  if (session === undefined) return <main className="p-8">Loading…</main>;
  if (session === null) return <main className="p-8">No Session with id “{sessionId}”.</main>;
  const video = session.video ?? null;
  const media =
    [video ? 'video' : null, session.audio ? 'audio' : null].filter(Boolean).join(' and ') || 'no recording';
  const playerNote = session.media_deleted_at
    ? 'The video and audio were deleted after an export.'
    : session.video
      ? ''
      : `${VIDEO_OFF[session.video_off_reason ?? ''] ?? 'No video was recorded.'}${session.audio ? ' The audio plays instead.' : ''}`;

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 p-8 text-sm">
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-96 flex-col gap-1">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Session review</p>
          <SessionName
            sessionId={sessionId}
            name={sessionName(session, events)}
            editable={session.status === 'ended'}
          />
          <p className="text-muted-foreground" data-testid="session-meta">
            <time dateTime={session.started_at} data-testid="session-start">
              {dateFmt.format(new Date(session.started_at))}
            </time>{' '}
            · <span title={session.start_url}>{displayUrl(session.start_url)}</span> ·{' '}
            {session.duration_ms !== null ? formatElapsed(session.duration_ms) : 'recording'} · {media}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-1.5" role="toolbar" aria-label="Export">
            <CopyAllPrompts items={items ?? []} />
            <Button
              variant="outline"
              size="sm"
              onClick={download}
              title="Download session.json"
              data-testid="download-session"
            >
              <DownloadIcon aria-hidden="true" />
              session.json
            </Button>
            <ExportControls sessionId={sessionId} hasMedia={!!(session.audio || session.video)} />
          </div>
          {status && (
            <p role="status" className="max-w-md text-right text-muted-foreground">
              {status}
            </p>
          )}
        </div>
      </header>

      <section aria-labelledby="change-items" className="flex flex-col gap-3">
        <ProcessSection sessionId={sessionId} latest={latest} done={done} count={items?.length ?? null} />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div>
            {done && items && (
              <ChangeItemList
                sessionId={sessionId}
                run={done}
                items={items}
                edits={itemEdits}
                uncombined={edited!.uncombined}
                shots={shotIndex}
                selectedId={selected?.id ?? null}
                onSelect={setSelectedId}
              />
            )}
          </div>
          <aside className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start" aria-label="Recording">
            <h2 className="text-base font-semibold">Recording</h2>
            <Player
              ref={player}
              kind={recording.kind}
              blobId={recording.blobId}
              clock={recording.clock}
              note={playerNote || 'No recording.'}
            />
            {selected?.evidence.video && (
              <p className="text-muted-foreground" data-testid="evidence-time" data-item-id={selected.id}>
                {selected.id}: said at {formatElapsed(selected.evidence.video.start * 1000)}–
                {formatElapsed(selected.evidence.video.end * 1000)} (Session time)
              </p>
            )}
          </aside>
        </div>
      </section>

      <section aria-labelledby="timeline-heading" className="flex flex-col gap-2">
        <h2 id="timeline-heading" className="text-base font-semibold">
          Timeline
        </h2>
        <TranscriptRuns session={session} events={events} runs={runs} activeRun={activeRun} />
        <Timeline
          key={activeRun ?? 'live'}
          sessionId={sessionId}
          events={events}
          shots={shotIndex}
          onSeek={(ms) => player.current?.seek(ms)}
          canSeek={recording.kind !== null}
        />
      </section>

      <DraftItemsSection drafts={drafts} />
    </main>
  );
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The start page without its scheme: localhost:4401/pricing.html. */
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

const ROLE = { subject: 'Subject', reference: 'Reference', destination: 'Destination' } as const;

/** The live Draft Items (P0-10) as the reviewer left them: pinned ones went into Process as fixed items. */
function DraftItemsSection({ drafts }: { drafts: ReturnType<typeof draftViews> }) {
  return (
    <section aria-labelledby="drafts">
      <h2 id="drafts" className="mb-2 text-base font-semibold">
        Draft Items ({drafts.length})
      </h2>
      {drafts.length === 0 ? (
        <p className="text-muted-foreground">
          No Draft Items: they are made live during a Session when the Draft model has a key saved.
        </p>
      ) : (
        <>
          <p className="mb-2 text-muted-foreground">
            Pinned drafts go into Process unchanged; discarded ones are sent as readings to avoid.
          </p>
          <ol className="flex flex-col gap-2">
            {drafts.map(({ draft: d, state, source }) => (
              <li
                key={d.draft_id}
                data-testid="review-draft"
                data-draft-id={d.draft_id}
                data-state={state}
                className={`flex flex-col gap-1 rounded-lg border p-3 ${state === 'discarded' ? 'opacity-50' : ''} ${state === 'pinned' ? 'border-primary' : ''}`}
              >
                <p className="font-medium">
                  {d.draft_id} · {d.title}
                  <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs">{d.category}</span>
                  {state !== 'shown' && (
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs" data-testid="review-draft-state">
                      {state === 'pinned' ? 'Pinned' : 'Discarded'}
                      {source === 'voice' ? ' by voice' : ' by click'}
                    </span>
                  )}
                </p>
                <ul className="text-muted-foreground">
                  {d.locations.map((l, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: Locations have no id, and a Draft Item's list is replaced as a whole
                    <li key={i}>
                      {ROLE[l.role]}: {l.element}
                      {l.annotation !== null && ` (#${l.annotation})`}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  at {formatElapsed(d.t)} · {d.model}
                </p>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
