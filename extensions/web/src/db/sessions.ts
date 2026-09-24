// The Session list's queries (PRD P0-14): a summary per stored Session, and delete. Runs in extension pages.
import { applyItemEdits, itemEditsFor } from '@inkup/core/review-edits';
import type { ReviewDatabase, SessionRow } from './index';

export interface SessionSummary {
  id: string;
  start_url: string;
  start_title: string;
  started_at: string;
  status: SessionRow['status'];
  duration_ms: number | null;
  /** Change Items of the latest successful Process, as reviewed (edits applied); null before Process. */
  items: number | null;
  /** Sum of the Session's stored blobs: audio, video, screenshots and any leftover chunks. */
  bytes: number;
}

export async function sessionSummaries(database: ReviewDatabase): Promise<SessionSummary[]> {
  const sessions = await database.sessions.toArray();
  return Promise.all(
    sessions.map(async (s) => {
      let bytes = 0;
      await database.blobs
        .where('session_id')
        .equals(s.id)
        .each((b) => (bytes += b.size));
      const run = await database.latestRun(s.id, 'done');
      let items: number | null = null;
      if (run?.items) {
        const edits = await database.eventsOfType(s.id, 'item_edit').toArray();
        items = applyItemEdits(run.items, itemEditsFor(edits, run.id)).items.length;
      }
      return {
        id: s.id,
        start_url: s.start_url,
        start_title: s.start_title,
        started_at: s.started_at,
        status: s.status,
        duration_ms: s.duration_ms,
        items,
        bytes,
      };
    }),
  );
}

/** Deletes a Session and everything stored for it: events, media, screenshots and Process runs. */
export async function deleteSession(database: ReviewDatabase, id: string): Promise<void> {
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
      await database.sessions.delete(id);
      await database.resolutions.where('session_id').equals(id).delete();
      await database.events.where('session_id').equals(id).delete();
      await database.blobs.where('session_id').equals(id).delete();
      const runs = await database.processRuns.where('session_id').equals(id).primaryKeys();
      await database.processProgress.where('run_id').anyOf(runs).delete();
      await database.processRuns.where('session_id').equals(id).delete();
    },
  );
}
