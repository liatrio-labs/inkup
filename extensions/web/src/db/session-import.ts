// Restore from file: writes a read-back export (packages/core/src/session-file.ts) into the database, the reverse of
// loadSessionDocument. Session row, events in file order, the blobs the zip carries and the Process runs go in
// one transaction, so a failed restore leaves nothing behind. Only these four tables are written: an export
// carries no settings or keys, and a restore never touches them.
import type { SessionFile } from '@inkup/core/session-file';
import type { ProcessRunRow, ReviewDatabase, SessionRow } from './index';
import { deleteSession } from './sessions';

/** A Session with this id is already stored; the reviewer picks Open existing or Replace. */
export class SessionClashError extends Error {
  override name = 'SessionClashError';
  constructor(readonly sessionId: string) {
    super(`A Session with id ${sessionId} is already stored.`);
  }
}

export interface RestoreResult {
  session_id: string;
  /** Blobs session.json lists that the file did not carry (all of them for a bare session.json). */
  missing: number;
}

/** Restores `file`. Throws SessionClashError when the id is taken, unless `replace` deletes the stored one first. */
export async function restoreSession(
  database: ReviewDatabase,
  { doc, files }: SessionFile,
  { replace = false } = {},
): Promise<RestoreResult> {
  const id = doc.session.id;
  const shotTimes = new Map(
    doc.events.flatMap((e) => (e.type === 'screenshot' ? [[e.screenshot_id, e.t] as const] : [])),
  );
  const blobs = doc.blobs.flatMap((b) => {
    const blob = files.get(b.path);
    return blob
      ? [
          {
            id: b.id,
            session_id: id,
            kind: b.kind,
            mime: b.mime,
            size: blob.size,
            t: shotTimes.get(b.id) ?? 0,
            seq: 0,
            blob,
          },
        ]
      : [];
  });
  const stored = new Set(blobs.map((b) => b.id));
  const audio = doc.media.audio && stored.has(doc.media.audio.blob_id) ? doc.media.audio : null;
  const video = doc.media.video && stored.has(doc.media.video.blob_id) ? doc.media.video : null;
  const session: SessionRow = { ...doc.session, status: 'ended', audio, video };

  const run = doc.process_run;
  const at = (iso: string) => Date.parse(iso);
  const runs: ProcessRunRow[] = doc.process_runs.map((r) => ({
    id: r.id,
    session_id: id,
    created_at: at(r.created_at),
    finished_at: at(r.created_at),
    // A run the export caught mid-flight will never finish.
    status: r.status === 'running' ? 'failed' : r.status,
    model: r.model,
    estimate: null,
    items: null,
    calls: [],
    second_pass: [],
    ...(r.windows !== null ? { windows: r.windows } : {}),
    error: r.status === 'running' ? 'The export was made while this run was in progress.' : null,
    error_code: r.error_code as ProcessRunRow['error_code'],
  }));
  if (run) {
    const listed = runs.find((r) => r.id === run.id);
    const row: ProcessRunRow = {
      ...(listed ?? {
        id: run.id,
        session_id: id,
        created_at: at(doc.generated_at),
        finished_at: at(doc.generated_at),
        model: run.model,
        estimate: null,
        calls: [],
        second_pass: [],
        error: null,
        error_code: null,
      }),
      status: 'done',
      items: run.generated_items,
      windows: run.windows,
      dropped_annotations: run.dropped_annotations,
      unaccounted_annotations: run.unaccounted_annotations,
    };
    if (listed) runs.splice(runs.indexOf(listed), 1, row);
    else runs.push(row);
  }

  // processProgress too: Replace runs deleteSession inside this transaction, and it clears in-progress rows.
  await database.transaction(
    'rw',
    [
      database.sessions,
      database.events,
      database.blobs,
      database.processRuns,
      database.processProgress,
      database.resolutions,
    ],
    async () => {
      if (await database.sessions.get(id)) {
        if (!replace) throw new SessionClashError(id);
        await deleteSession(database, id);
      }
      await database.sessions.add(session);
      await database.events.bulkAdd(doc.events.map((e) => ({ ...e, session_id: id })));
      await database.blobs.bulkAdd(blobs);
      await database.processRuns.bulkAdd(runs);
    },
  );
  return { session_id: id, missing: doc.blobs.length - blobs.length };
}
