// The host as the window reads and drives it: the app's commands (src-tauri/src/lib.rs), which proxy the control
// API (`/api/host/*`). The webview never holds the control token.
// The shapes are the contract's (contract/host-control.schema.json), from @inkup/protocol/host-control.
import type {
  ClientView,
  CommandOutcome,
  CommandRequest,
  ControlState,
  HostKind,
  ItemStatus,
  ItemView,
  NewToken,
  PairingAnswer,
  PairingPrompt,
  SessionOverview,
} from '@inkup/protocol/host-control';
import { invoke } from '@tauri-apps/api/core';

export type { ClientView, CommandRequest, ControlState, ItemView, NewToken, PairingPrompt, SessionOverview };

/** Host or client: the app's own view of where it runs (src-tauri/src/lib.rs `HostView`), not the contract's. */
export type HostView = {
  mode: 'host' | 'client';
  kind: HostKind;
  address: string;
  data_dir: string;
};

/** Where the app's icons show (`[desktop]` in config.toml). One of them stays on. */
export type Toggles = { menubar: boolean; dock: boolean };

export const hostView = () => invoke<HostView>('host_view');
export const hostState = (timeline?: string) => invoke<ControlState>('host_state', { timeline });
/** Resolves with the new change count once the host changed after `since` (or after a while with no change). */
export const hostChanges = (since: number) => invoke<number>('host_changes', { since });
export const sendCommand = (request: CommandRequest) => invoke<CommandOutcome>('send_command', { request });
export const createToken = (name: string) => invoke<NewToken>('create_token', { name });
export const revokeToken = (id: string) => invoke<void>('revoke_token', { id });
/** Whether the host switches: only the app hosting does, restarting its server. */
export const setNetwork = (on: boolean) => invoke<boolean>('set_network', { on });
export const answerPairing = (id: number, decision: PairingAnswer['decision']) =>
  invoke<void>('answer_pairing', { id, answer: { decision } });
/** The pairing link as an SVG QR code. */
export const pairingQr = (link: string) => invoke<string>('pairing_qr', { link });
/** Tries the data dir again after the host went away: the app hosts it, or joins whoever took it. */
export const hostHere = () => invoke<HostView>('host_here');
export const desktopToggles = () => invoke<Toggles>('desktop_toggles');
export const setDesktopToggles = (toggles: Toggles) => invoke<Toggles>('set_desktop_toggles', { toggles });

/** The app's events (src-tauri/src/lib.rs): the tray changed a toggle; the host was taken over or restarted. */
export const TOGGLES_EVENT = 'desktop-toggles';
export const VIEW_EVENT = 'host-view';

/** The TUI's warning in network mode (inkup_server::NETWORK_WARNING). */
export const NETWORK_WARNING = 'Network mode: unencrypted on this LAN — trusted networks only';

/** Who hosts, in words. */
export const KIND: Record<HostKind, string> = { desktop: 'this app', tui: 'the inkup TUI', serve: 'inkup serve' };

/** Where network mode is switched when this app is not the host. */
export const NETWORK_ELSEWHERE: Record<HostKind, string> = {
  desktop: 'Switch it in the InkUp app that hosts.',
  tui: 'Switch it in the inkup TUI with N.',
  serve: 'Restart inkup serve with or without --network.',
};

/** The TUI's words for a Session (host/crates/tui/src/ui.rs `session_state`). */
export function sessionState(s: SessionOverview): 'paused' | 'live' | 'processed' | 'ended' {
  if (s.live) return s.paused ? 'paused' : 'live';
  return s.items > 0 ? 'processed' : 'ended';
}

/** The TUI's words for a Client: connected, recording or paused, else only paired. */
export function clientState(c: ClientView, sessions: SessionOverview[]): string {
  if (!c.connected) return 'paired';
  const live = liveSessionOf(c.id, sessions);
  if (!live) return 'connected';
  return live.paused ? 'connected, paused' : 'connected, recording';
}

/** The page a Session was on: its title, else its URL, else its id. */
export const sessionPage = (s: SessionOverview) => s.title || s.url || s.id;

/** The TUI's words for an item's status (host/crates/tui/src/ui.rs `status_label`). */
export const STATUS_LABEL: Record<ItemStatus, string> = {
  open: 'open',
  in_progress: 'in work',
  resolved: 'done',
  wont_fix: "won't fix",
  needs_info: 'needs info',
};

/** In work: who and since when, then the note. Otherwise the note. */
export function resolutionLine(now: number, item: ItemView): string {
  const note = item.note ?? '';
  if (item.status !== 'in_progress') return note;
  const head = `${item.agent ?? 'an agent'}, ${ago(now, item.since)}`;
  return note ? `${head}: ${note}` : head;
}

/** `mm:ss` since the Session started. */
export function clock(t: number): string {
  const seconds = Math.max(0, Math.floor(t / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A pairing code as the TUI shows it: `042 917`. */
export const spacedCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/** The live Session of a Client, if any. */
export const liveSessionOf = (clientId: string, sessions: SessionOverview[]) =>
  sessions.find((s) => s.live && s.client_id === clientId);

/** `just now`, `5m ago`, `3h ago`, `2d ago`; `never` for no time. */
export function ago(now: number, at: number | null): string {
  if (at === null) return 'never';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
