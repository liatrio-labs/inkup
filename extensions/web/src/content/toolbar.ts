// The page's floating toolbar (CONTEXT.md Toolbar; plan E1): the main control surface on every browser. It sits in
// the same shadow root as the drawing canvas, above it, and renders only what the service worker pushes
// (ToolbarState); its one state of its own is where it sits, saved in storage.local for every page.
//
// - While recording: the timer with a recording dot, then the page tools (Draw, Object Select, Select Text, Snap and
//   the viewport control), then the Session's controls (Pause/Resume, Stop), Open panel and a host dot while paired.
// - Draw, Object Select and Select Text (E7) are the Session's modes, one at a time (background/modes.ts): the buttons
//   ask the service worker and show the state it pushes (aria-pressed). The viewport control (E6) fills its slot
//   where the page can be resized (./viewport-control.ts).
// - Mute (a mic icon, struck through while muted; Alt+Shift+M) and Cancel (red: stop and discard) sit with Pause and
//   Stop (E10). After a Cancel the toast strip says "Session discarded" with Undo until the deadline.
// - A Session without voice (E11) shows "No mic" and "Turn on voice" where Mute would be.
// - Clear all (E9, eraser, Alt+Shift+C) empties the page's overlay, recording or not.
// - Drag it by its grip; it stays on screen and collapses to a pill. The toast strip under it shows the latest
//   caption or Draft Item.
// - Light or dark (E8): `data-theme` follows the page behind it (./theme.ts), or the theme button's fixed setting.
// - It is never in a screenshot: the service worker hides it for the capture frame (`hideForCapture`). The canvas is
//   a sibling, so the ink stays. Snapshots and click capture skip it because it is inside the overlay host.
// - Firefox's Start is an extension frame (`frameUrl`): its click opens the screen picker there and the frame records
//   the video (docs/spikes/toolbar-start.md). The frame must outlive the Start, so it is created once and kept.
import { formatElapsed } from '@inkup/core/clock';
import type { Theme, ThemeSetting } from '@inkup/core/contrast';
import { activeElapsed } from '@inkup/core/media-time';
import type { StartResult, ToolbarState } from '@/messaging';
import type { SelectMode, ToolbarPosition } from '@/settings';
import { nextPaint } from './paint';
import type { ThemeSource } from './theme';
import { clampPosition, defaultPosition, type Pos } from './toolbar-position';
import { VIEWPORT_CSS, type ViewportActions, ViewportControl } from './viewport-control';

