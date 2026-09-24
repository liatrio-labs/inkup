// The drawing overlay (PRD P0-2): one full-viewport transparent canvas in a shadow root. Strokes render with
// perfect-freehand, stay while the pointer is down, then fade `fade_ms` after pointer-up. Strokes of an
// Annotation that has not been screenshotted yet are held on screen until the service worker confirms the
// capture (P0-6: "captured with the Strokes still visible"), then fade.
//
// It also owns the page-side capture signals (P0-3, P0-6): scrolling (the 25% rule and scroll settles), clicks
// on interactive elements, the draw toggle turning off, and leaving the page. Strokes are sent when their
// Annotation closes, so each carries its shape, including both parts of a two-Stroke arrow.
//
// What the Annotation points at is read while its Strokes are drawn, not when it closes (feedback batch 1, U2):
// at each Stroke's pointer-up the open Annotation's Candidates and page context are snapshotted, and shortly after
// its screenshot is asked for, Strokes still on screen. Later Strokes refresh both. A close only finalizes, so an
// Annotation closed by scrolling away still resolves to what was circled.
//
// No ink stays for good (plan E9): the screenshot and the close are given SHOT_TIMEOUT_MS and CLOSE_TIMEOUT_MS, after
// which the close goes on without them (screenshot_id null) and the Strokes fade; and whatever any message does, a
// Stroke with no activity for the overlay cap (./lifetime.ts) fades. One sweeper checks, on every rendered frame and
// once a second. A Stroke that has faded but whose Annotation has not been sent yet is kept off screen until it is.
// Clear all removes every Stroke at once and closes the open Annotation with reason `cleared`.
//
// Each Stroke's ink (E8) is picked at pointer-down from a small palette to stand out 3:1 from the page under the pen,
// read from computed styles (./theme.ts), and every Stroke has a thin black or white halo. Over an image the styles
// cannot tell: hovering in draw mode samples a capture there now and then, and a Stroke near a sample uses it.

import { closeShotPlan } from '@inkup/core/annotation-shot';
import { toOffset } from '@inkup/core/clock';
import { DEFAULT_INK, haloFor, pickInk, type Rgb } from '@inkup/core/contrast';
import { boundsOfPoints, containsPoint, type Point, type Rect, union } from '@inkup/core/geometry';
import {
  type ClosedGroup,
  closeDeadline,
  type GroupingInput,
  type GroupingState,
  initialGroupingState,
  type OpenGroup,
  stepGrouping,
  type ViewportAt,
} from '@inkup/core/grouping';
import { CLOSE_TIMEOUT_MS, expired, SHOT_TIMEOUT_MS, SWEEP_EVERY_MS, withTimeout } from '@inkup/core/overlay-lifetime';
import { detectConnector } from '@inkup/core/shapes';
import { HALO_EXTRA, INK_OPTIONS } from '@inkup/core/stroke-path';
import { computeAccessibleName } from 'dom-accessibility-api';
import { getStroke } from 'perfect-freehand';
import type { SampleInput } from '@/background/screenshots';
import type {
  AnnotationInput,
  AnnotationShotInput,
  ClickInput,
  ClickPage,
  ConnectorEndInput,
  ContentSessionState,
  ContentSignal,
  ScrollSettleInput,
  StrokeInput,
} from '@/messaging';
import { maxOverlayMs } from './lifetime';
import { selectorFor } from './selector';
import { snapshotWithSources } from './snapshot';
import { backgroundUnder } from './theme';

const FADE_OUT_MS = 350;
/**
 * The square under the pen whose colour picks the ink (just the tip: a mean over a wider square blends the page with
 * whatever is next to it), the square a capture samples, and how near a sample must be to count.
 */
