// Review page (PRD P0-12): the Change Item list on the left, each Location with its screenshot and Strokes, and the
// recording on the right, seeking to the selected item, the editable transcript, the Session's
// Annotations and Draft Items (pinned, discarded or neither), and the exports: Download session.json, Export (zip)
// and Copy all prompts.

import { formatElapsed } from '@inkup/core/clock';
import { draftViews } from '@inkup/core/drafts';
import { applyItemEdits, itemEditsFor, transcriptEdits } from '@inkup/core/review-edits';
import { type EventOf, isObjectSelectPick, sortTimeline, type TimelineEvent } from '@inkup/core/timeline';
import { activeRunId, activeTranscript, transcriptionRuns } from '@inkup/core/transcription-runs';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EvidenceShot, strokesOf, useShotIndex } from '@/components/evidence-shot';
import { Button } from '@/components/ui/button';
import { db } from '@/db';
import { loadSessionDocument } from '@/db/session-export';
import { platform } from '@/platform';
import { ChangeItemList, ProcessSection } from './change-items';
import { Player, type PlayerHandle, useRecording } from './evidence';
import { CopyAllPrompts, ExportControls } from './export';
import { TranscriptRuns } from './retranscribe';
import { TranscriptEditor } from './transcript';

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

  const annotations = useMemo(
    () => events.filter((e): e is EventOf<'annotation'> => e.type === 'annotation'),
    [events],
  );
  // The active run only (Slice 6): the live transcript, or the re-transcription the reviewer picked.
  const segments = useMemo(
    () => activeTranscript(events).filter((e): e is EventOf<'transcript_segment'> => e.type === 'transcript_segment'),
    [events],
  );
  const runs = useMemo(() => transcriptionRuns(events), [events]);
  const activeRun = useMemo(() => activeRunId(events), [events]);
  const edits = useMemo(() => transcriptEdits(events), [events]);
  const drafts = useMemo(() => draftViews(events), [events]);
  const shotIndex = useShotIndex(events);
  const scratched = useMemo(
    () =>
      new Set(
        events.flatMap((e) => (e.type === 'voice_command' && e.target?.kind === 'annotation' ? [e.target.id] : [])),
      ),
    [events],
  );

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
      const saved = await platform.saveFile(blob, `session-${sessionId.slice(0, 8)}.json`);
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
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Session review</h1>
          <p className="text-muted-foreground" data-testid="session-meta">
            {session.start_title || session.start_url} ·{' '}
            {session.duration_ms !== null ? formatElapsed(session.duration_ms) : 'recording'} · {media}
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <CopyAllPrompts items={items ?? []} />
          <Button variant="outline" onClick={download} data-testid="download-session">
            Download session.json
          </Button>
          <ExportControls sessionId={sessionId} hasMedia={!!(session.audio || session.video)} />
        </div>
      </header>
      {status && <p role="status">{status}</p>}

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

      <section aria-labelledby="transcript-heading">
        <h2 id="transcript-heading" className="mb-2 text-base font-semibold">
          Transcript
        </h2>
        <TranscriptRuns session={session} events={events} runs={runs} activeRun={activeRun} />
        <TranscriptEditor
          key={activeRun ?? 'live'}
          sessionId={sessionId}
          segments={segments}
          edits={edits}
          onSeek={(ms) => player.current?.seek(ms)}
          canSeek={recording.kind !== null}
        />
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-labelledby="annotations">
          <h2 id="annotations" className="mb-2 text-base font-semibold">
            Annotations ({annotations.length})
          </h2>
          <ol className="flex flex-col gap-4">
            {annotations.map((a) => {
              const pick = a.pick !== null ? a.candidates[a.pick] : undefined;
              const discarded = scratched.has(a.annotation_id);
              const endPick = (end: NonNullable<typeof a.connector>['tail']) =>
                (end.pick !== null ? end.candidates[end.pick]?.selector : null) ?? 'a region';
              return (
                <li
                  key={a.annotation_id}
                  className={`flex gap-4 rounded-lg border p-3 ${discarded ? 'opacity-50' : ''}`}
                  data-testid="annotation"
                  data-discarded={discarded}
                >
                  {a.screenshot_id && (
                    <EvidenceShot
                      id={a.screenshot_id}
                      shot={shotIndex.shots.get(a.screenshot_id)}
                      strokes={strokesOf(shotIndex, a.screenshot_id, [a.index])}
                      className="w-64 shrink-0 self-start"
                      alt="Screenshot taken when the Annotation closed"
                      testId="annotation-screenshot"
                    />
                  )}
                  <div className="flex flex-col gap-1">
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
                      <p>
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
                </li>
              );
            })}
          </ol>
        </section>
        <DraftItemsSection drafts={drafts} />
      </div>
    </main>
  );
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
          No Draft Items: they are made live during a Session when an Anthropic key is saved.
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
