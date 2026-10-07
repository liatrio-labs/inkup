// The page side of a Session, shared by the content script (web pages) and our own extension pages
// (src/page-overlay/mount.ts): it asks the service worker whether this tab is being recorded and whether it shows the
// floating toolbar, mounts one overlay root while either is true, and in it the drawing overlay, Object Select and the Text
// Comment box (while recording) and the toolbar (while shown). It answers the service worker's state pushes, flushes, close signals, page-context reads
// and screenshot hides, and holds the page API (`window.__inkup`, E5) open while this tab records. Only `mount` differs: the content script uses WXT's shadow-root UI, our pages a plain shadow
// host. Either way the host is kept in the browser's top layer, above the page's dialogs, popovers and fullscreen
// elements (content/top-layer.ts).
//
// The host has one React root (mountSurfaces from @inkup/ui), made with the host and unmounted before it goes; the
// toolbar renders into it as the "toolbar" surface, and the other in-page surfaces join it by key as they move to
// @inkup/ui. The drawing canvas stays outside React.
//
// Draw, Object Select and Select Text (E7) are the Session's modes, one at a time, held by the service worker
// (background/modes.ts): the toolbar's buttons, Alt+Shift+D/O/T and Esc (all off) ask it, and this page follows the
// state it pushes. Alt+Shift+M mutes and unmutes the microphone (E10) the same way, also while paused. Object Select
// lives as long as the Session on this page; a pick closes the open drawn Annotation first.
//
// E11: comment boxes (@inkup/ui's comment box) dictate through the service worker, and in a Session without voice a
// drawn Annotation asks for a typed note before it is recorded (@inkup/ui's draw note).
import { toOffset } from '@inkup/core/clock';
import { SHOT_TIMEOUT_MS, SWEEP_EVERY_MS, withTimeout } from '@inkup/core/overlay-lifetime';
import { connectDictation, type MountedDrawNote, mountDrawNote, receiveDictation } from '@inkup/ui/comment-box';
import { mountSurfaces, type Surfaces, Toolbar, type ToolbarHandle } from '@inkup/ui/toolbar';
import { createElement } from 'react';
import { type ModeRequest, modesOf, nextModes } from '@/background/modes';
import {
  type AnnotationInput,
  type ContentSessionState,
  type ObjectSelectInput,
  onMessage,
  sendMessage,
  type ToolbarActions,
  type ToolbarState,
} from '@/messaging';
import { platform } from '@/platform';
import { type SelectMode, toolbarPosition, toolbarTheme } from '@/settings';
import { claimPage } from './instance';
import { maxOverlayMs } from './lifetime';
import { ObjectSelect } from './object-select';
import { DrawingOverlay, type OverlayCallbacks, pageContext } from './overlay';
import { connectPageApi } from './page-api';
import { nextPaint } from './paint';
import { snapshotElementSourced } from './snapshot';
import { TextCommentUi } from './text-comment';
import { nextSetting, ToolbarThemer, themeFor } from './theme';
import { keepOnTop, type TopLayer } from './top-layer';

/** The shadow root's container and host, where the overlay and the toolbar mount. The mount adopts @inkup/ui's styles. */
export interface OverlayRoot {
  container: HTMLElement;
  host: HTMLElement;
  remove(): void;
}

export type MountRoot = () => Promise<OverlayRoot>;

/** An Object Select pick, started (its screenshot taken) but not yet done. */
type PickRecord = Omit<ObjectSelectInput, 't_end' | 'comment'> & { screenshot_id: string | null };

/** Closes the reviewer is present for; the others (Stop, navigation, a pick, a pause) record the Annotation as it is. */
const ASKS: ReadonlySet<AnnotationInput['close_reason']> = new Set(['time_gap', 'draw_toggle', 'scroll']);
const asksForNote = (reason: AnnotationInput['close_reason']) => ASKS.has(reason);

const baseCallbacks: OverlayCallbacks = {
  recordStroke: (stroke) => sendMessage('recordStroke', stroke),
  closeAnnotation: (input) => sendMessage('closeAnnotation', input),
  captureAnnotation: (input) => sendMessage('captureAnnotation', input),
  recordClick: (input) => sendMessage('recordClick', input),
  pressInteractive: (page) => sendMessage('pressInteractive', page),
  recordScrollSettle: (input) => sendMessage('recordScrollSettle', input),
  sampleBackground: (input) => sendMessage('sampleBackground', input),
};

