// Tab video (PRD P0-5, ADR 0001/0002). Three contexts record it with the same recorder: the side panel (its Start
// click opens the screen picker), the toolbar's Start frame (Firefox) and the media context (Chrome's tabCapture,
// for a Session started from the page's toolbar or the shortcut; docs/spikes/toolbar-start.md). A picker is opened
// before anything slow, while the click's transient activation is fresh (docs/spikes/README.md c). The MediaRecorder
// writes a chunk to Dexie every second, so losing its context loses at most about a second; the service worker
// assembles the chunks on Stop.
import { toOffset } from '@inkup/core/clock';
import { db } from '@/db';
import { type StartVideo, sendMessage } from '@/messaging';
import { platform } from '@/platform';

/** PRD P0-5 default cap: 1280 px wide, 15 fps. About 1.2 Mbit/s keeps 30 minutes under ~300 MB. */
export const MAX_WIDTH = 1280;
export const MAX_FPS = 15;
const BITS_PER_SECOND = 1_200_000;
const CHUNK_MS = 1000;
const MIMES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

export type PickedVideo =
  | { stream: MediaStream; info: Extract<StartVideo, { state: 'recording' }> }
  | { stream: null; info: Extract<StartVideo, { state: 'off' }> };

/** Opens the browser's screen picker with tabs offered first and the extension's own surfaces left out. */
export async function pickTabVideo(): Promise<PickedVideo> {
  if (!platform.tabVideo.available()) return { stream: null, info: { state: 'off', reason: 'unavailable' } };
  try {
    const stream = await platform.tabVideo.pick({ maxWidth: MAX_WIDTH, maxFps: MAX_FPS });
    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings();
    return {
      stream,
      info: {
        state: 'recording',
        label: track?.label ?? '',
        width: settings?.width ?? null,
        height: settings?.height ?? null,
      },
    };
  } catch (e) {
    // Cancel (or dismissing the picker) rejects with NotAllowedError.
    const cancelled = e instanceof DOMException && e.name === 'NotAllowedError';
    return { stream: null, info: { state: 'off', reason: cancelled ? 'picker_cancelled' : 'failed' } };
  }
}

/** Chrome: opens the tab a `tabCapture` capture id names (Platform.tabVideo.captureId), capped like the picker. */
export function openTabCapture(captureId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: captureId,
        maxWidth: MAX_WIDTH,
        maxFrameRate: MAX_FPS,
      },
    },
  } as unknown as MediaStreamConstraints);
}

export class TabVideoRecorder {
  private readonly recorder: MediaRecorder;
  private seq = 0;
  private writes: Promise<unknown>[] = [];
  private stopped: Promise<void>;
  private flushed: Promise<number> | null = null;
  /** Epoch ms when the recorder stopped (the recording's real end, whatever its last frame says). */
  stoppedAt: number | null = null;
  private startedAt = 0;

  constructor(
    private readonly stream: MediaStream,
    private readonly sessionId: string,
    t0: number,
  ) {
    const mimeType = MIMES.find((m) => MediaRecorder.isTypeSupported(m));
    this.recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: BITS_PER_SECOND,
    });
    this.stopped = new Promise((resolve) => {
      this.recorder.onstop = () => {
        this.stoppedAt = Date.now();
        resolve();
      };
    });
    // The file's time 0 is when start() was called (its first frame is the latest one captured by then), not
    // when the start event fires: on a loaded machine that comes seconds later, and the video then seeked late.
    this.recorder.onstart = () =>
      void sendMessage('videoStatus', {
        session_id: sessionId,
        event: 'started',
        started_at: this.startedAt,
        mime: this.recorder.mimeType || 'video/webm',
      }).catch(() => {});
    this.recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      const seq = this.seq++;
      this.writes.push(
        db.blobs.put({
          id: `${sessionId}:video_chunk:${seq}`,
          session_id: sessionId,
          kind: 'video_chunk',
          mime: e.data.type || this.recorder.mimeType,
          size: e.data.size,
          t: toOffset(t0, Date.now()),
          seq,
          blob: e.data,
        }),
      );
    };
    // "Stop sharing" in Chrome's bar ends the track: the Session continues without video.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this.recorder.state !== 'inactive') this.recorder.stop();
      void sendMessage('videoStatus', { session_id: sessionId, event: 'ended' }).catch(() => {});
    });
  }

  start(): void {
    this.startedAt = Date.now();
    this.recorder.start(CHUNK_MS);
  }

  setPaused(paused: boolean): void {
    if (paused && this.recorder.state === 'recording') this.recorder.pause();
    else if (!paused && this.recorder.state === 'paused') this.recorder.resume();
  }

  /** Asks for the data recorded so far (on pagehide: the document may not live long enough to write it). */
  requestData(): void {
    if (this.recorder.state === 'recording') this.recorder.requestData();
  }

  /** Stops the recorder and the capture, and resolves once every chunk is in Dexie. */
  flush(): Promise<number> {
    this.flushed ??= (async () => {
      if (this.recorder.state !== 'inactive') this.recorder.stop();
      await this.stopped;
      this.stream.getTracks().forEach((t) => {
        t.stop();
      });
      await Promise.all(this.writes);
      return this.seq;
    })();
    return this.flushed;
  }

  get session(): string {
    return this.sessionId;
  }
}