export interface ToolbarActions {
  start(): Promise<StartResult>;
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

/** The frame posts this once it can take clicks; without it (a page's CSP refused the frame) Start is a button. */
export const FRAME_READY = 'var-toolbar-start-ready';
export const FRAME_ERROR = 'var-toolbar-start-error';
/** The frame posts this with `on` from the Start click until it stops recording the Session's video (or never started). */
export const FRAME_RECORDING = 'var-toolbar-frame-recording';
const FRAME_TIMEOUT_MS = 4000;
/** How long Start may wait for the service worker before the button comes back with an error. */
export const START_TIMEOUT_MS = 20_000;
export const START_TIMEOUT_MESSAGE = 'Start is taking too long. Try again.';
const PING_MS = 20_000;

const CSS = `
.var-tb, .var-pill, .var-toast { all: initial; position: fixed; z-index: 1; pointer-events: auto; box-sizing: border-box;
  font: 500 12px/1.2 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; color: #f4f4f5; }
.var-tb { display: flex; align-items: center; gap: 4px; padding: 4px 6px; border-radius: 10px; background: #18181b;
  box-shadow: 0 4px 16px rgba(0,0,0,.28), 0 0 0 1px rgba(255,255,255,.08); user-select: none; white-space: nowrap; }
.var-tb button, .var-pill { all: unset; box-sizing: border-box; cursor: pointer; padding: 5px 8px; border-radius: 6px; color: #f4f4f5;
  font: inherit; line-height: 1.2; }
.var-tb button:hover, .var-pill:hover { background: #3f3f46; }
.var-tb button:focus-visible, .var-pill:focus-visible { outline: 2px solid #60a5fa; outline-offset: 1px; }
.var-tb button[disabled] { opacity: .45; cursor: default; background: none; }
.var-tb button[aria-pressed="true"] { background: #dc2626; }
.var-tb button.var-primary { background: #dc2626; }
.var-tb button.var-primary:hover { background: #b91c1c; }
.var-tb button.var-danger { color: #fca5a5; }
.var-tb button.var-danger:hover { background: #7f1d1d; color: #fff; }
.var-tb button.var-icon[data-action="mute"][aria-pressed="true"] { background: #3f3f46; color: #fca5a5; }
.var-toast button { all: unset; cursor: pointer; margin-left: 8px; font-weight: 600; color: #93c5fd; text-decoration: underline; }
.var-toast button:focus-visible { outline: 2px solid #60a5fa; outline-offset: 1px; }
.var-tb [hidden], .var-tb[hidden], .var-pill[hidden], .var-toast[hidden] { display: none !important; }
.var-main { display: contents; }
.var-grip { cursor: grab; padding: 4px 2px; color: #a1a1aa; font-size: 14px; letter-spacing: -2px; touch-action: none; }
.var-grip:active { cursor: grabbing; }
.var-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #71717a; flex: none; }
.var-dot.var-rec { background: #ef4444; animation: var-blink 1.2s steps(2, start) infinite; }
.var-dot.var-paused { background: #f59e0b; animation: none; }
.var-dot.var-on { background: #22c55e; }
@keyframes var-blink { to { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .var-dot.var-rec { animation: none; } }
.var-timer { font-variant-numeric: tabular-nums; min-width: 38px; padding: 0 2px; }
.var-sep { width: 1px; align-self: stretch; margin: 2px 2px; background: #3f3f46; }
.var-muted { color: #a1a1aa; padding: 0 4px; }
.var-tb button.var-icon { display: inline-flex; align-items: center; padding: 5px 6px; }
.var-tb button.var-icon svg { width: 14px; height: 14px; display: block; }
.var-frame { border: 0; width: 58px; height: 26px; background: transparent; color-scheme: normal; }
.var-frame.var-parked { width: 0; height: 0; position: absolute; }
.var-pill { display: flex; align-items: center; gap: 6px; background: #18181b; border-radius: 999px; padding: 6px 10px;
  box-shadow: 0 4px 16px rgba(0,0,0,.28), 0 0 0 1px rgba(255,255,255,.08); }
.var-toast { max-width: 320px; padding: 6px 10px; border-radius: 8px; background: rgba(24,24,27,.92); color: #f4f4f5;
  white-space: normal; line-height: 1.35; }
.var-toast[data-kind="draft"]::before { content: 'Draft · '; color: #fca5a5; }
.var-toast.var-error { background: #7f1d1d; }
@media (max-width: 480px) { .var-tb { flex-wrap: wrap; max-width: calc(100vw - 16px); } }
/* The light theme, over dark pages (plan E8). */
.var-tb[data-theme="light"], .var-pill[data-theme="light"] { background: #fafafa; color: #18181b;
  box-shadow: 0 4px 16px rgba(0,0,0,.35), 0 0 0 1px rgba(0,0,0,.12); }
.var-tb[data-theme="light"] button, .var-pill[data-theme="light"] { color: #18181b; }
.var-tb[data-theme="light"] button:hover, .var-pill[data-theme="light"]:hover { background: #e4e4e7; }
.var-tb[data-theme="light"] button:focus-visible, .var-pill[data-theme="light"]:focus-visible { outline-color: #2563eb; }
.var-tb[data-theme="light"] button[aria-pressed="true"], .var-tb[data-theme="light"] button.var-primary { background: #dc2626; color: #fff; }
.var-tb[data-theme="light"] button.var-primary:hover { background: #b91c1c; }
.var-tb[data-theme="light"] .var-grip, .var-tb[data-theme="light"] .var-muted { color: #52525b; }
.var-tb[data-theme="light"] .var-sep { background: #d4d4d8; }
.var-toast[data-theme="light"] { background: rgba(250,250,250,.95); color: #18181b; box-shadow: 0 0 0 1px rgba(0,0,0,.12); }
.var-toast[data-theme="light"][data-kind="draft"]::before { color: #b91c1c; }
.var-toast[data-theme="light"].var-error { background: #fee2e2; color: #7f1d1d; }
.var-tb[data-theme="light"] button.var-danger { color: #b91c1c; }
.var-tb[data-theme="light"] button.var-danger:hover { background: #fee2e2; color: #7f1d1d; }
.var-tb[data-theme="light"] button.var-icon[data-action="mute"][aria-pressed="true"] { background: #e4e4e7; color: #b91c1c; }
.var-toast[data-theme="light"] button { color: #1d4ed8; }
${VIEWPORT_CSS}`;

type El = HTMLElement;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children);
  return el;
}