const actions: ToolbarActions = {
  start: () => sendMessage('toolbarStart', { clicked_at: Date.now() }),
  pause: () => sendMessage('pauseSession'),
  resume: () => sendMessage('resumeSession'),
  stop: () => sendMessage('stopSession'),
  cancel: () => sendMessage('cancelSession'),
  turnOnVoice: () => sendMessage('turnOnVoice'),
  undoDiscard: (sessionId) => sendMessage('undoDiscard', sessionId),
  setMuted: (on) => sendMessage('setMuted', { on, via: 'button' }),
  setDraw: (on) => requestModes({ draw: on }),
  setSelect: (mode) => requestModes({ select: mode }),
  snap: () => sendMessage('snapScreenshot'),
  open: (what) => sendMessage('toolbarOpen', what),
  hide: () => sendMessage('toolbarHide'),
  loadPosition: () => toolbarPosition.getValue(),
  savePosition: (pos) => toolbarPosition.setValue(pos),
  ping: () => sendMessage('toolbarHello'),
  frameUrl:
    platform.capabilities().toolbarVideo === 'frame_picker' ? chrome.runtime.getURL('/toolbar-start.html') : null,
  clearAll: () => clearPage(),
  viewport: {
    set: (size) => sendMessage('viewportSet', size),
    reset: () => sendMessage('viewportReset'),
  },
  cycleTheme: async () => toolbarTheme.setValue(nextSetting(await toolbarTheme.getValue())),
  moved: () => themer?.moved(),
};

/** Clear all (E9) on this page; set once the overlay client runs. */
let clearPage: () => void = () => {};

/** Draw, Object Select or Select Text on or off; set once the overlay client runs. */
let requestModes: (request: ModeRequest) => Promise<unknown> = (request) => sendModes(request);

function sendModes(request: ModeRequest): Promise<unknown> {
  if (request === 'none') return sendMessage('clearModes');
  return 'draw' in request ? sendMessage('setDrawMode', request.draw) : sendMessage('setSelectMode', request.select);
}

/** The toolbar's theme keeper, while there is a toolbar on this page. */
let themer: ToolbarThemer | null = null;

