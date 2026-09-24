// Builds session.json from what the capture pipeline stored, plus the Change Items of the latest successful
// Process. Runs in extension pages (the review page) and in the service worker (Process input).
import {
  AUDIO_PATH,
  buildSessionDocument,
  type SessionDocument,
  SessionInfoSchema,
  screenshotPath,
  VIDEO_PATH,
} from '@inkup/core/session-document';
import type { ReviewDatabase } from './index';

export async function loadSessionDocument(
  database: ReviewDatabase,
  sessionId: string,
  now = new Date(),
): Promise<SessionDocument> {
  const row = await database.sessions.get(sessionId);
  if (!row) throw new Error(`no Session ${sessionId}`);
  const { audio, video, ...rest } = row;
  const session = SessionInfoSchema.parse(rest);
  const events = await database.events.where('session_id').equals(sessionId).toArray();
  const blobRows = await database.blobs.where('session_id').equals(sessionId).toArray();
  const blobs = blobRows
    .filter((b) => b.kind === 'screenshot' || b.kind === 'screenshot_crop' || b.kind === 'audio' || b.kind === 'video')
    .map((b) => ({
      id: b.id,
      kind: b.kind,
      mime: b.mime,
      size: b.size,
      path: b.kind === 'audio' ? AUDIO_PATH : b.kind === 'video' ? VIDEO_PATH : screenshotPath(b.id),
    }));
  const run = await database.latestRun(sessionId, 'done');
  const runs = await database.processRuns.where('session_id').equals(sessionId).sortBy('created_at');
  return buildSessionDocument({
    session,
    events,
    blobs,
    audio,
    video: video ?? null,
    now,
    process_run: run?.items
      ? {
          id: run.id,
          model: run.model,
          items: run.items,
          windows: run.windows,
          dropped_annotations: run.dropped_annotations,
          unaccounted_annotations: run.unaccounted_annotations,
        }
      : null,
    process_runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      model: r.model,
      created_at: new Date(r.created_at).toISOString(),
      error_code: r.error_code,
      windows: r.windows ?? null,
    })),
  });
}