/**
 * Makes `parent`'s children `next`, reusing each existing node that `next` has one of the same kind for (tag, action
 * and test id), in place: its attributes and children are patched, not replaced. A click is lost when the element
 * pressed is replaced before the button is released (Chrome drops it; Firefox fires it on the parent), and the toolbar
 * re-renders on every state push, so a click right after one landed on nothing (#16). Nodes passed in that are
 * already children (the viewport slot) are kept as they are.
 */
export function patchChildren(parent: Node, next: (Node | string)[]): void {
  const nodes = next.filter((n) => n !== '').map((n) => (typeof n === 'string' ? document.createTextNode(n) : n));
  const kind = (n: Node) =>
    n instanceof Element
      ? `${n.namespaceURI} ${n.tagName} ${n.getAttribute('data-action') ?? ''} ${n.getAttribute('data-testid') ?? ''}`
      : `#${n.nodeType}`;
  const pool = [...parent.childNodes].filter((n) => !nodes.includes(n as ChildNode));
  const placed = nodes.map((n) => {
    if (n.parentNode === parent) return n;
    const i = pool.findIndex((o) => kind(o) === kind(n));
    if (i < 0) return n;
    const [old] = pool.splice(i, 1);
    if (old instanceof Element && n instanceof Element) {
      for (const a of [...old.attributes]) if (!n.hasAttribute(a.name)) old.removeAttribute(a.name);
      for (const a of [...n.attributes]) if (old.getAttribute(a.name) !== a.value) old.setAttribute(a.name, a.value);
      patchChildren(old, [...n.childNodes]);
    } else if (old!.nodeValue !== n.nodeValue) old!.nodeValue = n.nodeValue;
    return old!;
  });
  for (const n of pool) n.parentNode?.removeChild(n);
  placed.forEach((n, i) => {
    if (parent.childNodes[i] !== n) parent.insertBefore(n, parent.childNodes[i] ?? null);
  });
}

const SVG = 'http://www.w3.org/2000/svg';

/** A stroked 24×24 icon from path data. Built as nodes: some pages' Trusted Types refuse innerHTML. */
function icon(d: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }))
    svg.setAttribute(k, v);
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

/** Mute's icon: a microphone, struck through while muted. */
function micIcon(muted: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'aria-hidden': 'true',
  }))
    svg.setAttribute(k, v);
  for (const d of [
    'M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z',
    'M5 11a7 7 0 0 0 14 0M12 18v3',
    ...(muted ? ['M3 3l18 18'] : []),
  ]) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** Select Text's icon: a text caret (I-beam). */
const caretIcon = () => icon('M8 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H8M16 4h-3a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3M9 12h6');
/** Clear all's icon: an eraser. */
const eraserIcon = () =>
  icon('M20 20H9l-5-5a1.5 1.5 0 0 1 0-2.1L13.9 3a1.5 1.5 0 0 1 2.1 0l5 5a1.5 1.5 0 0 1 0 2.1L12 19M8.5 8.5l7 7');

export class FloatingToolbar {
  private readonly style: HTMLStyleElement;
  private readonly bar: El;
  /** What render() rebuilds; the grip and the frame slot before it are built once. */
  private readonly main: El;
  private readonly frameSlot: El;
  /** The viewport control's slot: built once, so an open menu survives a re-render. */
  private readonly viewportSlot: El;
  private readonly viewportCtl: ViewportControl | null;
  private readonly pill: El;
  private readonly toastEl: El;
  private state: ToolbarState;
  private pos: Pos | null = null;
  private collapsed = false;
  private busy = false;
  /** Counts Starts, so an answer that comes after its timeout is ignored. */
  private startAttempt = 0;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private localNotice: string | null = null;
  private tick: ReturnType<typeof setInterval> | undefined;
  /** Hides the discard toast at its deadline, should no newer state arrive first. */
  private discardTimer: ReturnType<typeof setTimeout> | undefined;
  private ping: ReturnType<typeof setInterval> | undefined;
  private frame: HTMLIFrameElement | null = null;
  /** null while the frame is loading; false when it never said it was ready (Start falls back to a button). */
  private frameReady: boolean | null = null;
  private frameRecording = false;
  private themeSetting: ThemeSetting = 'auto';
  private frameTimer: ReturnType<typeof setTimeout> | undefined;
  private drag: { id: number; dx: number; dy: number } | null = null;
  private removed = false;
  private placeLater = 0;

