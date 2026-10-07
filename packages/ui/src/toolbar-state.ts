// The toolbar's UI contract (CONTEXT.md Toolbar, ADR 0011): what a capture surface pushes to the toolbar
// (ToolbarState) and what the toolbar asks of it (ToolbarActions). The extension's service worker pushes this shape
// today (extensions/web/src/messaging.ts re-exports it); the desktop app's toolbar panel will serialize the same one.
// No DOM, no React: only types and the Start frame's message names.

/** The page modes besides Draw (E7): pick an element (Object Select) or select text (Select Text). */
export type SelectMode = 'object' | 'text';

/** The toolbar's light or dark look (ADR 0011): light over dark pages, dark over light ones. */
export type ToolbarTheme = 'light' | 'dark';
/** The theme button's setting: follow the page, or fixed. */
export type ToolbarThemeSetting = 'auto' | ToolbarTheme;
/** How the theme was decided: computed styles, a captured sample, or the reviewer's setting. */
export type ToolbarThemeSource = 'style' | 'sample' | 'setting';

/** What the toolbar shows; null hides it. It renders only this, so it has no state of its own beyond position. */
export interface ToolbarState {
  /** The live Session. `here`: it records this tab (else the toolbar offers only Stop). */
  session: {
    t0: number;
    paused_ms: number;
    /** Session time of the open pause, or null while recording. */
    paused_t: number | null;
    /** Until the page has the Session (F1): the toolbar says "Starting…". */
    starting: boolean;
    stopping: boolean;
    draw_mode: boolean;
    /** Object Select or Select Text is on (E7); never together with draw_mode. */
    select_mode: SelectMode | null;
    /** Drawing is possible on this page (not a 'no_overlay' page). */
    can_draw: boolean;
    here: boolean;
    /** The Session's video: recording, ended (the share stopped) or off. */
    video: 'off' | 'recording' | 'ended';
    /** The microphone is muted (E10). */
    muted: boolean;
    /** The microphone records (E11); false: "No mic", with "Turn on voice". */
    voice: boolean;
  } | null;
  /** The Session just cancelled (E10), until its Undo deadline (epoch ms): the toast offers Undo. */
  discard: { session_id: string; deadline: number } | null;
  /** Start is possible, and how it would get video (without a microphone grant the Session has no voice, E11). */
  start: { ok: true; video: 'tab_capture' | 'frame_picker' | 'none' } | { ok: false; reason: string };
  /** Only while paired (ADR 0004): unpaired, no host UI at all. */
  host: 'connected' | 'offline' | null;
  /** The paired Host is on another computer (network mode, ADR 0006): nothing it is sent is encrypted. */
  hostNetwork: boolean;
  /** The toast strip: the latest caption or Draft Item of the live Session. */
  toast: { id: string; kind: 'caption' | 'draft'; text: string } | null;
  /** The last error to show (a failed Start, the microphone failing mid-Session). */
  notice: string | null;
  /** The viewport control (plan E6), or null where this page cannot be resized (the control is hidden). */
  viewport: ToolbarViewport | null;
}

export interface ToolbarViewport {
  /** The size the page is resized to, or null at the tab's own size. */
  current: { width: number; height: number; scale: number } | null;
  /** The tab's own size: "Fit to tab", and the limit past which a size is shown scaled down. */
  tab: { width: number; height: number };
  /** The last size used on this origin. */
  last: { width: number; height: number } | null;
  /** Why this page cannot be resized (it refuses framing): the control says so instead of offering sizes. */
  blocked?: string;
}

/** The viewport control's requests (plan E6). */
export interface ViewportActions {
  set(size: { width: number; height: number }): Promise<{ ok: true } | { ok: false; error: string }>;
  reset(): Promise<unknown>;
}

/** Where the toolbar sits (viewport px, its top-left corner) and whether it is collapsed to a pill. */
export interface ToolbarPosition {
  x: number;
  y: number;
  collapsed: boolean;
}

/** What a Start click got: the toolbar only needs to know whether it failed, and why. */
export type ToolbarStartResult = { ok: true } | { ok: false; error: string };

export interface ToolbarActions {
  start(): Promise<ToolbarStartResult>;
  pause(): Promise<unknown>;
  resume(): Promise<unknown>;
  stop(): Promise<unknown>;
  /** Cancel (E10): stop and discard, with Undo until the deadline. */
  cancel(): Promise<unknown>;
  undoDiscard(sessionId: string): Promise<unknown>;
  /** Mute (E10): the mic off (true) or back on. */
  setMuted(on: boolean): Promise<unknown>;
  /** "Turn on voice" (E11): the microphone for a Session without one. */
  turnOnVoice(): Promise<unknown>;
  setDraw(on: boolean): Promise<unknown>;
  /** Object Select or Select Text on (null: off). */
  setSelect(mode: SelectMode | null): Promise<unknown>;
  snap(): Promise<unknown>;
  open(what: 'panel' | 'setup'): Promise<unknown>;
  hide(): Promise<unknown>;
  loadPosition(): Promise<ToolbarPosition | null>;
  savePosition(pos: ToolbarPosition): Promise<unknown>;
  /** Keeps the service worker awake while recording (like the panel's ping), and resyncs the state. */
  ping(): Promise<ToolbarState | null>;
  /** The Start frame's URL where Start must be an extension frame (Firefox), else null. */
  frameUrl: string | null;
  /** The viewport control's requests (plan E6). */
  viewport?: ViewportActions;
  /** Clear all (E9): empties this page's overlay at once. */
  clearAll(): void;
  /** The theme button: Auto → Light → Dark → Auto (plan E8). */
  cycleTheme(): Promise<unknown>;
  /** The toolbar moved (dragged, collapsed, placed at its saved spot): the page behind it may differ. */
  moved?(): void;
}

/** The Start frame posts this once it can take clicks; without it (a page's CSP refused the frame) Start is a button. */
export const FRAME_READY = 'var-toolbar-start-ready';
export const FRAME_ERROR = 'var-toolbar-start-error';
/** The frame posts this with `on` from the Start click until it stops recording the Session's video (or never started). */
export const FRAME_RECORDING = 'var-toolbar-frame-recording';
/** How long Start may wait for the service worker before the button comes back with an error. */
export const START_TIMEOUT_MS = 20_000;
export const START_TIMEOUT_MESSAGE = 'Start is taking too long. Try again.';
