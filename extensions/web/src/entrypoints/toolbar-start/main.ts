// The toolbar's Start where it must be an extension frame (Firefox; docs/spikes/toolbar-start.md). A click in this
// frame is a user activation in an extension document, so it can open the screen picker, which a click on the page's
// own toolbar cannot. The frame then starts the Session for the tab it sits in and records the video itself, like
// the side panel does, holding the panel Port as a video owner that does not stop the Session: if its page navigates
// away the video ends there and the Session goes on.

import { FRAME_ERROR, FRAME_READY, FRAME_RECORDING } from '@/content/toolbar';
import { PANEL_PORT, type PanelToWorker, type WorkerToPanel } from '@/lib/panel-port';
import { pickTabVideo, TabVideoRecorder } from '@/media/tab-video';
import { sendMessage } from '@/messaging';
import { platform, type SurfacePort } from '@/platform';

const button = document.getElementById('start') as HTMLButtonElement;
let recorder: TabVideoRecorder | null = null;
let port: SurfacePort<PanelToWorker, WorkerToPanel> | null = null;

const tell = (msg: { type: string; error?: string; on?: boolean }) => window.parent.postMessage(msg, '*');

/** The Port that lets Stop ask for the last chunk; it reconnects if the service worker restarts. */
function connect(sessionId: string) {
  const p = platform.surfacePort.connect<PanelToWorker, WorkerToPanel>(PANEL_PORT);
  port = p;
  const post = (m: PanelToWorker) => {
    try {
      p.postMessage(m);
    } catch {
      /* reconnecting */
    }
  };
  post({ type: 'owner', session_id: sessionId, stops_session: false });
  p.onMessage((msg) => {
    if (msg.type === 'session') return follow(msg.session_id, msg.paused);
    if (msg.type !== 'flush_video') return;
    const r = recorder;
    void (async () => {
      const chunks = r && r.session === msg.session_id ? await r.flush() : 0;
      if (r === recorder) {
        recorder = null;
        tell({ type: FRAME_RECORDING, on: false });
      }
      post({ type: 'video_flushed', session_id: msg.session_id, chunks, stopped_at: r?.stoppedAt ?? Date.now() });
    })();
  });
  p.onDisconnect(() => {
    if (port === p && recorder) setTimeout(() => recorder && connect(sessionId), 100);
  });
}

button.addEventListener('click', async () => {
  const clickedAt = Date.now();
  button.disabled = true;
  // Said at once, not once recording: the Session (and a page's dialog) can reach the toolbar before this frame gets
  // the start's answer, and moving the overlay host meanwhile would reload this frame (content/top-layer.ts).
  tell({ type: FRAME_RECORDING, on: true });
  // First, while the click's activation is fresh: the screen picker.
  const picked = await pickTabVideo();
  // The keyboard goes back to the page, where the mode shortcuts and Esc are heard: left here, they would reach
  // this frame instead for the whole Session (F1).
  button.blur();
  window.parent.focus();
  try {
    const r = await sendMessage('startSession', { video: picked.info, clicked_at: clickedAt, from_toolbar: true });
    if (!r.ok) {
      picked.stream?.getTracks().forEach((t) => {
        t.stop();
      });
      tell({ type: FRAME_ERROR, error: r.error });
      return;
    }
    if (picked.stream) {
      recorder = new TabVideoRecorder(picked.stream, r.session.id, r.session.t0);
      recorder.start();
      connect(r.session.id);
    }
  } catch (e) {
    picked.stream?.getTracks().forEach((t) => {
      t.stop();
    });
    tell({ type: FRAME_ERROR, error: String(e) });
  } finally {
    button.disabled = false;
    if (!recorder) tell({ type: FRAME_RECORDING, on: false });
  }
});

// The recording pauses with the Session, and a Session that ended without asking this frame still frees the capture.
// Told over the Port: Firefox gives an extension frame inside a web page no storage.session, so watching
// activeSession here threw, and this frame never said it was ready (F1).
function follow(sessionId: string | null, paused: boolean) {
  if (!recorder) return;
  if (sessionId !== recorder.session) {
    const r = recorder;
    recorder = null;
    // Said once the capture is stopped (flush stops its tracks), so the page knows the picker's surface is free.
    void r.flush().finally(() => {
      if (!recorder) tell({ type: FRAME_RECORDING, on: false });
    });
    port?.disconnect();
    port = null;
    return;
  }
  recorder.setPaused(paused);
}
// The page is going away: ask the recorder for what it has; the Port's disconnect then ends the video.
addEventListener('pagehide', () => recorder?.requestData());

button.disabled = false;
tell({ type: FRAME_READY });