const INK_PROBE = 2;
const INK_SAMPLE = 48;
const INK_SAMPLE_NEAR = 80;
const INK_SAMPLE_EVERY_MS = 1500;
/** A scroll settles after this long without scroll events; settles closer than SETTLE_MIN_PX are not logged. */
const SETTLE_MS = 400;
const SETTLE_MIN_PX = 40;
/** A Connector end with no mark under it resolves this square around the point. */
const END_BOX = 24;
/** The Annotation screenshot is asked for this long after a pointer-up: the last ink is painted by then. */
export const SHOT_SETTLE_MS = 120;
const INTERACTIVE =
  'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [contenteditable=""], [contenteditable="true"]';

interface LiveStroke {
  id: string;
  /** Page coordinates with Session offsets. */
  points: (Point & { t: number })[];
  t: number;
  t_end: number | null;
  /** Epoch ms when fading may begin; null while held. */
  fadeAt: number | null;
  /** Waiting for its Annotation's screenshot. */
  held: boolean;
  /** Epoch ms of its last activity (pointer down, each move, pointer up): the overlay cap counts from it. */
  lastActivity: number;
  /** Faded or cleared, but its Annotation not sent yet: kept (off screen) until closeGroup has sent it. */
  hidden: boolean;
  /** closeGroup has sent it: once faded it can go. */
  sent: boolean;
  scroll: Point;
  viewport: { width: number; height: number };
  dpr: number;
  url: string;
  /** Its ink and halo (E8). */
  color: string;
  halo: string;
}

/** The open Annotation as its latest Stroke left it. */
interface Draft {
  annotation_id: string;
  stroke_ids: string[];
  page: ReturnType<typeof pageContext>;
  /** `scrolls` when it was taken. */
  scrollSeq: number;
  snapshots: AnnotationInput['snapshots'];
  connector: AnnotationInput['connector'];
  /** Resolves once the likely Candidates' snapshots carry their `source` (E4; normally at once). */
  sourced: Promise<unknown>;
  shotTimer: ReturnType<typeof setTimeout> | undefined;
  /** The latest screenshot asked for; resolves to its id, or null when none was taken. */
  shot: Promise<string | null> | null;
  resolved: boolean;
  shotId: string | null;
}

export interface OverlayCallbacks {
  recordStroke(stroke: StrokeInput): Promise<void>;
  closeAnnotation(input: AnnotationInput): Promise<unknown>;
  captureAnnotation(input: AnnotationShotInput): Promise<{ screenshot_id: string | null }>;
  recordClick(input: ClickInput): Promise<void>;
  pressInteractive(page: ClickPage): Promise<void>;
  recordScrollSettle(input: ScrollSettleInput): Promise<void>;
  /**
   * The reviewer's note for this close, when one is asked for (E11, a Session without voice), else null. The close
   * waits for it without a timeout: the note box has the overlay cap (./draw-note.ts).
   */
  noteFor?(input: AnnotationInput): Promise<string | null> | null;
  /** The page's mean colour in a rect from a capture, where computed styles cannot tell (E8); null when skipped. */
  sampleBackground(input: SampleInput): Promise<Rgb | null>;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const viewportAt = (): ViewportAt => ({
  scroll: { x: window.scrollX, y: window.scrollY },
  viewport: { width: window.innerWidth, height: window.innerHeight },
});
export const pageContext = () => ({ url: location.href, ...viewportAt(), dpr: window.devicePixelRatio || 1 });

export class DrawingOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private strokes = new Map<string, LiveStroke>();
  private current: LiveStroke | null = null;
  private grouping: GroupingState = initialGroupingState();
  /** Drafts of open (or closing) Annotations, keyed by their first Stroke's id. */
  private drafts = new Map<string, Draft>();
  /** Counts scroll events of the page and of any inner scrolling container. */
  private scrolls = 0;
  private tickTimer: ReturnType<typeof setTimeout> | undefined;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSettle: Point = { x: window.scrollX, y: window.scrollY };
  /** Every message to the service worker goes through this chain, so Strokes are logged before their Annotation. */
  private chain: Promise<void> = Promise.resolve();
  private raf = 0;
  private drawMode = false;
  private paused = false;
  private shiftHeld = false;
  /** Object Select or Select Text is on: the canvas lets the pointer through to the page, and Shift never draws (E7). */
  private selecting = false;
  private state: ContentSessionState;
  /** The last capture sample of the page under the pen (page px), for Strokes over images (E8). */
  private inkSample: (Point & { color: Rgb }) | null = null;
  private lastInkSample = 0;

