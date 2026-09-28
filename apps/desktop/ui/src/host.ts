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

/** Install CLI (src-tauri/src/cli.rs `CliStatus`): what is at the link and which `inkup` a terminal runs. */
export type CliStatus = {
  /** The CLI inside this app; null for a build without it (a development build). */
  bundled: string | null;
  /** Where the link goes: /usr/local/bin/inkup. */
  link: string;
  /** Every `inkup` on the login shell's PATH, in order: the first is the one a terminal runs. */
  on_path: string[];
} & ({ state: 'none' | 'ours' | 'file' } | { state: 'broken' | 'other'; target: string });

/** null outside macOS, where the app bundles no CLI. */
export const cliStatus = () => invoke<CliStatus | null>('cli_status');
/** `replace`: the person confirmed replacing another `inkup` at the link. */
export const installCli = (replace: boolean) => invoke<CliStatus | null>('install_cli', { replace });
export const uninstallCli = () => invoke<CliStatus | null>('uninstall_cli');

/** What the Install CLI dialog says about the link. */
export function cliState(s: CliStatus): string {
  if (!s.bundled) {
    return 'This build of the app has no inkup CLI inside it. Build one with scripts/desktop-cli.sh, then the app with --config src-tauri/tauri.cli.conf.json.';
  }
  switch (s.state) {
    case 'none':
      return `Not installed. Install links ${s.link} to the CLI inside this app, so it updates with the app. macOS asks for an administrator's password if ${dirOf(s.link)} is not yours to change.`;
    case 'ours':
      return `Installed: ${s.link} points at the CLI inside this app, and updates with it.`;
    case 'broken':
      return `${s.link} points at ${s.target}, which is gone: the app was moved or deleted. Reinstall to point it at this app.`;
    case 'other':
      return `${s.link} points at another inkup: ${s.target}. Replacing it points it at this app's CLI; the other copy stays where it is.`;
    case 'file':
      return `${s.link} is a file, not a link: another install put it there. Replacing it deletes that file and links this app's CLI.`;
  }
}

/** Which `inkup` a terminal runs, when that is not what the link says; null when it is. */
export function cliOnPath(s: CliStatus): string | null {
  const [first, ...rest] = s.on_path;
  if (first === undefined) {
    return s.state === 'ours'
      ? `${dirOf(s.link)} is not on your shell's PATH, so a terminal does not find inkup.`
      : null;
  }
  if (first !== s.link) {
    const also = s.on_path.includes(s.link) ? `, before ${s.link}` : '';
    return `A terminal runs ${first}: it comes first on PATH${also}.`;
  }
  return rest.length > 0 ? `A terminal runs ${s.link}. Later on PATH, not run: ${rest.join(', ')}.` : null;
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

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
