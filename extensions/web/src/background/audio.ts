// The Session's audio when its media context is gone before Stop (#9): the reviewer closed Safari's recorder window,
// and with it the page that would have joined the chunks (offscreen/capture.ts finalizeAudio). The service worker joins
// the chunks written so far instead. What the recorder had not written yet (at most one chunk) is lost.
import { AUDIO_PATH } from '@inkup/core/session-document';
import { type AudioMedia, db } from '@/db';
import { makeSeekable } from '@/media/seekable-webm';

export async function salvageAudio(sessionId: string, chunkMs: number): Promise<AudioMedia | null> {
  const chunks = await db.blobs.where('[session_id+kind]').equals([sessionId, 'audio_chunk']).sortBy('seq');
  if (chunks.length === 0) return null;
  const mime = chunks[0]!.mime;
  const joined = new Blob([await new Blob(chunks.map((c) => c.blob)).arrayBuffer()], { type: mime });
  // Each chunk is written a timeslice after the audio it holds began.
  const start = Math.max(0, chunks[0]!.t - chunkMs);
  let blob = joined;
  let duration = Math.max(0, chunks.at(-1)!.t - start);
  if (mime.includes('webm')) {
    try {
      const out = await makeSeekable(joined);
      blob = out.blob;
      duration = out.duration_ms;
    } catch (e) {
      console.warn('audio: could not write the duration into the salvaged recording', e);
    }
  }
  const id = `${sessionId}:audio`;
  await db.transaction('rw', db.blobs, async () => {
    await db.blobs.put({ id, session_id: sessionId, kind: 'audio', mime, size: blob.size, t: start, seq: 0, blob });
    await db.blobs.bulkDelete(chunks.map((c) => c.id));
  });
  return {
    blob_id: id,
    mime,
    start_offset_ms: start,
    duration_ms: Math.round(duration),
    chunk_count: chunks.length,
    path: AUDIO_PATH,
  };
}
