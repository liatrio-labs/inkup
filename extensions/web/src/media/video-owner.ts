// A video recorder for a Session that no control surface owns: the toolbar's Start frame (Firefox) and the picker
// window (Chrome, when tabCapture is refused). It holds the panel Port as an owner that does not stop the Session
// (stops_session: false), so Stop can ask for its last chunk, and follows the Session over that Port to pause with it
// and to free the capture once it ends. Firefox gives an extension frame inside a web page no storage.session to
// watch, hence the Port (ADR 0010). If this document goes away the video ends there and the Session goes on.
import { PANEL_PORT, type PanelToWorker, type WorkerToPanel } from '@/lib/panel-port';
import { platform, type SurfacePort } from '@/platform';
import type { TabVideoRecorder } from './tab-video';

/**
 * Holds the Port for `recorder`, already started, until its Session ends or Stop flushes it; `onEnd` runs once the
 * capture is stopped and every chunk is written.
 */
export function holdVideo(recorder: TabVideoRecorder, onEnd: () => void): void {
  const sessionId = recorder.session;
  let live = true;
  let port: SurfacePort<PanelToWorker, WorkerToPanel> | null = null;

  const end = (then: (chunks: number) => void = () => {}) => {
    if (!live) return;
    live = false;
    void recorder.flush().then((chunks) => {
      then(chunks);
      onEnd();
    });
  };

  // It reconnects if the service worker restarts.
  const connect = () => {
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
      if (msg.type === 'flush_video') {
        if (msg.session_id !== sessionId) return;
        if (!live) {
          post({ type: 'video_flushed', session_id: sessionId, chunks: 0, stopped_at: Date.now() });
          return;
        }
        end((chunks) =>
          post({ type: 'video_flushed', session_id: sessionId, chunks, stopped_at: recorder.stoppedAt ?? Date.now() }),
        );
      } else if (msg.session_id !== sessionId) {
        // The Session ended without asking for the video: the capture is still freed.
        end();
        port?.disconnect();
        port = null;
      } else if (live) recorder.setPaused(msg.paused);
    });
    p.onDisconnect(() => {
      if (port === p && live) setTimeout(() => live && connect(), 100);
    });
  };
  connect();
}
