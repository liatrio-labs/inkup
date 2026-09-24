// Stop assembles the panel's video chunks into one recording (P0-5): join them in order, rewrite the header with
// ts-ebml so the file has a duration and cues and a <video> can seek to an item, store it as one `video` blob and
// drop the chunks. If the rewrite fails the joined file is kept, marked not seekable.
import { toOffset } from '@inkup/core/clock';
import { expectedMediaDuration, pauseGaps } from '@inkup/core/media-time';
import { VIDEO_PATH } from '@inkup/core/session-document';
import { db, type VideoMedia } from '@/db';
import { makeSeekable } from '@/media/seekable-webm';
import type { LiveVideo } from '@/settings';

/**
 * `stoppedAt` (epoch ms) is when the panel's recorder stopped. While it was still recording, the file lasts
 * until then even if the page stopped repainting earlier: the Session clock, not the last frame, ends it.
 */
const videoChunks = (sessionId: string) =>
  db.blobs.where('[session_id+kind]').equals([sessionId, 'video_chunk']).sortBy('seq');

/**
 * The chunks' bytes, joined. The panel wrote them from another document a moment ago, and Chromium can refuse
 * to read such a blob at first (NotReadableError, seen on the Linux CI runners). Each retry reads the rows
 * again for fresh handles. The joined bytes are held in memory, so nothing stored later points at a chunk that
 * cannot be read (storing one of those never completed, and Stop hung on "Finishing...").
 */
async function readChunks(sessionId: string, mime: string, tries = 5): Promise<Blob> {
  for (let i = 1; ; i++) {
    const chunks = await videoChunks(sessionId);
    try {
      return new Blob([await new Blob(chunks.map((c) => c.blob)).arrayBuffer()], { type: mime });
    } catch (e) {
      if (i >= tries) throw e;
      console.warn(`video: chunks not readable yet (try ${i} of ${tries})`, e);
      await new Promise((r) => setTimeout(r, 250 * i));
    }
  }
}

export async function finalizeVideo(
  sessionId: string,
  t0: number,
  live: Extract<LiveVideo, { state: 'recording' | 'ended' }>,
  stoppedAt: number | null = null,
): Promise<VideoMedia | null> {
  const chunks = await videoChunks(sessionId);
  if (chunks.length === 0) return null;
  const mime = live.mime ?? chunks[0]!.mime;
  const joined = await readChunks(sessionId, mime);
  // "Stop sharing" ended the capture earlier, at a time the worker did not log: then the last frame ends it.
  const ranFor =
    live.state === 'recording' && live.start_offset_ms !== null && stoppedAt !== null
      ? expectedMediaDuration(toOffset(t0, stoppedAt), {
          start_offset_ms: live.start_offset_ms,
          gaps: pauseGaps(await db.events.where('session_id').equals(sessionId).toArray()),
        })
      : 0;
  let blob = joined;
  let seekable = false;
  let duration = 0;
  try {
    const out = await makeSeekable(joined, ranFor);
    blob = out.blob;
    duration = out.duration_ms;
    seekable = true;
  } catch (e) {
    console.warn('video: could not make the recording seekable', e);
  }
  // The first chunk is written about one timeslice after the recorder starts.
  const start = live.start_offset_ms ?? Math.max(0, chunks[0]!.t - 1000);
  const id = `${sessionId}:video`;
  await db.transaction('rw', db.blobs, async () => {
    await db.blobs.put({ id, session_id: sessionId, kind: 'video', mime, size: blob.size, t: start, seq: 0, blob });
    await db.blobs.bulkDelete(chunks.map((c) => c.id));
  });
  return {
    blob_id: id,
    mime,
    start_offset_ms: start,
    duration_ms: seekable ? duration : Math.max(0, chunks.at(-1)!.t - start),
    chunk_count: chunks.length,
    seekable,
    label: live.label,
    width: live.width,
    height: live.height,
    path: VIDEO_PATH,
  };
}

export const startOffset = (t0: number, startedAt: number) => toOffset(t0, startedAt);
