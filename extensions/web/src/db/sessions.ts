// The Session list's queries (PRD P0-14): a summary per stored Session, and delete. Runs in extension pages.
import { applyItemEdits, itemEditsFor, sessionName } from '@inkup/core/review-edits';
import { sortTimeline } from '@inkup/core/timeline';
import type { ReviewDatabase, SessionRow } from './index';
import { type ItemStatusCounts, itemStatusCounts } from './resolutions';

export interface SessionSummary {
  id: string;
  start_url: string;
  start_title: string;
  /** What the reviewer named it on the review page, else the start page's title or URL (sessionName). */
  name: string;
  started_at: string;
  status: SessionRow['status'];
  duration_ms: number | null;
  /**
   * Change Items of the latest successful Process, as reviewed (edits applied), by their latest Resolution from a
   * paired Host; null before Process.
   */
  items: ItemStatusCounts | null;
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
      let items: ItemStatusCounts | null = null;
      if (run?.items) {
        const edits = await database.eventsOfType(s.id, 'item_edit').toArray();
        const current = applyItemEdits(run.items, itemEditsFor(edits, run.id)).items;
        // Read in the live query, so a Resolution the Host pushes refreshes the row.
        const resolutions = await database.resolutions.where('session_id').equals(s.id).toArray();
        items = itemStatusCounts(
          current.map((i) => i.id),
          resolutions.filter((r) => r.run_id === run.id),
        );
      }
      const renames = await database.eventsOfType(s.id, 'session_rename').toArray();
      return {
        id: s.id,
        start_url: s.start_url,
        start_title: s.start_title,
        name: sessionName(s, sortTimeline(renames)),
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