  constructor(
    private readonly container: El,
    state: ToolbarState,
    private readonly actions: ToolbarActions,
  ) {
    this.state = state;
    this.style = h('style');
    this.style.textContent = CSS;
    this.bar = h('div', { class: 'var-tb', role: 'toolbar', 'aria-label': 'InkUp', 'data-testid': 'toolbar' });
    this.frameSlot = h('span', { class: 'var-main' });
    this.viewportSlot = h('span', { class: 'var-main', 'data-slot': 'viewport' });
    this.main = h('span', { class: 'var-main' });
    this.bar.append(
      h(
        'span',
        {
          class: 'var-grip',
          'data-grip': true,
          'data-testid': 'toolbar-grip',
          title: 'Drag to move',
          'aria-hidden': 'true',
        },
        '⋮⋮',
      ),
      this.frameSlot,
      this.main,
    );
    this.pill = h('button', {
      class: 'var-pill',
      'data-testid': 'toolbar-pill',
      'aria-label': 'Expand the review toolbar',
      hidden: true,
    });
    this.toastEl = h('div', {
      class: 'var-toast',
      'data-testid': 'toolbar-toast',
      role: 'status',
      'aria-live': 'polite',
      hidden: true,
    });
    container.append(this.style, this.bar, this.pill, this.toastEl);
    this.viewportCtl = actions.viewport ? new ViewportControl(container, actions.viewport, (m) => this.fail(m)) : null;
    if (this.viewportCtl) this.viewportSlot.append(this.viewportCtl.button);
    this.bar.addEventListener('click', this.onClick);
    this.bar.addEventListener('pointerdown', this.onGripDown);
    this.bar.addEventListener('pointermove', this.onGripMove);
    this.bar.addEventListener('pointerup', this.onGripUp);
    this.bar.addEventListener('pointercancel', this.onGripUp);
    this.pill.addEventListener('click', () => this.setCollapsed(false));
    this.toastEl.addEventListener('click', this.onToastClick);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('message', this.onFrameMessage);
    this.render();
    void actions.loadPosition().then((saved) => {
      if (this.removed) return;
      if (saved) {
        this.collapsed = saved.collapsed;
        this.pos = { x: saved.x, y: saved.y };
      }
      this.render();
      this.actions.moved?.();
    });
  }

  update(state: ToolbarState): void {
    this.state = state;
    if (state.session) this.localNotice = null;
    this.render();
  }

  /** Off screen for a screenshot (resolves once a frame without it has been painted), or back. */
  async hideForCapture(hidden: boolean): Promise<void> {
    for (const el of [this.bar, this.pill, this.toastEl]) el.style.visibility = hidden ? 'hidden' : '';
    this.viewportCtl?.hideForCapture(hidden);
    this.container.toggleAttribute('data-capturing', hidden);
    if (hidden) await nextPaint();
  }

  /** The Start frame may be recording the Session's video: the overlay host must not move (it would reload it). */
  holdsRecordingFrame(): boolean {
    return !!this.frame && this.frameRecording;
  }

  /** The page behind decided `theme` (or the reviewer's setting did): the bar, the pill and the toast follow. */
  setTheme(theme: Theme, from: ThemeSource, setting: ThemeSetting): void {
    for (const el of [this.bar, this.pill, this.toastEl]) el.dataset.theme = theme;
    this.viewportCtl?.setTheme(theme);
    this.bar.dataset.themeFrom = from;
    if (setting !== this.themeSetting) {
      this.themeSetting = setting;
      this.render();
    }
  }