export async function runOverlayClient(mount: MountRoot): Promise<void> {
  // One copy per page (#18): a second live copy does nothing; an orphaned one (after an update) makes way.
  if (!claimPage(() => leave())) return;
  let root: OverlayRoot | null = null;
  let overlay: DrawingOverlay | null = null;
  /** The host's React root, made with the host and unmounted before it goes. */
  let surfaces: Surfaces | null = null;
  /** The toolbar's handle while it is rendered (hide for a capture, the Start frame, its theme and rect). */
  const toolbarRef: { current: ToolbarHandle | null } = { current: null };
  let toolbar: ToolbarHandle | null = null;
  let objects: ObjectSelect<PickRecord> | null = null;
  let comments: TextCommentUi | null = null;
  let layer: TopLayer | null = null;
  let notes: MountedDrawNote | null = null;
  let session: ContentSessionState | null = null;
  let bar: ToolbarState | null = null;
  let applying = Promise.resolve();
  let left = false;
  // `window.__inkup` (E5): on while this tab records a Session, off otherwise.
  const pageApi = connectPageApi(
    (req) => sendMessage('pageApi', req),
    () => root?.host ?? null,
  );
  // Without voice, a drawn Annotation closed while the reviewer draws gets its typed note first (E11).
  const callbacks: OverlayCallbacks = {
    ...baseCallbacks,
    noteFor: (input) =>
      session && !session.voice && notes && asksForNote(input.close_reason) ? notes.ask(input.bbox) : null,
  };
  connectDictation({
    mode: () => (session?.voice && !session.paused ? session.box_dictation : null),
    set: (target, on) => void sendMessage('boxDictation', { target, on }).catch(() => {}),
  });

  /** Everything on the page goes now: Clear all, and the Session leaving the page (Stop after its flush, Cancel). */
  function wipe(): { strokes: number; picks: number; comments: number } {
    const strokes = overlay?.clearAll() ?? 0;
    const picks = objects?.clear() ?? 0;
    const comments_ = (comments?.clear() ?? 0) + (notes?.clear() ?? 0);
    return { strokes, picks, comments: comments_ };
  }

  async function apply() {
    if (left) return;
    pageApi.setEnabled(session !== null);
    const live = session && !session.paused ? session : null;
    if (!session) wipe();
    if (!session && objects) {
      objects.destroy();
      objects = null;
    }
    if (!session && overlay) {
      overlay.destroy();
      overlay = null;
    }
    if (!session && comments) {
      comments.destroy();
      comments = null;
    }
    if (!session && notes) {
      notes.destroy();
      notes = null;
    }
    if (!bar && toolbar) {
      themer?.destroy();
      themer = null;
      surfaces?.set('toolbar', null);
      toolbar = null;
    }
    if (!session && !bar) {
      layer?.destroy();
      layer = null;
      surfaces?.unmount();
      surfaces = null;
      root?.remove();
      root = null;
      return;
    }
    if (!root) {
      const mounted = await mount();
      if (left) return mounted.remove();
      root = mounted;
    }
    surfaces ??= mountSurfaces(root.container);
    layer ??= keepOnTop(root.host, { canMove: () => !toolbar?.holdsRecordingFrame() });
    if (session) {
      const host = root.host;
      notes ??= mountDrawNote(surfaces, (rect) => themeFor(rect, host));
      if (overlay) overlay.update(session);
      else overlay = new DrawingOverlay(root.container, root.host, session, callbacks);
      if (comments) comments.update(session);
      else
        comments = new TextCommentUi(surfaces, root.host, session, {
          closeAnnotation: async (t) => {
            notes?.flush();
            await overlay?.signal({ reason: 'text_comment', t });
          },
          record: (input) => sendMessage('recordTextComment', input),
        });
      objects ??= new ObjectSelect(
        root.host,
        {
          pick: async (el) => {
            const s = session;
            if (!s || !overlay) return null;
            const t = toOffset(s.t0, Date.now());
            notes?.flush();
            await overlay.closeForPick();
            const page = pageContext();
            const element = await snapshotElementSourced(el);
            const annotation_id = crypto.randomUUID();
            // Shot now, with the pick's outline on screen and before the comment box opens.
            // A screenshot that never answers counts as none (E9).
            const { screenshot_id } = await withTimeout(
              sendMessage('captureAnnotation', { annotation_id, page }),
              SHOT_TIMEOUT_MS,
              { screenshot_id: null },
            );
            return { annotation_id, t, page, element, screenshot_id };
          },
          record: (pick, comment) =>
            sendMessage('objectSelect', { ...pick, t_end: toOffset(session?.t0 ?? 0, Date.now()), comment }),
          discard: (pick) => {
            if (pick.screenshot_id) void sendMessage('dropPick', { screenshot_id: pick.screenshot_id }).catch(() => {});
          },
          target: (pick) => ({ annotation_id: pick.annotation_id }),
        },
        surfaces,
      );
    }
    const objectOn = live?.select_mode === 'object';
    overlay?.setSelecting(!!live?.select_mode);
    if (objectOn) objects?.start();
    else objects?.stop();
    if (bar) {
      surfaces.set('toolbar', createElement(Toolbar, { state: bar, actions, ref: toolbarRef }));
      if (!toolbar) {
        const tb = toolbarRef.current!;
        toolbar = tb;
        themer = new ToolbarThemer({
          host: root.host,
          target: tb,
          sample: (input) => sendMessage('sampleBackground', input),
          loadSetting: () => toolbarTheme.getValue(),
          watchSetting: (cb) => toolbarTheme.watch((s) => cb(s ?? 'auto')),
        });
      }
    }
    layer.refresh();
  }

  // Clear all (E9): every Stroke, outline, pick in progress and comment box leaves the page now. The open Annotation
  // closes first (reason `cleared`, no screenshot), and a recording tab logs what was cleared.
  clearPage = () => {
    const { strokes, picks, comments: boxes } = wipe();
    const s = session;
    if (s)
      void sendMessage('overlayCleared', {
        t: toOffset(s.t0, Date.now()),
        url: location.href,
        strokes,
        picks,
        comments: boxes,
      }).catch(() => {});
  };
  // The overlay cap (E9) for the outline, a pick left open and the comment boxes; the ink sweeps itself (./overlay.ts).
  const sweep = () => {
    const now = Date.now();
    objects?.sweep(now, maxOverlayMs());
    comments?.sweep(now, maxOverlayMs());
    notes?.sweep(now, maxOverlayMs());
  };
  const sweeper = setInterval(sweep, SWEEP_EVERY_MS);
  const listening = new AbortController();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sweep(), {
    signal: listening.signal,
  });

  /** This copy's extension was updated or reloaded, and the new one has claimed the page: everything of ours goes. */
  function leave() {
    left = true;
    // First what the page sees and what would put it back (the top-layer keeper re-adds a removed host). Each step on
    // its own: with the runtime gone, anything that reaches for the extension's APIs throws.
    const steps = [
      () => layer?.destroy(),
      () => surfaces?.unmount(),
      () => root?.remove(),
      () => root?.host.remove(),
      () => clearInterval(sweeper),
      () => listening.abort(),
      () => pageApi.disconnect(),
      () => objects?.destroy(),
      () => overlay?.destroy(),
      () => comments?.destroy(),
      () => notes?.destroy(),
      () => themer?.destroy(),
    ];
    for (const step of steps) {
      try {
        step();
      } catch {
        /* the next step still runs */
      }
    }
    objects = overlay = comments = notes = toolbar = layer = root = null;
    surfaces = null;
    themer = null;
  }

  // The mode shortcuts (Draw's Alt+Shift+D is a browser command) and Esc, anywhere on the page and on the toolbar, but
  // not while typing in a comment box (it handles its own Esc).
  window.addEventListener(
    'keydown',
    (e) => {
      const s = session;
      const path = e.composedPath();
      if (!root || (path.includes(root.host) && path[0] instanceof HTMLTextAreaElement)) return;
      // Alt+Shift+C: Clear all, recording or not.
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyC') {
        e.preventDefault();
        e.stopImmediatePropagation();
        clearPage();
        return;
      }
      if (!s) return;
      // Alt+Shift+M: Mute (E10), also while paused.
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyM') {
        e.preventDefault();
        e.stopImmediatePropagation();
        void sendMessage('setMuted', { on: !s.muted, via: 'shortcut' }).catch(() => {});
        return;
      }
      if (s.paused) return;
      if (e.key === 'Escape') {
        if (!s.draw_mode && !s.select_mode) return;
        e.preventDefault();
        void requestModes('none').catch(() => {});
        return;
      }
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
      const mode = e.code === 'KeyO' ? 'object' : e.code === 'KeyT' ? 'text' : null;
      if (!mode) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void requestModes({ select: s.select_mode === mode ? null : mode }).catch(() => {});
    },
    { capture: true, signal: listening.signal },
  );

  const enqueue = (change: () => void) => {
    applying = applying
      .then(() => {
        change();
        return apply();
      })
      .catch(console.warn);
  };

  // A mode change shows here at once and the service worker is told (F1): it may be busy starting the media context
  // (in Firefox that shares the background page's thread), and its pushes, which follow, have the last word. Should
  // it have decided otherwise, and changed nothing it would push, the toolbar asks for its state again.
  requestModes = async (request) => {
    const s = session;
    if (s && !s.paused) {
      const next = nextModes(modesOf(s), request);
      enqueue(() => {
        if (session === s) session = { ...s, ...next };
        if (bar?.session?.here && bar.session.can_draw && !bar.session.starting)
          bar = { ...bar, session: { ...bar.session, ...next } };
      });
    }
    const confirmed = await sendModes(request);
    const b = bar;
    const settled = confirmed as { draw_mode: boolean; select_mode?: SelectMode | null } | null;
    if (
      b?.session &&
      settled &&
      (b.session.draw_mode !== settled.draw_mode || b.session.select_mode !== (settled.select_mode ?? null))
    ) {
      const fresh = await sendMessage('toolbarHello');
      enqueue(() => (bar = fresh));
    }
    return confirmed;
  };

  // A pushed state is newer than the hello reply that may still be in flight: once one arrives, the reply is
  // stale (e.g. the reviewer turned drawing on while this page was loading).
  let pushedSession = false;
  let pushedBar = false;
  // Answered once the overlay has the state: Start waits for that before the toolbar says Recording (F1).
  onMessage('contentState', async ({ data }) => {
    pushedSession = true;
    enqueue(() => (session = data));
    await applying;
  });
  onMessage('toolbarState', ({ data }) => {
    pushedBar = true;
    enqueue(() => (bar = data));
  });
  onMessage('toolbarCapture', async ({ data }) => {
    await applying;
    await Promise.all([
      // A frame is painted before the shot even when none of these is on the page.
      data ? nextPaint() : undefined,
      toolbar?.hideForCapture(data),
      comments?.hideForCapture(data),
      objects?.hideForCapture(data),
      notes?.hideForCapture(data),
    ]);
  });
  onMessage('contentFlush', async () => {
    await applying;
    await objects?.flush();
    notes?.flush();
    await overlay?.flush();
  });
  onMessage('contentSignal', async ({ data }) => {
    await applying;
    if (data.reason === 'pause') notes?.flush();
    await overlay?.signal(data);
  });
  onMessage('contentDictation', ({ data }) => receiveDictation(data));
  onMessage('contentPing', () => true as const);
  onMessage('contentPageContext', () => pageContext());
  try {
    const hello = await sendMessage('contentHello');
    enqueue(() => {
      if (!pushedSession) session = hello.session;
      if (!pushedBar) bar = hello.toolbar;
    });
  } catch {
    /* service worker not ready or nothing to show: stay dormant until a state arrives */
  }
}
