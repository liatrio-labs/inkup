// Chromium's MediaRecorder writes a live WebM: no duration and no cues (crbug 40482588), so a player cannot
// seek in it. ts-ebml rewrites the header with the duration, a SeekHead and Cues (docs/PLAN.md). Runs in the
// service worker on Stop, and in Node for tests.
import './buffer-global';
import { Decoder, Reader, tools } from 'ts-ebml';

export interface SeekableWebm {
  blob: Blob;
  /** From the last block's timestamp, in ms. */
  duration_ms: number;
  cues: number;
}

/**
 * `minDurationMs` is how long the recorder actually ran. Tab capture sends a frame only when the page repaints
 * (about one refresh frame a second on a static page), so the last block can end well before the recorder
 * stopped; the header then says the longer of the two, and the last frame stays on screen until it.
 */
export async function makeSeekable(input: Blob, minDurationMs = 0): Promise<SeekableWebm> {
  const buf = await input.arrayBuffer();
  const decoder = new Decoder();
  const reader = new Reader();
  reader.logging = false;
  reader.drop_default_duration = false;
  for (const elm of decoder.decode(buf)) reader.read(elm);
  reader.stop();
  if (!reader.metadatas.length || reader.metadataSize <= 0)
    throw new Error('not a WebM stream (no metadata before the first cluster)');
  const duration = Math.max(reader.duration, (minDurationMs * 1e6) / reader.timestampScale);
  const header = tools.makeMetadataSeekable(reader.metadatas, duration, reader.cues);
  const body = buf.slice(reader.metadataSize);
  return {
    blob: new Blob([header, body], { type: input.type || 'video/webm' }),
    duration_ms: Math.round((duration * reader.timestampScale) / 1e6),
    cues: reader.cues.length,
  };
}