  /** Where the toolbar (or its pill) is on screen. */
  rect(): DOMRect | null {
    const el = this.visible();
    return el.hidden ? null : el.getBoundingClientRect();
  }

  destroy(): void {
    this.removed = true;
    clearInterval(this.tick);
    clearInterval(this.ping);
    clearTimeout(this.frameTimer);
    clearTimeout(this.discardTimer);
    clearTimeout(this.startTimer);
    cancelAnimationFrame(this.placeLater);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('message', this.onFrameMessage);
    this.viewportCtl?.destroy();
    this.style.remove();
    this.bar.remove();
    this.pill.remove();
    this.toastEl.remove();
  }

  // ---- rendering ----

  private render(): void {
    const s = this.state;
    const session = s.session;
    const here = session?.here ?? false;
    const paused = session?.paused_t !== null && session?.paused_t !== undefined;
    const starting = !!session?.starting;
    this.bar.dataset.state = !session
      ? 'idle'
      : session.stopping
        ? 'stopping'
        : starting
          ? 'starting'
          : !here
            ? 'elsewhere'
            : paused
              ? 'paused'
              : 'recording';

    // Built afresh, then patched into place (patchChildren): a button replaced between a press and its release loses the click.
    const main: (Node | string)[] = [];
    const busy = !!session && (session.stopping || starting);
    const noTools = !session || busy || paused || !session.can_draw;
    const b = (action: string, label: string | Node, attrs: Record<string, string | boolean | undefined> = {}) =>
      h('button', { type: 'button', 'data-action': action, 'data-testid': `toolbar-${action}`, ...attrs }, label);

    // The Start frame is created once and never leaves the document: moving or removing an iframe reloads it, and
    // after Start it records the Session's video. Otherwise it is parked at zero size.
    const frameStart = !session && s.start.ok && this.usesFrame();
    if (frameStart && !this.frame) this.frameSlot.append(this.startFrame());
    this.frame?.classList.toggle('var-parked', !frameStart);

    if (!session) {
      if (!s.start.ok) main.push(h('span', { class: 'var-muted' }, s.start.reason), b('setup', 'Finish setup'));
      else if (!frameStart)
        main.push(b('start', this.busy ? 'Starting…' : 'Start', { class: 'var-primary', disabled: this.busy }));
    } else if (!here) {
      main.push(
        h('span', { class: 'var-dot var-rec', 'aria-hidden': 'true' }),
        h('span', { class: 'var-muted' }, 'Recording another tab'),
        b('stop', 'Stop', { disabled: busy }),
      );
    } else {
      main.push(
        h('span', {
          class: `var-dot ${paused ? 'var-paused' : 'var-rec'}`,
          'data-testid': 'toolbar-dot',
          title: starting ? 'Starting' : paused ? 'Paused' : 'Recording',
        }),
        starting
          ? h('span', { class: 'var-muted', 'data-testid': 'toolbar-starting' }, 'Starting…')
          : h(
              'span',
              { class: 'var-timer', 'data-testid': 'toolbar-timer', 'aria-label': 'Elapsed time' },
              this.elapsedText(),
            ),
        session.video === 'recording'
          ? ''
          : h(
              'span',
              {
                class: 'var-muted',
                'data-testid': 'toolbar-no-video',
                title:
                  'Audio, Strokes and screenshots are recorded. For video, start from the panel, where you pick what to record.',
              },
              session.video === 'ended' ? 'Video ended' : 'No video',
            ),
        b('draw', 'Draw', {
          'aria-pressed': String(session.draw_mode),
          disabled: noTools,
          title: 'Draw (Alt+Shift+D) · Esc: off',
        }),
        b('object-select', 'Object Select', {
          'aria-pressed': String(session.select_mode === 'object'),
          disabled: noTools,
          title:
            'Object Select (Alt+Shift+O): pick an element (↑ parent, ↓ back, ⏎ or click to pick), then type or say what should change · Esc: off',
        }),
        b('select-text', caretIcon(), {
          class: 'var-icon',
          'aria-label': 'Select Text',
          'aria-pressed': String(session.select_mode === 'text'),
          disabled: noTools,
          title: 'Select Text (Alt+Shift+T): select text to comment on it · Esc: off',
        }),
        b('snap', 'Snap', { disabled: busy || paused, title: 'Alt+Shift+S' }),
        this.viewportSlot,
        h('span', { class: 'var-sep', 'aria-hidden': 'true' }),
        ...(session.voice
          ? [
              b('mute', micIcon(session.muted), {
                class: 'var-icon',
                'aria-label': session.muted ? 'Unmute the microphone' : 'Mute the microphone',
                'aria-pressed': String(session.muted),
                disabled: busy,
                title: session.muted
                  ? 'Microphone off: nothing you say is recorded (Alt+Shift+M to turn it on)'
                  : 'Mute the microphone (Alt+Shift+M)',
              }),
            ]
          : [
              h(
                'span',
                {
                  class: 'var-muted',
                  'data-testid': 'toolbar-no-mic',
                  title: 'Recording without voice: ink, picks, typed comments and screenshots',
                },
                'No mic',
              ),
              b('voice-on', 'Turn on voice', {
                disabled: busy,
                title: 'Record your voice from now on (asks for the microphone if needed)',
              }),
            ]),
        paused ? b('resume', 'Resume', { disabled: busy }) : b('pause', 'Pause', { disabled: busy }),
        b('stop', session.stopping ? 'Finishing…' : 'Stop', { disabled: busy }),
        b('cancel', 'Cancel', {
          class: 'var-danger',
          disabled: busy,
          title: 'Stop and discard this Session (Undo for a few seconds)',
        }),
      );
    }
    // While recording here the viewport control sits with the page tools; otherwise it comes last before the panel.
    if (!session || !here) main.push(this.viewportSlot);
    // Clear all (E9): on every page, recording or not.
    main.push(
      b('clear', eraserIcon(), {
        class: 'var-icon',
        'aria-label': 'Clear all',
        title: 'Clear all (Alt+Shift+C): remove the ink, outlines and open comment boxes from this page',
      }),
    );
    main.push(
      h('span', { class: 'var-sep', 'aria-hidden': 'true' }),
      b('panel', 'Panel', { title: 'Open the panel (Alt+Shift+P)' }),
    );
    if (s.host) {
      const label = `${s.host === 'connected' ? 'Host connected' : 'Host offline, will sync'}${s.hostNetwork ? ' · Unencrypted network hub' : ''}`;
      main.push(
        h('span', {
          class: `var-dot ${s.host === 'connected' ? 'var-on' : ''}`,
          'data-testid': 'toolbar-host',
          'data-state': s.host,
          'data-network': String(s.hostNetwork),
          title: label,
          role: 'img',
          'aria-label': label,
        }),
      );
    }
    const themeLabel = { auto: 'Theme: Auto (follows the page)', light: 'Theme: Light', dark: 'Theme: Dark' }[
      this.themeSetting
    ];
    main.push(
      b('theme', { auto: '◐', light: '○', dark: '●' }[this.themeSetting], {
        'data-setting': this.themeSetting,
        'aria-label': themeLabel,
        title: themeLabel,
      }),
    );
    main.push(b('collapse', '–', { 'aria-label': 'Collapse the toolbar', title: 'Collapse' }));
    if (!session)
      main.push(b('close', '×', { 'aria-label': 'Hide the toolbar', title: 'Hide (the toolbar icon brings it back)' }));
    patchChildren(this.main, main);

    patchChildren(this.pill, [
      h('span', { class: `var-dot ${session ? (paused ? 'var-paused' : 'var-rec') : ''}`, 'aria-hidden': 'true' }),
      h('span', { class: 'var-timer' }, session ? (starting ? 'Starting…' : this.elapsedText()) : 'Review'),
    ]);

    const notice = this.localNotice ?? s.notice;
    const discard = s.discard && s.discard.deadline > Date.now() ? s.discard : null;
    const toast = notice
      ? { kind: 'error', text: notice }
      : discard
        ? { kind: 'discard', text: 'Session discarded' }
        : s.toast;
    this.toastEl.hidden = !toast;
    this.toastEl.dataset.kind = toast?.kind ?? '';
    this.toastEl.classList.toggle('var-error', !!notice);
    const undo =
      discard && !notice
        ? [
            ' · ',
            h(
              'button',
              { type: 'button', 'data-testid': 'toolbar-undo-discard', 'data-session': discard.session_id },
              'Undo',
            ),
          ]
        : [];
    patchChildren(this.toastEl, [toast?.text ?? '', ...undo]);
    clearTimeout(this.discardTimer);
    if (discard && undo.length) {
      this.discardTimer = setTimeout(() => this.render(), discard.deadline - Date.now() + 20);
    }

    this.viewportSlot.hidden = !s.viewport || !this.viewportCtl;
    this.viewportCtl?.update(s.viewport);
    this.bar.hidden = this.collapsed;
    this.pill.hidden = !this.collapsed;
    this.place();
    this.timers(!!session && here);
  }

