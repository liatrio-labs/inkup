// The host as the window reads it: the app's commands (src-tauri/src/lib.rs), which proxy the control API
// (`GET /api/host/state`). The webview never holds the control token.
// The shapes are the contract's (contract/host-control.schema.json), from @inkup/protocol/host-control.
import type { ClientView, ControlState, HostKind, SessionOverview } from '@inkup/protocol/host-control';
import { invoke } from '@tauri-apps/api/core';

export type { ClientView, ControlState, SessionOverview };

/** Host or client: the app's own view of where it runs (src-tauri/src/lib.rs `HostView`), not the contract's. */
export type HostView = {
  mode: 'host' | 'client';
  kind: HostKind;
  address: string;
  data_dir: string;
};

export const hostView = () => invoke<HostView>('host_view');
export const hostState = () => invoke<ControlState>('host_state');

/** The TUI's words for a Session (host/crates/tui/src/ui.rs `session_state`). */
export function sessionState(s: SessionOverview): 'paused' | 'live' | 'processed' | 'ended' {
  if (s.live) return s.paused ? 'paused' : 'live';
  return s.items > 0 ? 'processed' : 'ended';
}

/** The TUI's words for a Client: connected, recording or paused, else only paired. */
export function clientState(c: ClientView, sessions: SessionOverview[]): string {
  if (!c.connected) return 'paired';
  const live = sessions.find((s) => s.live && s.client_id === c.id);
  if (!live) return 'connected';
  return live.paused ? 'connected, paused' : 'connected, recording';
}

/** The page a Session was on: its title, else its URL, else its id. */
export const sessionPage = (s: SessionOverview) => s.title || s.url || s.id;

/** `just now`, `5m ago`, `3h ago`, `2d ago`; `never` for no time. */
export function ago(now: number, at: number | null): string {
  if (at === null) return 'never';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
