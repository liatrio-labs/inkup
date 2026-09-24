// The side panel holds a long-lived Port to the service worker (ADR 0001: closing the panel is Stop). Chrome
// disconnects the Port when the panel document goes away, closed or reloaded, and the worker then stops the
// Session the panel owns. The same Port carries Stop's "finish your video" request, so the worker can wait for
// the panel's last chunk before it assembles the recording.
//
// The toolbar's Start frame (Firefox; docs/spikes/toolbar-start.md) records video the same way and holds the same
// Port, but it is not a control surface: when it goes away (its page navigated or closed) the video ends and the
// Session goes on (ADR 0004: a Session started from the toolbar does not depend on any page).
//
// If the worker itself is restarted, the panel sees its Port drop, reconnects and registers again; its pings
// every 20 s also keep the worker from idling out while a panel is open.

import { PANEL_PORT, type PanelToWorker, type WorkerToPanel } from '@/lib/panel-port';
import { platform, type SurfacePort } from '@/platform';
import { activeSession } from '@/session-state';

type PanelPort = SurfacePort<WorkerToPanel, PanelToWorker>;

interface Owner {
  port: PanelPort;
  session_id: string;
  stops_session: boolean;
}

/** What the panel's recorder wrote, and when it stopped: at the flush, or when its panel went away. */
export interface PanelVideoEnd {
  chunks: number | null;
  stopped_at: number;
}

let owner: Owner | null = null;
const flushWaiters = new Map<string, (end: PanelVideoEnd) => void>();
/** When each Session's owning panel disconnected: its recorder stopped then. */
const goneAt = new Map<string, number>();

export function listenForPanels(
  onOwnerGone: (sessionId: string) => void,
  onVideoOwnerGone: (sessionId: string) => void,
): void {
  platform.surfacePort.onConnect<WorkerToPanel, PanelToWorker>(PANEL_PORT, (port: PanelPort) => {
    port.onMessage((msg) => {
      if (msg.type === 'owner') {
        if (msg.session_id) owner = { port, session_id: msg.session_id, stops_session: msg.stops_session ?? true };
        else if (owner?.port === port) owner = null;
        if (msg.session_id) void activeSession.getValue().then(tellOwner);
      } else if (msg.type === 'video_flushed') {
        flushWaiters.get(msg.session_id)?.({ chunks: msg.chunks, stopped_at: msg.stopped_at });
        flushWaiters.delete(msg.session_id);
      }
    });
    port.onDisconnect(() => {
      if (owner?.port !== port) return;
      const { session_id: sessionId, stops_session } = owner;
      owner = null;
      const at = Date.now();
      goneAt.set(sessionId, at);
      for (const [id, done] of flushWaiters) if (id === sessionId) done({ chunks: null, stopped_at: at });
      (stops_session ? onOwnerGone : onVideoOwnerGone)(sessionId);
    });
  });
}

function tellOwner(s: { id: string; paused: unknown } | null): void {
  try {
    owner?.port.postMessage({
      type: 'session',
      session_id: s?.id ?? null,
      paused: !!s?.paused,
    } satisfies WorkerToPanel);
  } catch {
    /* gone: its disconnect handles it */
  }
}

/** The owner hears every change of the live Session. */
export function followSessionForOwner(): void {
  activeSession.watch(tellOwner);
}

/**
 * Asks the owning panel to stop its video recorder and write the last chunk. Resolves with the chunk count and
 * the stop time. The count is null when no panel owns the Session (it was closed: the stop time is when it
 * went) or it did not answer within `timeoutMs` (the stop time is now).
 */
export function flushPanelVideo(sessionId: string, timeoutMs = 8000): Promise<PanelVideoEnd> {
  if (owner?.session_id !== sessionId) {
    const at = goneAt.get(sessionId) ?? Date.now();
    goneAt.delete(sessionId);
    return Promise.resolve({ chunks: null, stopped_at: at });
  }
  const port = owner.port;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      flushWaiters.delete(sessionId);
      resolve({ chunks: null, stopped_at: Date.now() });
    }, timeoutMs);
    flushWaiters.set(sessionId, (end) => {
      clearTimeout(timer);
      resolve(end);
    });
    try {
      port.postMessage({ type: 'flush_video', session_id: sessionId } satisfies WorkerToPanel);
    } catch {
      flushWaiters.delete(sessionId);
      clearTimeout(timer);
      resolve({ chunks: null, stopped_at: Date.now() });
    }
  });
}