  private elapsedText(): string {
    const s = this.state.session;
    if (!s || s.starting) return '00:00';
    return formatElapsed(activeElapsed(Date.now() - s.t0, { paused_ms: s.paused_ms, since: s.paused_t }));
  }

  private timers(recording: boolean): void {
    if (recording && !this.tick) {
      this.tick = setInterval(() => {
        for (const el of this.container.querySelectorAll<El>('.var-timer'))
          if (el.closest('.var-tb, .var-pill') && this.state.session) el.textContent = this.elapsedText();
      }, 500);
      this.ping = setInterval(() => void this.actions.ping().catch(() => {}), PING_MS);
    } else if (!recording && this.tick) {
      clearInterval(this.tick);
      clearInterval(this.ping);
      this.tick = undefined;
      this.ping = undefined;
    }
  }

  // ---- position ----

  private visible(): El {
    return this.collapsed ? this.pill : this.bar;
  }

  private viewport = () => ({
    width: document.documentElement.clientWidth || window.innerWidth,
    height: window.innerHeight,
  });

  private place(): void {
    const el = this.visible();
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    // Not laid out (the host is between leaving and re-entering the top layer, content/top-layer.ts): a size of 0 would
    // put the bar's left edge at the right margin and the rest of it off screen. Placed on the next frame instead.
    if (!size.width && !el.hidden) {
      if (!this.placeLater && !this.removed)
        this.placeLater = requestAnimationFrame(() => {
          this.placeLater = 0;
          this.place();
        });
      return;
    }
    const at = this.pos ? clampPosition(this.pos, size, this.viewport()) : defaultPosition(size, this.viewport());
    for (const x of [this.bar, this.pill]) Object.assign(x.style, { left: `${at.x}px`, top: `${at.y}px` });
    // The toast sits under the toolbar, or above it near the bottom edge.
    const below = at.y + size.height + 6;
    const t = this.toastEl;
    t.style.left = `${at.x}px`;
    if (below + 60 < this.viewport().height) Object.assign(t.style, { top: `${below}px`, bottom: '' });
    else Object.assign(t.style, { top: '', bottom: `${this.viewport().height - at.y + 6}px` });
  }