  constructor(
    container: HTMLElement,
    private host: HTMLElement,
    state: ContentSessionState,
    private cb: OverlayCallbacks,
  ) {
    this.state = state;
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.dataset.testid = 'overlay-canvas';
    Object.assign(this.canvas.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      pointerEvents: 'none',
      touchAction: 'none',
      background: 'transparent',
    });
    container.style.pointerEvents = 'none';
    container.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.resize();
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onUp);
    window.addEventListener('resize', this.resize);
    window.addEventListener('scroll', this.onScroll, { passive: true });
    document.addEventListener('scroll', this.onAnyScroll, { capture: true, passive: true });
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('keyup', this.onKey, true);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisible);
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_EVERY_MS);
    document.addEventListener('click', this.onClick, true);
    document.addEventListener('pointerdown', this.onPress, true);
    this.drawMode = state.draw_mode;
    this.paused = state.paused;
    this.applyPointerMode();
  }

  update(state: ContentSessionState) {
    const wasDrawing = this.drawMode;
    this.state = state;
    this.drawMode = state.draw_mode;
    this.paused = state.paused;
    if (this.paused && this.current) this.finishStroke(this.current, this.now());
    this.applyPointerMode();
    // Draw mode turning off closes the open Annotation (P0-3).
    if (wasDrawing && !state.draw_mode) this.feed({ kind: 'signal', reason: 'draw_toggle', t: this.offset() });
  }

  /** Close the open Annotation (Stop) and wait until every close has been recorded. */
  async flush(): Promise<void> {
    if (this.current) this.finishStroke(this.current, this.now());
    this.feed({ kind: 'signal', reason: 'session_end', t: this.offset() });
    await this.chain;
    this.sweep();
  }

  /** Object Select or Select Text on or off: while one is on, nothing is drawn. */
  setSelecting(on: boolean): void {
    this.selecting = on;
    if (on && this.current) this.finishStroke(this.current, this.now());
    this.applyPointerMode();
  }

  /** An Object Select pick closes the open Annotation (reason object_select) first, so the pick is numbered after it. */
  async closeForPick(): Promise<void> {
    this.feed({ kind: 'signal', reason: 'object_select', t: this.offset() });
    await this.chain;
  }

  /** A close signal from the service worker (Speech Boundary, `next`/`scratch that`, pause). */
  async signal(sig: ContentSignal): Promise<void> {
    if (sig.reason === 'pause' && this.current) this.finishStroke(this.current, this.now());
    this.feed({
      kind: 'signal',
      reason: sig.reason,
      t: sig.t,
      ...(sig.if_opened_before !== undefined ? { ifOpenedBefore: sig.if_opened_before } : {}),
    });
    await this.chain;
  }

  /**
   * The overlay cap (E9): a Stroke still being drawn with no pointer activity that long ends (a lost pointer-up), and
   * any Stroke idle that long fades, held for its screenshot or not.
   */
  sweep(now = this.now()): void {
    const max = maxOverlayMs();
    // It ended at its last move, so it is already idle past the cap and fades below.
    if (this.current && expired(this.current.lastActivity, now, max))
      this.finishStroke(this.current, this.current.lastActivity);
    let changed = false;
    for (const s of this.strokes.values()) {
      if (s === this.current || s.hidden || (!s.held && s.fadeAt !== null) || !expired(s.lastActivity, now, max))
        continue;
      s.held = false;
      s.fadeAt = now;
      changed = true;
    }
    if (changed) this.requestRender();
  }

  /**
   * Clear all (E9): the open Annotation closes with reason `cleared` (no screenshot) and every Stroke leaves the
   * page now. How many Strokes were on it.
   */
  clearAll(): number {
    if (this.current) this.finishStroke(this.current, this.now());
    this.feed({ kind: 'signal', reason: 'cleared', t: this.offset() });
    let n = 0;
    for (const s of [...this.strokes.values()]) {
      if (!s.hidden) n++;
      if (s.sent) this.strokes.delete(s.id);
      else s.hidden = true;
    }
    this.requestRender();
    return n;
  }

  destroy() {
    clearInterval(this.sweepTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
    clearTimeout(this.tickTimer);
    clearTimeout(this.settleTimer);
    for (const d of this.drafts.values()) clearTimeout(d.shotTimer);
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('scroll', this.onScroll);
    document.removeEventListener('scroll', this.onAnyScroll, { capture: true });
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKey, true);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('click', this.onClick, true);
    document.removeEventListener('pointerdown', this.onPress, true);
    this.canvas.remove();
  }

  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private onVisible = () => {
    if (document.visibilityState === 'visible') this.sweep();
  };

  private now = () => Date.now();
  private offset = (at = Date.now()) => toOffset(this.state.t0, at);

  private applyPointerMode() {
    const on = !this.paused && !this.selecting && (this.drawMode || this.shiftHeld || this.current !== null);
    this.canvas.style.pointerEvents = on ? 'auto' : 'none';
    this.canvas.style.cursor = on ? 'crosshair' : 'default';
  }

  private onKey = (e: KeyboardEvent) => {
    // Shift typed in our own UI (a Text Comment) is typing, not drawing.
    if (e.key !== 'Shift' || e.composedPath().includes(this.host)) return;
    // Hold Shift (alone) to draw while draw mode is off.
    this.shiftHeld = e.type === 'keydown' && !e.altKey && !e.ctrlKey && !e.metaKey;
    this.applyPointerMode();
  };

  private onBlur = () => {
    this.shiftHeld = false;
    this.applyPointerMode();
  };

  private resize = () => {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this.requestRender();
  };

  private onScroll = () => {
    this.requestRender();
    if (this.paused) return;
    this.feed({ kind: 'scroll', t: this.offset(), at: viewportAt() });
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      const at = { x: window.scrollX, y: window.scrollY };
      if (Math.abs(at.x - this.lastSettle.x) < SETTLE_MIN_PX && Math.abs(at.y - this.lastSettle.y) < SETTLE_MIN_PX)
        return;
      this.lastSettle = at;
      this.enqueue(() => this.cb.recordScrollSettle({ t: this.offset(), ...pageContext() }));
    }, SETTLE_MS);
  };

  private onAnyScroll = () => {
    this.scrolls++;
  };

  /** The interactive page element an event hit; nothing for our own overlay host (the toolbar's buttons). */
  private interactiveTarget = (e: Event) => {
    const path = e.composedPath();
    if (path.includes(this.host)) return undefined;
    return path.find((n): n is Element => n instanceof Element && n.matches(INTERACTIVE));
  };

  /**
   * Pressing an interactive element asks for the click screenshot at once, outside the message chain. The click
   * itself fires on release and may start a navigation straight away; the press gives the capture a head start.
   */
  private onPress = (e: PointerEvent) => {
    if (!e.isTrusted || this.paused || e.button !== 0 || !this.interactiveTarget(e)) return;
    void this.cb
      .pressInteractive({ url: location.href, ...viewportAt(), dpr: window.devicePixelRatio || 1 })
      .catch(() => {});
  };

  /** A click on something interactive (P0-6). Only the element is recorded, never what is typed. */
  private onClick = (e: MouseEvent) => {
    if (!e.isTrusted || this.paused) return;
    const el = this.interactiveTarget(e);
    if (!el) return;
    let name = '';
    try {
      name = computeAccessibleName(el).replace(/\s+/g, ' ').trim().slice(0, 200);
    } catch {
      /* exotic element */
    }
    const input: ClickInput = {
      t: this.offset(),
      ...pageContext(),
      point: { x: round1(e.clientX + window.scrollX), y: round1(e.clientY + window.scrollY) },
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      name,
    };
    this.enqueue(() => this.cb.recordClick(input));
  };

  /**
   * Leaving the page closes the open Annotation (reason navigation). The page is going away, so the close runs
   * now, outside the chain: its messages are posted before the document unloads.
   */
  private onPageHide = () => {
    if (this.current) this.finishStroke(this.current, this.now());
    const r = stepGrouping(this.grouping, { kind: 'signal', reason: 'navigation', t: this.offset() });
    this.grouping = r.state;
    clearTimeout(this.tickTimer);
    for (const g of r.closed) void this.closeGroup(g);
    this.sweep();
  };

  private pagePoint(e: PointerEvent): Point & { t: number } {
    return { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY, t: this.offset() };
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0 || this.paused) return;
    e.preventDefault();
    e.stopPropagation();
    this.canvas.setPointerCapture(e.pointerId);
    const t = this.offset();
    this.feed({ kind: 'pointer_down', t });
    this.current = {
      id: crypto.randomUUID(),
      points: [this.pagePoint(e)],
      t,
      t_end: null,
      fadeAt: null,
      held: true,
      lastActivity: Date.now(),
      hidden: false,
      sent: false,
      scroll: { x: window.scrollX, y: window.scrollY },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dpr: window.devicePixelRatio || 1,
      url: location.href,
      ...this.inkAt(e.clientX, e.clientY),
    };
    this.strokes.set(this.current.id, this.current);
    this.applyPointerMode();
    this.requestRender();
  };

  /** The ink for a Stroke starting here: from the page's styles, else a sample taken near here, else the default. */
  private inkAt(x: number, y: number): { color: string; halo: string } {
    const bg = backgroundUnder(new DOMRect(x - INK_PROBE / 2, y - INK_PROBE / 2, INK_PROBE, INK_PROBE), this.host);
    const near =
      this.inkSample &&
      Math.hypot(this.inkSample.x - (x + window.scrollX), this.inkSample.y - (y + window.scrollY)) <= INK_SAMPLE_NEAR;
    const page = bg.kind === 'color' ? bg.color : near ? this.inkSample!.color : null;
    const color = page ? pickInk(page) : DEFAULT_INK;
    return { color, halo: haloFor(color, page) };
  }

  /** Hovering in draw mode over what the styles cannot tell (an image): sample it now and then for the next Stroke. */
  private probeInk(e: PointerEvent) {
    if (Date.now() - this.lastInkSample < INK_SAMPLE_EVERY_MS) return;
    const [x, y] = [e.clientX, e.clientY];
    const at = { x: x + window.scrollX, y: y + window.scrollY };
    if (this.inkSample && Math.hypot(this.inkSample.x - at.x, this.inkSample.y - at.y) <= INK_SAMPLE_NEAR / 2) return;
    if (
      backgroundUnder(new DOMRect(x - INK_PROBE / 2, y - INK_PROBE / 2, INK_PROBE, INK_PROBE), this.host).kind ===
      'color'
    )
      return;
    this.lastInkSample = Date.now();
    const rect = { x: x - INK_SAMPLE / 2, y: y - INK_SAMPLE / 2, width: INK_SAMPLE, height: INK_SAMPLE };
    void this.cb
      .sampleBackground({ rect, viewport: { width: window.innerWidth, height: window.innerHeight }, ring: 0 })
      .then((color) => {
        if (color) this.inkSample = { ...at, color };
      })
      .catch(() => {});
  }

  private onMove = (e: PointerEvent) => {
    if (!this.current) return this.probeInk(e);
    e.preventDefault();
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ce of events.length ? events : [e]) this.current.points.push(this.pagePoint(ce));
    this.current.lastActivity = Date.now();
    this.requestRender();
  };

  private onUp = (e: PointerEvent) => {
    if (!this.current) return;
    e.preventDefault();
    this.current.points.push(this.pagePoint(e));
    this.finishStroke(this.current, this.now());
  };

  private finishStroke(s: LiveStroke, at: number) {
    this.current = null;
    s.lastActivity = Math.max(s.lastActivity, at);
    s.t_end = Math.max(s.t, this.offset(at));
    this.applyPointerMode();
    const bbox = boundsOfPoints(s.points);
    this.feed({
      kind: 'stroke',
      stroke: { stroke_id: s.id, t: s.t, t_end: s.t_end, bbox, at: { scroll: s.scroll, viewport: s.viewport } },
    });
    const open = this.grouping.open;
    if (open?.strokes.some((r) => r.stroke_id === s.id)) this.snapshotDraft(open);
    this.requestRender();
  }

  /** Snapshots the open Annotation now, while its Strokes are over what they mark, and schedules its screenshot. */
  private snapshotDraft(open: OpenGroup) {
    const key = open.strokes[0]!.stroke_id;
    const live = open.strokes.map((ref) => this.strokes.get(ref.stroke_id)).filter((x): x is LiveStroke => !!x);
    const { connector } = detectConnector(live.map((x) => ({ stroke_id: x.id, points: x.points })));
    const marks = connector
      ? live.filter((x) => !connector.stroke_ids.includes(x.id)).map((x) => boundsOfPoints(x.points))
      : [];
    const prev = this.drafts.get(key);
    clearTimeout(prev?.shotTimer);
    const main = snapshotWithSources(
      union(open.strokes.map((r) => r.bbox)),
      live.flatMap((x) => x.points),
      this.host,
    );
    const ends = connector
      ? { tail: this.connectorEnd(connector.tail, marks), head: this.connectorEnd(connector.head, marks) }
      : null;
    const draft: Draft = {
      annotation_id: prev?.annotation_id ?? crypto.randomUUID(),
      stroke_ids: open.strokes.map((r) => r.stroke_id),
      page: pageContext(),
      scrollSeq: this.scrolls,
      snapshots: main.snapshots,
      connector:
        connector && ends ? { stroke_ids: connector.stroke_ids, tail: ends.tail.end, head: ends.head.end } : null,
      sourced: Promise.all([main.sourced, ends?.tail.sourced, ends?.head.sourced]),
      shotTimer: undefined,
      shot: prev?.shot ?? null,
      resolved: prev?.resolved ?? false,
      shotId: prev?.shotId ?? null,
    };
    draft.shotTimer = setTimeout(() => this.requestShot(draft), SHOT_SETTLE_MS);
    this.drafts.set(key, draft);
  }

  /** The page, or a container inside it, scrolled since the draft was taken: its Strokes may not be over their marks. */
  private scrolledSince = (d: Draft) => this.scrolls !== d.scrollSeq;

  /**
   * Asks for the Annotation's screenshot with the page context read in this same turn. Skipped once the page has
   * scrolled away from the Strokes: the draft keeps its earlier shot, if any.
   */
  private requestShot(d: Draft) {
    d.shotTimer = undefined;
    if (this.scrolledSince(d)) return;
    const earlier = d.shot;
    d.resolved = false;
    // A screenshot that never answers counts as none (E9).
    d.shot = withTimeout(
      this.cb.captureAnnotation({ annotation_id: d.annotation_id, page: pageContext() }),
      SHOT_TIMEOUT_MS,
      { screenshot_id: null },
    )
      .then((r) => r.screenshot_id)
      .then(async (id) => id ?? (earlier ? await earlier : null))
      .then((id) => {
        d.resolved = true;
        d.shotId = id;
        return id;
      });
  }

  private feed(input: GroupingInput) {
    const r = stepGrouping(this.grouping, input);
    this.grouping = r.state;
    // closeGroup bounds its own waits (a note being typed is not a hung message).
    for (const g of r.closed) this.enqueue(() => this.closeGroup(g), false);
    clearTimeout(this.tickTimer);
    const deadline = closeDeadline(this.grouping);
    if (deadline !== null) {
      this.tickTimer = setTimeout(
        () => this.feed({ kind: 'tick', t: this.offset() }),
        Math.max(0, deadline - this.offset()),
      );
    }
  }

  /** Messages go one at a time; one that never answers holds the next ones back CLOSE_TIMEOUT_MS at most (E9). */
  private enqueue(task: () => Promise<unknown>, bounded = true) {
    const warned = () =>
      Promise.resolve()
        .then(task)
        .catch((err) => console.warn('[var] message to the service worker failed', err));
    this.chain = this.chain
      .then(() => (bounded ? withTimeout(warned(), CLOSE_TIMEOUT_MS, undefined) : warned()))
      .then(() => undefined);
  }

  /** A Connector end: the other mark it lands on, else a small square around the point. */
  private connectorEnd(point: Point, marks: readonly Rect[]): { end: ConnectorEndInput; sourced: Promise<void> } {
    const near = (r: Rect) =>
      containsPoint({ x: r.x - 16, y: r.y - 16, width: r.width + 32, height: r.height + 32 }, point);
    const bbox = marks.find(near) ?? {
      x: point.x - END_BOX / 2,
      y: point.y - END_BOX / 2,
      width: END_BOX,
      height: END_BOX,
    };
    const { snapshots, sourced } = snapshotWithSources(bbox, [point], this.host);
    return { end: { point: { x: round1(point.x), y: round1(point.y) }, bbox, snapshots }, sourced };
  }

  /**
   * Sends the group's Strokes (with their shapes) and then its Annotation. The messages are all posted before
   * the first await, so a close during pagehide still reaches the service worker.
   */
  private async closeGroup(g: ClosedGroup) {
    const live = g.strokes.map((ref) => this.strokes.get(ref.stroke_id)).filter((s): s is LiveStroke => !!s);
    const { shapes } = detectConnector(live.map((s) => ({ stroke_id: s.id, points: s.points })));
    const key = g.strokes[0]!.stroke_id;
    const draft = this.drafts.get(key) ?? this.snapshotNow(g);
    this.drafts.delete(key);
    // A screenshot still waiting for its settle is asked for now (unless the page already scrolled away).
    if (draft.shotTimer !== undefined) {
      clearTimeout(draft.shotTimer);
      if (g.close_reason !== 'cleared') this.requestShot(draft);
    }
    const sends: Promise<unknown>[] = live.map((s) =>
      this.cb.recordStroke({
        stroke_id: s.id,
        t: s.t,
        t_end: s.t_end ?? s.t,
        points: s.points.map((p) => ({ x: round1(p.x), y: round1(p.y), t: p.t })),
        bbox: boundsOfPoints(s.points),
        url: s.url,
        scroll: s.scroll,
        viewport: s.viewport,
        dpr: s.dpr,
        shape: shapes.get(s.id)?.shape ?? null,
        color: s.color,
      }),
    );
    const input: AnnotationInput = {
      annotation_id: draft.annotation_id,
      stroke_ids: g.strokes.map((s) => s.stroke_id),
      t: g.t,
      t_end: g.t_end,
      close_reason: g.close_reason,
      bbox: g.bbox,
      url: live[0]?.url ?? draft.page.url,
      scroll: draft.page.scroll,
      viewport: draft.page.viewport,
      dpr: draft.page.dpr,
      snapshots: draft.snapshots,
      connector: draft.connector,
    };
    const plan = closeShotPlan({
      reason: g.close_reason,
      requested: draft.shot !== null,
      resolved: draft.resolved,
      scrolled: this.scrolledSince(draft),
    });
    if (plan === 'none') input.screenshot_id = null;
    else if (plan === 'own' && draft.resolved) input.screenshot_id = draft.shotId;
    // A navigation close posts everything before its first await, while the page still exists.
    const shot = plan === 'own' && !draft.resolved ? draft.shot : null;
    // Sources normally arrived with the snapshot; a navigation close cannot wait for them.
    const sourced = g.close_reason === 'navigation' ? null : withTimeout(draft.sourced, SHOT_TIMEOUT_MS, undefined);
    const note = this.cb.noteFor?.(input) ?? null;
    const close = async (screenshot_id?: string | null) => {
      const closed = screenshot_id === undefined ? input : { ...input, screenshot_id };
      return this.cb.closeAnnotation(note ? { ...closed, comment: await note } : closed);
    };
    if (shot) sends.push(Promise.all([shot, sourced]).then(([id]) => close(id)));
    else sends.push(sourced ? sourced.then(() => close()) : close());
    for (const s of live) s.sent = true;
    try {
      // Its Strokes stay on screen while the note is typed; the timeout below counts from the note.
      if (note) await note.catch(() => null);
      // A close that never answers is given up on (E9): the Strokes must fade anyway.
      await withTimeout(
        Promise.all(sends).catch((err) => console.warn('[var] closeAnnotation failed', err)),
        CLOSE_TIMEOUT_MS,
        undefined,
      );
    } finally {
      // Screenshot taken (or impossible): let these Strokes fade, no earlier than fade_ms after pointer-up.
      const now = this.now();
      for (const s of live) {
        if (s.hidden) this.strokes.delete(s.id);
        if (s.fadeAt !== null && !s.held) continue;
        s.held = false;
        s.fadeAt = Math.max(now, this.state.t0 + (s.t_end ?? 0) + this.state.fade_ms);
      }
      this.requestRender();
    }
  }

  /** A group closed without a draft (its Strokes were never finished here): snapshot it as it stands. */
  private snapshotNow(g: ClosedGroup): Draft {
    const live = g.strokes.map((ref) => this.strokes.get(ref.stroke_id)).filter((s): s is LiveStroke => !!s);
    const { snapshots, sourced } = snapshotWithSources(
      g.bbox,
      live.flatMap((s) => s.points),
      this.host,
    );
    return {
      annotation_id: crypto.randomUUID(),
      stroke_ids: g.strokes.map((r) => r.stroke_id),
      page: pageContext(),
      scrollSeq: this.scrolls,
      snapshots,
      connector: null,
      sourced,
      shotTimer: undefined,
      shot: null,
      resolved: false,
      shotId: null,
    };
  }

  private requestRender = () => {
    if (!this.raf) this.raf = requestAnimationFrame(this.render);
  };

  private render = () => {
    this.raf = 0;
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, -window.scrollX * dpr, -window.scrollY * dpr);
    const now = this.now();
    this.sweep(now);
    let animating = false;
    for (const s of this.strokes.values()) {
      if (s.hidden) continue;
      let alpha = 1;
      if (!s.held && s.fadeAt !== null) {
        alpha = 1 - (now - s.fadeAt) / FADE_OUT_MS;
        if (alpha <= 0) {
          if (s.sent) this.strokes.delete(s.id);
          else s.hidden = true;
          continue;
        }
        alpha = Math.min(1, alpha);
        animating = true;
      }
      const opts = { thinning: 0.5, smoothing: 0.5, streamline: 0.5, last: s.t_end !== null };
      const outline = getStroke(s.points, { ...opts, size: INK_OPTIONS.size });
      if (outline.length < 2) continue;
      ctx.globalAlpha = alpha;
      fillOutline(ctx, getStroke(s.points, { ...opts, size: INK_OPTIONS.size + HALO_EXTRA }), s.halo);
      fillOutline(ctx, outline, s.color);
    }
    ctx.globalAlpha = 1;
    // What is on the page, for tests: Strokes kept, and those drawn.
    this.canvas.dataset.strokes = String(this.strokes.size);
    this.canvas.dataset.visible = String([...this.strokes.values()].filter((s) => !s.hidden).length);
    // Keep ticking while a released Stroke is waiting to fade or fading.
    if (animating || [...this.strokes.values()].some((s) => !s.hidden && s.fadeAt !== null)) this.requestRender();
  };
}

function fillOutline(ctx: CanvasRenderingContext2D, outline: number[][], color: string) {
  if (outline.length < 2) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(outline[0]![0]!, outline[0]![1]!);
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i - 1]!;
    const [x1, y1] = outline[i]!;
    ctx.quadraticCurveTo(x0!, y0!, (x0! + x1!) / 2, (y0! + y1!) / 2);
  }
  ctx.closePath();
  ctx.fill();
}
