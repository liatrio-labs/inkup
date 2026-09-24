// What the side panel and the toolbar's Start frame say over their Port to the service worker (background/panel-port.ts).
// Its own module so the Start frame, an extension frame inside a web page, does not load the worker's side, which
// reads storage.session: Firefox gives such a frame none (#31).
export const PANEL_PORT = 'panel';

/** `stops_session` (default true): the owner going away is Stop (the side panel); false ends only its video. */
export type PanelToWorker =
  | { type: 'owner'; session_id: string | null; stops_session?: boolean }
  | { type: 'ping' }
  | { type: 'video_flushed'; session_id: string; chunks: number; stopped_at: number };
/**
 * `session`: the live Session changed (null: none). The toolbar's Start frame follows it to pause and free its
 * recorder: Firefox gives an extension frame inside a web page no storage.session to watch.
 */
export type WorkerToPanel =
  | { type: 'flush_video'; session_id: string }
  | { type: 'session'; session_id: string | null; paused: boolean };