  private onResize = () => this.place();

  private save(): void {
    if (!this.pos) return;
    void this.actions.savePosition({ ...this.pos, collapsed: this.collapsed }).catch(() => {});
  }

  private setCollapsed(on: boolean): void {
    const from = this.visible().getBoundingClientRect();
    this.collapsed = on;
    this.pos = { x: from.left, y: from.top };
    this.render();
    this.save();
    this.actions.moved?.();
  }

  private onGripDown = (e: PointerEvent) => {
    if (e.button !== 0 || !(e.target as Element | null)?.closest?.('[data-grip]')) return;
    e.preventDefault();
    const r = this.bar.getBoundingClientRect();
    this.drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
    this.bar.setPointerCapture?.(e.pointerId);
  };

  private onGripMove = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const size = { width: this.bar.offsetWidth, height: this.bar.offsetHeight };
    this.pos = clampPosition({ x: e.clientX - this.drag.dx, y: e.clientY - this.drag.dy }, size, this.viewport());
    this.place();
  };

  private onGripUp = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.drag = null;
    this.save();
    this.actions.moved?.();
  };

  // ---- actions ----

  private onClick = (e: MouseEvent) => {
    const action = (e.target as Element | null)?.closest?.('[data-action]')?.getAttribute('data-action');
    if (!action) return;
    const s = this.state.session;
    const run = (p: Promise<unknown>) => void p.catch((err: unknown) => this.fail(String(err)));
    // The page modes take the keyboard (Object Select's ↑, ↓ and ⏎; Esc): it goes back to the page, not this button.
    if (action === 'draw' || action === 'object-select' || action === 'select-text')
      (e.target as Element).closest<HTMLElement>('button')?.blur();
    switch (action) {
      case 'start':
        return this.start();
      case 'pause':
        return run(this.actions.pause());
      case 'resume':
        return run(this.actions.resume());
      case 'stop':
        return run(this.actions.stop());
      case 'cancel':
        return run(this.actions.cancel());
      case 'mute':
        return run(this.actions.setMuted(!s?.muted));
      case 'voice-on':
        return run(this.actions.turnOnVoice());
      case 'draw':
        return run(this.actions.setDraw(!s?.draw_mode));
      case 'snap':
        return run(this.actions.snap());
      case 'object-select':
        return run(this.actions.setSelect(s?.select_mode === 'object' ? null : 'object'));
      case 'select-text':
        return run(this.actions.setSelect(s?.select_mode === 'text' ? null : 'text'));
      case 'clear':
        return this.actions.clearAll();
      case 'panel':
        return run(this.actions.open('panel'));
      case 'setup':
        return run(this.actions.open('setup'));
      case 'theme':
        return run(this.actions.cycleTheme());
      case 'collapse':
        return this.setCollapsed(true);
      case 'close':
        return run(this.actions.hide());
    }
  };

  private onToastClick = (e: MouseEvent) => {
    const id = (e.target as Element | null)
      ?.closest?.('[data-testid="toolbar-undo-discard"]')
      ?.getAttribute('data-session');
    if (id) void this.actions.undoDiscard(id).catch((err: unknown) => this.fail(String(err)));
  };

  private start(): void {
    if (this.busy) return;
    this.busy = true;
    this.localNotice = null;
    this.render();
    const attempt = ++this.startAttempt;
    const settle = (notice: string | null) => {
      // A Start that answers after the timeout has nothing left to say: the Session's own state shows what came of it.
      if (attempt !== this.startAttempt) return;
      this.startAttempt++;
      clearTimeout(this.startTimer);
      if (notice) this.localNotice = notice;
      this.busy = false;
      this.render();
    };
    // A service worker too busy to answer never leaves Start disabled (F1).
    this.startTimer = setTimeout(() => settle(START_TIMEOUT_MESSAGE), START_TIMEOUT_MS);
    void this.actions.start().then(
      (r) => settle(r.ok ? null : r.error),
      (e: unknown) => settle(String(e)),
    );
  }

  private fail(message: string): void {
    this.localNotice = message;
    this.render();
  }

  // ---- the Start frame (Firefox) ----

  private usesFrame(): boolean {
    return (
      this.state.start.ok &&
      this.state.start.video === 'frame_picker' &&
      !!this.actions.frameUrl &&
      this.frameReady !== false
    );
  }

  private startFrame(): HTMLIFrameElement {
    const f = h('iframe', {
      class: 'var-frame',
      'data-testid': 'toolbar-start-frame',
      title: 'Start a review Session',
      allow: 'display-capture',
    });
    f.src = this.actions.frameUrl!;
    this.frame = f;
    this.frameTimer = setTimeout(() => {
      if (this.frameReady) return;
      // The page refused our frame (its CSP): Start without video instead.
      this.frameReady = false;
      this.frame?.remove();
      this.frame = null;
      this.render();
    }, FRAME_TIMEOUT_MS);
    return f;
  }

  private onFrameMessage = (e: MessageEvent) => {
    // By origin, not `e.source === frame.contentWindow`: in a Firefox content script the two are different wrappers of
    // the same window, so the frame never counted as ready and was dropped for a plain button after FRAME_TIMEOUT_MS.
    if (!this.frame || !this.actions.frameUrl || e.origin !== new URL(this.actions.frameUrl).origin) return;
    const data = e.data as { type?: string; error?: string; on?: boolean } | null;
    if (data?.type === FRAME_RECORDING) {
      this.frameRecording = !!data.on;
      this.frame.dataset.recording = String(this.frameRecording);
    } else if (data?.type === FRAME_READY) {
      this.frameReady = true;
      this.frame.dataset.ready = 'true';
      clearTimeout(this.frameTimer);
    } else if (data?.type === FRAME_ERROR && data.error) this.fail(data.error);
  };
}
