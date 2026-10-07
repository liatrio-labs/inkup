// The page's floating toolbar (CONTEXT.md Toolbar; plan E1; ADR 0011): the main control surface on every browser. It
// sits in the overlay's shadow root beside the drawing canvas, above it, and renders only the ToolbarState it is given;
// its one state of its own is where it sits, saved through ToolbarActions.loadPosition/savePosition.
//
// - While recording: the timer with a recording dot, then the page tools (Draw, Object Select, Select Text, Snap and
//   the viewport control), then the Session's controls (Mute, Pause/Resume, Stop, Cancel), Clear all, Panel, the host
//   dot while paired, the theme button and Collapse.
// - Draw, Object Select and Select Text (E7) are the Session's modes, one at a time: the buttons ask and show the state
//   pushed back (aria-pressed). The viewport control (E6) fills its slot where the page can be resized.
// - A Session without voice (E11) shows "No mic" and "Turn on voice" where Mute would be. After a Cancel the toast strip
//   says "Session discarded" with Undo until the deadline (E10).
// - Drag it by its grip; it stays on screen and collapses to a pill. The toast strip under it shows the latest caption
//   or Draft Item, or the last error.
// - Light or dark (E8): the caller decides (the extension's content/theme.ts) and calls the handle's setTheme; the
//   colours are the package tokens, which follow `data-theme` on the shadow host.
// - It is never in a screenshot (ADR 0013): the caller hides it for the capture frame through the handle's
//   hideForCapture, which resolves once a frame without it has been painted.
// - Firefox's Start is an extension frame (`frameUrl`): its click opens the screen picker there and the frame records
//   the video (docs/spikes/toolbar-start.md). The frame must outlive the Start, so it is created once and kept.
// - Every control has a stable key, so a state push re-renders it in place: a button replaced between press and
//   release loses the click (ADR 0011, F1).
import { formatElapsed } from '@inkup/core/clock';
import { activeElapsed } from '@inkup/core/media-time';
import {
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { cn } from '../lib/utils';
import {
  FRAME_ERROR,
  FRAME_READY,
  FRAME_RECORDING,
  FRAME_THEME,
  START_TIMEOUT_MESSAGE,
  START_TIMEOUT_MS,
  type ToolbarActions,
  type ToolbarState,
  type ToolbarTheme,
  type ToolbarThemeSetting,
  type ToolbarThemeSource,
} from '../toolbar-state';
import { nextPaint } from './paint';
import { clampPosition, defaultPosition, type Pos } from './position';
import { ViewportControl } from './viewport-control';

/** What the capture surface does to the toolbar directly, outside the pushed state. */
export interface ToolbarHandle {
  /** Off screen for a screenshot (resolves once a frame without it has been painted), or back. */
  hideForCapture(hidden: boolean): Promise<void>;
  /** The Start frame may be recording the Session's video: the overlay host must not move (it would reload it). */
  holdsRecordingFrame(): boolean;
  /** The page behind decided `theme` (or the reviewer's setting did): the bar, the pill and the toast follow. */
  setTheme(theme: ToolbarTheme, from: ToolbarThemeSource, setting: ToolbarThemeSetting): void;
  /** Where the toolbar (or its pill) is on screen; null while hidden. */
  rect(): DOMRect | null;
}

export interface ToolbarProps {
  state: ToolbarState;
  actions: ToolbarActions;
  ref?: Ref<ToolbarHandle>;
}

const FRAME_TIMEOUT_MS = 4000;
const PING_MS = 20_000;
const TICK_MS = 500;

// DESIGN.md on the package tokens: paper and ink (dark: navy and pale ink, from `data-theme` on the host), hairline
// edges, the Card shadow for a surface floating over the page, medium radius for the bar and small for its buttons.
// A pressed mode is an ink fill; red pen is kept for the recording dot (the reviewer's hand), and Cancel uses
// `destructive`, the package's error text.
const SURFACE =
  'pointer-events-auto fixed z-[1] box-border border border-border bg-background font-sans text-xs leading-tight font-medium text-foreground shadow-[0_1px_2px_rgb(31_42_68/0.08),0_8px_24px_-8px_rgb(31_42_68/0.18)] dark:shadow-[0_1px_2px_rgb(0_0_0/0.3),0_8px_24px_-8px_rgb(0_0_0/0.5)]';
const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-solid focus-visible:outline-ring';
const BUTTON = cn(
  'inline-flex h-7 cursor-pointer items-center gap-1 rounded-sm px-2 leading-none whitespace-nowrap transition-colors duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]',
  'hover:bg-accent disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent',
  'aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-ink-2',
  FOCUS,
);
const ICON = 'w-7 justify-center px-0 [&_svg]:block [&_svg]:size-3.5';
const PRIMARY = 'bg-primary font-semibold text-primary-foreground hover:bg-ink-2';
const DANGER = 'text-destructive hover:bg-destructive/10';
const MUTED = 'px-1 text-muted-foreground';
const SEP = 'mx-0.5 h-4 w-px flex-none bg-border';
const DOT = 'inline-block size-2 flex-none rounded-full';
const TIMER = 'min-w-[2.6rem] px-0.5 font-mono tabular-nums';

/** A stroked 24×24 icon from path data, with `filled` paths in the text colour (DESIGN.md: 24-unit strokes). */
function Icon({ d, filled = [], weight = 2 }: { d: string[]; filled?: string[]; weight?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {d.map((p) => (
        <path key={p} d={p} />
      ))}
      {filled.map((p) => (
        <path key={p} d={p} fill="currentColor" stroke="none" />
      ))}
    </svg>
  );
}

/** Mute's icon: a microphone, struck through while muted. */
const MIC = ['M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z', 'M5 11a7 7 0 0 0 14 0M12 18v3'];
const MIC_OFF = [...MIC, 'M3 3l18 18'];
/** Select Text's icon: a text caret (I-beam). */
const CARET = ['M8 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H8M16 4h-3a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3M9 12h6'];
/** Clear all's icon: an eraser. */
const ERASER = [
  'M20 20H9l-5-5a1.5 1.5 0 0 1 0-2.1L13.9 3a1.5 1.5 0 0 1 2.1 0l5 5a1.5 1.5 0 0 1 0 2.1L12 19M8.5 8.5l7 7',
];

const THEME_LABEL = { auto: 'Theme: Auto (follows the page)', light: 'Theme: Light', dark: 'Theme: Dark' } as const;
/** The theme button's setting, drawn: half filled (follows the page), open (light) and filled (dark). */
const CIRCLE = 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16z';
const THEME_ICON = {
  auto: <Icon d={[CIRCLE]} filled={['M12 4a8 8 0 0 1 0 16z']} />,
  light: <Icon d={[CIRCLE]} />,
  dark: <Icon d={[CIRCLE]} filled={[CIRCLE]} />,
} as const;
/** Collapse, Hide and the grip. */
const COLLAPSE = ['M6 12h12'];
const CLOSE = ['M7 7l10 10M17 7L7 17'];
const GRIP = ['M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01'];

const viewportSize = () => ({
  width: document.documentElement.clientWidth || window.innerWidth,
  height: window.innerHeight,
});

export function Toolbar({ state, actions, ref }: ToolbarProps) {
  const bar = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const toastEl = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  const [collapsed, setCollapsed] = useState(false);
  const collapsedRef = useRef(false);
  collapsedRef.current = collapsed;
  const pos = useRef<Pos | null>(null);
  const drag = useRef<{ id: number; dx: number; dy: number } | null>(null);
  const removed = useRef(false);
  const placeLater = useRef(0);
  /** Calls actions.moved once the toolbar is placed after this render. */
  const movedAfterRender = useRef(false);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  /** Counts Starts, so an answer that comes after its timeout is ignored. */
  const startAttempt = useRef(0);
  const startTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [localNotice, setLocalNotice] = useState<string | null>(null);

  const [theme, setThemeState] = useState<{
    theme?: ToolbarTheme;
    from?: ToolbarThemeSource;
    setting: ToolbarThemeSetting;
  }>({ setting: 'auto' });

  /** The Start frame, once made, stays; null while loading, false once it never said it was ready. */
  const [frameMade, setFrameMade] = useState(false);
  const [frameReady, setFrameReady] = useState<boolean | null>(null);
  const [frameRecording, setFrameRecording] = useState<boolean | null>(null);
  const frameRecordingRef = useRef(false);
  /** The theme the bar wears, for the frame: it cannot see the host's `data-theme`, so it is told. */
  const themeRef = useRef<ToolbarTheme | undefined>(undefined);
  themeRef.current = theme.theme;
  const tellFrameTheme = useCallback((url: string | null) => {
    if (!url) return;
    frame.current?.contentWindow?.postMessage({ type: FRAME_THEME, theme: themeRef.current }, new URL(url).origin);
  }, []);

  const session = state.session;
  const here = session?.here ?? false;
  const paused = session?.paused_t !== null && session?.paused_t !== undefined;
  const starting = !!session?.starting;
  const recordingHere = !!session && here;

  // ---- position ----

  const place = useCallback(() => {
    const el = collapsedRef.current ? pill.current : bar.current;
    const b = bar.current;
    const p = pill.current;
    const t = toastEl.current;
    if (!el || !b || !p || !t) return;
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    // Not laid out (the host is between leaving and re-entering the top layer): a size of 0 would put the bar's left
    // edge at the right margin and the rest of it off screen. Placed on the next frame instead.
    if (!size.width && !el.hidden) {
      if (!placeLater.current && !removed.current)
        placeLater.current = requestAnimationFrame(() => {
          placeLater.current = 0;
          place();
        });
      return;
    }
    const vp = viewportSize();
    const at = pos.current ? clampPosition(pos.current, size, vp) : defaultPosition(size, vp);
    for (const x of [b, p]) Object.assign(x.style, { left: `${at.x}px`, top: `${at.y}px` });
    // The toast sits under the toolbar, or above it near the bottom edge.
    const below = at.y + size.height + 6;
    t.style.left = `${at.x}px`;
    if (below + 60 < vp.height) Object.assign(t.style, { top: `${below}px`, bottom: '' });
    else Object.assign(t.style, { top: '', bottom: `${vp.height - at.y + 6}px` });
  }, []);

  useLayoutEffect(() => {
    place();
    if (movedAfterRender.current) {
      movedAfterRender.current = false;
      actions.moved?.();
    }
  });

  const save = (collapsedNow: boolean) => {
    if (!pos.current) return;
    void actions.savePosition({ ...pos.current, collapsed: collapsedNow }).catch(() => {});
  };

  const collapse = (on: boolean) => {
    const from = (collapsedRef.current ? pill.current : bar.current)?.getBoundingClientRect();
    if (from) pos.current = { x: from.left, y: from.top };
    collapsedRef.current = on;
    movedAfterRender.current = true;
    setCollapsed(on);
    rerender();
    save(on);
  };

  // Mounted: the saved spot (shared by every page), the window's resizes and the Start frame's messages.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per mount, as the DOM toolbar's constructor did.
  useEffect(() => {
    removed.current = false;
    void actions.loadPosition().then((saved) => {
      if (removed.current) return;
      if (saved) {
        collapsedRef.current = saved.collapsed;
        setCollapsed(saved.collapsed);
        pos.current = { x: saved.x, y: saved.y };
      }
      movedAfterRender.current = true;
      rerender();
    });
    window.addEventListener('resize', place);
    return () => {
      removed.current = true;
      window.removeEventListener('resize', place);
      cancelAnimationFrame(placeLater.current);
      placeLater.current = 0;
      clearTimeout(startTimer.current);
    };
  }, []);

  const onGripDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !(e.target as Element).closest?.('[data-grip]')) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    drag.current = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onGripMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const el = e.currentTarget;
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    pos.current = clampPosition({ x: e.clientX - d.dx, y: e.clientY - d.dy }, size, viewportSize());
    place();
  };
  const onGripUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || e.pointerId !== drag.current.id) return;
    drag.current = null;
    save(collapsedRef.current);
    actions.moved?.();
  };

  // ---- timers: the clock, the keep-alive and the discard deadline ----

  useEffect(() => {
    if (!recordingHere) return;
    const tick = setInterval(rerender, TICK_MS);
    const ping = setInterval(() => void actions.ping().catch(() => {}), PING_MS);
    return () => {
      clearInterval(tick);
      clearInterval(ping);
    };
  }, [recordingHere, actions]);

  // A Session's state replaces a local notice (a failed Start).
  useLayoutEffect(() => {
    if (state.session) setLocalNotice(null);
  }, [state]);

  const fail = useCallback((message: string) => setLocalNotice(message), []);

  // ---- the Start frame (Firefox) ----

  const usesFrame =
    state.start.ok && state.start.video === 'frame_picker' && !!actions.frameUrl && frameReady !== false;
  const frameStart = !session && state.start.ok && usesFrame;
  const frameShown = (frameMade || frameStart) && frameReady !== false && !!actions.frameUrl;

  useLayoutEffect(() => {
    if (frameStart && !frameMade) setFrameMade(true);
  }, [frameStart, frameMade]);

  useEffect(() => {
    if (!frameMade) return;
    // The page refused our frame (its CSP): Start without video instead.
    const timer = setTimeout(() => setFrameReady((r) => (r ? r : false)), FRAME_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [frameMade]);

  useEffect(() => {
    const url = actions.frameUrl;
    if (!url) return;
    const origin = new URL(url).origin;
    const onMessage = (e: MessageEvent) => {
      // By origin, not `e.source === frame.contentWindow`: in a Firefox content script the two are different wrappers
      // of the same window, so the frame never counted as ready and was dropped for a plain button.
      if (!frame.current || e.origin !== origin) return;
      const data = e.data as { type?: string; error?: string; on?: boolean } | null;
      if (data?.type === FRAME_RECORDING) {
        frameRecordingRef.current = !!data.on;
        setFrameRecording(!!data.on);
      } else if (data?.type === FRAME_READY) {
        setFrameReady(true);
        tellFrameTheme(url);
      } else if (data?.type === FRAME_ERROR && data.error) fail(data.error);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [actions.frameUrl, fail, tellFrameTheme]);

  // The bar's theme changed (the page behind it, or the reviewer's setting): the frame's Start follows. The frame's
  // ready (above) covers its first load and any reload.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `theme.theme` is the trigger; the value goes by themeRef.
  useEffect(() => tellFrameTheme(actions.frameUrl), [theme.theme, actions.frameUrl, tellFrameTheme]);

  // ---- the handle ----

  useImperativeHandle(
    ref,
    () => ({
      async hideForCapture(hidden: boolean) {
        for (const el of [bar.current, pill.current, toastEl.current])
          if (el) el.style.visibility = hidden ? 'hidden' : '';
        if (hidden) await nextPaint();
      },
      holdsRecordingFrame: () => !!frame.current && frameRecordingRef.current,
      setTheme(next, from, setting) {
        flushSync(() => setThemeState({ theme: next, from, setting }));
      },
      rect() {
        const el = collapsedRef.current ? pill.current : bar.current;
        return !el || el.hidden ? null : el.getBoundingClientRect();
      },
    }),
    [],
  );

  // ---- actions ----

  const run = (p: Promise<unknown>) => void p.catch((err: unknown) => fail(String(err)));

  const start = () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setLocalNotice(null);
    const attempt = ++startAttempt.current;
    const settle = (notice: string | null) => {
      // A Start that answers after the timeout has nothing left to say: the Session's own state shows what came of it.
      if (attempt !== startAttempt.current) return;
      startAttempt.current++;
      clearTimeout(startTimer.current);
      if (notice) setLocalNotice(notice);
      busyRef.current = false;
      setBusy(false);
    };
    // A service worker too busy to answer never leaves Start disabled (F1).
    startTimer.current = setTimeout(() => settle(START_TIMEOUT_MESSAGE), START_TIMEOUT_MS);
    void actions.start().then(
      (r) => settle(r.ok ? null : r.error),
      (e: unknown) => settle(String(e)),
    );
  };

  /** The page modes take the keyboard (Object Select's ↑, ↓ and ⏎; Esc): it goes back to the page, not this button. */
  const mode = (e: MouseEvent<HTMLButtonElement>, p: Promise<unknown>) => {
    e.currentTarget.blur();
    run(p);
  };

  // ---- rendering ----

  const elapsedText = () => {
    if (!session || session.starting) return '00:00';
    return formatElapsed(
      activeElapsed(Date.now() - session.t0, { paused_ms: session.paused_ms, since: session.paused_t }),
    );
  };

  const busySession = !!session && (session.stopping || starting);
  const noTools = !session || busySession || paused || !session.can_draw;
  const b = (
    action: string,
    label: ReactNode,
    onClick: (e: MouseEvent<HTMLButtonElement>) => void,
    props: Record<string, unknown> & { className?: string } = {},
  ) => {
    const { className, ...rest } = props;
    return (
      <button
        key={action}
        type="button"
        data-action={action}
        data-testid={`toolbar-${action}`}
        className={cn(BUTTON, className)}
        onClick={onClick}
        {...rest}
      >
        {label}
      </button>
    );
  };

  const viewportSlot = (
    <span key="viewport" className="contents" data-slot="viewport" hidden={!state.viewport || !actions.viewport}>
      {actions.viewport ? (
        <ViewportControl
          viewport={state.viewport}
          actions={actions.viewport}
          onError={fail}
          theme={theme.theme}
          buttonClassName={BUTTON}
        />
      ) : null}
    </span>
  );

  const main: ReactNode[] = [];
  if (!session) {
    if (!state.start.ok)
      main.push(
        <span key="reason" className={MUTED}>
          {state.start.reason}
        </span>,
        b('setup', 'Finish setup', () => run(actions.open('setup'))),
      );
    else if (!frameStart)
      main.push(b('start', busy ? 'Starting…' : 'Start', start, { className: PRIMARY, disabled: busy }));
  } else if (!here) {
    main.push(
      <span key="elsewhere-dot" className={cn(DOT, 'bg-pen motion-safe:animate-pulse')} aria-hidden="true" />,
      <span key="elsewhere" className={MUTED}>
        Recording another tab
      </span>,
      b('stop', 'Stop', () => run(actions.stop()), { disabled: busySession }),
    );
  } else {
    main.push(
      <span
        key="dot"
        className={cn(DOT, paused ? 'bg-muted-foreground' : 'bg-pen motion-safe:animate-pulse')}
        data-testid="toolbar-dot"
        title={starting ? 'Starting' : paused ? 'Paused' : 'Recording'}
      />,
      starting ? (
        <span key="starting" className={MUTED} data-testid="toolbar-starting">
          Starting…
        </span>
      ) : (
        <span key="timer" role="timer" className={TIMER} data-testid="toolbar-timer" aria-label="Elapsed time">
          {elapsedText()}
        </span>
      ),
      session.video === 'recording' ? null : (
        <span
          key="no-video"
          className={MUTED}
          data-testid="toolbar-no-video"
          title="Audio, Strokes and screenshots are recorded. For video, start from the panel, where you pick what to record."
        >
          {session.video === 'ended' ? 'Video ended' : 'No video'}
        </span>
      ),
      <span key="sep-session" className={SEP} aria-hidden="true" />,
      b('draw', 'Draw', (e) => mode(e, actions.setDraw(!session.draw_mode)), {
        'aria-pressed': String(session.draw_mode),
        disabled: noTools,
        title: 'Draw (Alt+Shift+D) · Esc: off',
      }),
      b(
        'object-select',
        'Object Select',
        (e) => mode(e, actions.setSelect(session.select_mode === 'object' ? null : 'object')),
        {
          'aria-pressed': String(session.select_mode === 'object'),
          disabled: noTools,
          title:
            'Object Select (Alt+Shift+O): pick an element (↑ parent, ↓ back, ⏎ or click to pick), then type or say what should change · Esc: off',
        },
      ),
      b(
        'select-text',
        <Icon d={CARET} />,
        (e) => mode(e, actions.setSelect(session.select_mode === 'text' ? null : 'text')),
        {
          className: ICON,
          'aria-label': 'Select Text',
          'aria-pressed': String(session.select_mode === 'text'),
          disabled: noTools,
          title: 'Select Text (Alt+Shift+T): select text to comment on it · Esc: off',
        },
      ),
      b('snap', 'Snap', () => run(actions.snap()), { disabled: busySession || paused, title: 'Alt+Shift+S' }),
      viewportSlot,
      <span key="sep-controls" className={SEP} aria-hidden="true" />,
      ...(session.voice
        ? [
            b('mute', <Icon d={session.muted ? MIC_OFF : MIC} />, () => run(actions.setMuted(!session.muted)), {
              className: ICON,
              'aria-label': session.muted ? 'Unmute the microphone' : 'Mute the microphone',
              'aria-pressed': String(session.muted),
              disabled: busySession,
              title: session.muted
                ? 'Microphone off: nothing you say is recorded (Alt+Shift+M to turn it on)'
                : 'Mute the microphone (Alt+Shift+M)',
            }),
          ]
        : [
            <span
              key="no-mic"
              className={MUTED}
              data-testid="toolbar-no-mic"
              title="Recording without voice: ink, picks, typed comments and screenshots"
            >
              No mic
            </span>,
            b('voice-on', 'Turn on voice', () => run(actions.turnOnVoice()), {
              disabled: busySession,
              title: 'Record your voice from now on (asks for the microphone if needed)',
            }),
          ]),
      paused
        ? b('resume', 'Resume', () => run(actions.resume()), { disabled: busySession })
        : b('pause', 'Pause', () => run(actions.pause()), { disabled: busySession }),
      b('stop', session.stopping ? 'Finishing…' : 'Stop', () => run(actions.stop()), { disabled: busySession }),
      b('cancel', 'Cancel', () => run(actions.cancel()), {
        className: DANGER,
        disabled: busySession,
        title: 'Stop and discard this Session (Undo for a few seconds)',
      }),
    );
  }
  // While recording here the viewport control sits with the page tools; otherwise it comes last before the panel.
  if (!recordingHere) main.push(viewportSlot);
  // Clear all (E9): on every page, recording or not.
  main.push(
    b('clear', <Icon d={ERASER} />, () => actions.clearAll(), {
      className: ICON,
      'aria-label': 'Clear all',
      title: 'Clear all (Alt+Shift+C): remove the ink, outlines and open comment boxes from this page',
    }),
    <span key="sep-panel" className={SEP} aria-hidden="true" />,
    b('panel', 'Panel', () => run(actions.open('panel')), { title: 'Open the panel (Alt+Shift+P)' }),
  );
  if (state.host) {
    const label = `${state.host === 'connected' ? 'Host connected' : 'Host offline, will sync'}${state.hostNetwork ? ' · Unencrypted network hub' : ''}`;
    main.push(
      <span
        key="host"
        className={cn(DOT, 'mx-1', state.host === 'connected' ? 'bg-done' : 'bg-muted-foreground')}
        data-testid="toolbar-host"
        data-state={state.host}
        data-network={String(state.hostNetwork)}
        title={label}
        role="img"
        aria-label={label}
      />,
    );
  }
  main.push(
    b('theme', THEME_ICON[theme.setting], () => run(actions.cycleTheme()), {
      className: ICON,
      'data-setting': theme.setting,
      'aria-label': THEME_LABEL[theme.setting],
      title: THEME_LABEL[theme.setting],
    }),
    b('collapse', <Icon d={COLLAPSE} />, () => collapse(true), {
      className: ICON,
      'aria-label': 'Collapse the toolbar',
      title: 'Collapse',
    }),
  );
  if (!session)
    main.push(
      b('close', <Icon d={CLOSE} />, () => run(actions.hide()), {
        className: ICON,
        'aria-label': 'Hide the toolbar',
        title: 'Hide (the toolbar icon brings it back)',
      }),
    );

  const notice = localNotice ?? state.notice;
  const discard = state.discard && state.discard.deadline > Date.now() ? state.discard : null;
  const toast: { kind: string; text: string } | null = notice
    ? { kind: 'error', text: notice }
    : discard
      ? { kind: 'discard', text: 'Session discarded' }
      : state.toast;
  const undo = discard && !notice ? discard : null;

  // The discard toast goes at its deadline, should no newer state arrive first.
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(rerender, undo.deadline - Date.now() + 20);
    return () => clearTimeout(timer);
  }, [undo]);

  const barState = !session
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

  return (
    <>
      <div
        ref={bar}
        role="toolbar"
        aria-label="InkUp"
        data-testid="toolbar"
        data-state={barState}
        data-theme={theme.theme}
        data-theme-from={theme.from}
        hidden={collapsed}
        className={cn(
          SURFACE,
          'flex items-center gap-0.5 rounded-lg p-1 whitespace-nowrap select-none max-[480px]:max-w-[calc(100vw-16px)] max-[480px]:flex-wrap',
        )}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
      >
        <span
          className="flex h-7 w-4 cursor-grab touch-none items-center justify-center text-muted-foreground transition-colors hover:text-foreground active:cursor-grabbing [&_svg]:size-3.5"
          data-grip=""
          data-testid="toolbar-grip"
          title="Drag to move"
          aria-hidden="true"
        >
          <Icon d={GRIP} weight={3} />
        </span>
        <span className="contents">
          {frameShown ? (
            <iframe
              ref={frame}
              className={cn(
                'block h-[26px] w-[58px] border-0 bg-transparent [color-scheme:normal]',
                !frameStart && 'absolute h-0 w-0',
              )}
              data-testid="toolbar-start-frame"
              title="Start a review Session"
              allow="display-capture"
              src={actions.frameUrl ?? undefined}
              data-ready={frameReady ? 'true' : undefined}
              data-recording={frameRecording === null ? undefined : String(frameRecording)}
              data-parked={frameStart ? undefined : ''}
            />
          ) : null}
        </span>
        <span className="contents">{main}</span>
      </div>
      <button
        ref={pill}
        type="button"
        data-testid="toolbar-pill"
        aria-label="Expand the review toolbar"
        data-theme={theme.theme}
        hidden={!collapsed}
        className={cn(
          SURFACE,
          'flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1.5 hover:bg-accent',
          FOCUS,
        )}
        onClick={() => collapse(false)}
      >
        <span
          className={cn(
            DOT,
            session ? (paused ? 'bg-muted-foreground' : 'bg-pen motion-safe:animate-pulse') : 'bg-muted-foreground',
          )}
          aria-hidden="true"
        />
        <span className={TIMER}>{session ? (starting ? 'Starting…' : elapsedText()) : 'Review'}</span>
      </button>
      <div
        ref={toastEl}
        data-testid="toolbar-toast"
        role="status"
        aria-live="polite"
        data-theme={theme.theme}
        data-kind={toast?.kind ?? ''}
        hidden={!toast}
        className={cn(
          SURFACE,
          'max-w-80 rounded-lg px-2.5 py-1.5 leading-snug font-normal whitespace-normal',
          "data-[kind=draft]:before:text-muted-foreground data-[kind=draft]:before:content-['Draft_·_']",
          notice && 'border-destructive/40 text-destructive',
        )}
      >
        {toast?.text ?? ''}
        {undo ? (
          <>
            {' · '}
            <button
              type="button"
              data-testid="toolbar-undo-discard"
              data-session={undo.session_id}
              className={cn(
                'cursor-pointer font-semibold text-foreground underline decoration-1 underline-offset-[0.2em] hover:decoration-pen',
                FOCUS,
              )}
              onClick={() => run(actions.undoDiscard(undo.session_id))}
            >
              Undo
            </button>
          </>
        ) : null}
      </div>
    </>
  );
}
