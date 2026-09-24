// Tab video in the media context (Chrome; docs/spikes/toolbar-start.md). A Session started from the page's toolbar
// or the shortcut has no panel click to open the screen picker, so the service worker mints a tabCapture id for the
// Session tab and this document opens it. The capture follows the tab across navigations and lives as long as the
// Session, like the microphone. The same recorder as the panel's writes the chunks; Stop assembles them.
import { openTabCapture, TabVideoRecorder } from '@/media/tab-video';
import type { OffscreenVideo } from '@/messaging';

let recorder: TabVideoRecorder | null = null;

const errMsg = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export async function startTabVideo(sessionId: string, t0: number, captureId: string): Promise<OffscreenVideo> {
  if (recorder) await stopTabVideo();
  try {
    const stream = await openTabCapture(captureId);
    const settings = stream.getVideoTracks()[0]?.getSettings();
    recorder = new TabVideoRecorder(stream, sessionId, t0);
    recorder.start();
    return { ok: true, width: settings?.width ?? null, height: settings?.height ?? null };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export function pauseTabVideo(paused: boolean): void {
  recorder?.setPaused(paused);
}

/** Stops the recorder and resolves once its chunks are in Dexie; null when no tab video was recording. */
export async function stopTabVideo(): Promise<{ chunks: number; stopped_at: number } | null> {
  const r = recorder;
  if (!r) return null;
  recorder = null;
  const chunks = await r.flush();
  return { chunks, stopped_at: r.stoppedAt ?? Date.now() };
}
