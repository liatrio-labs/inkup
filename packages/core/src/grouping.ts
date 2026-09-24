// Annotation grouping (PRD P0-3). A pure state machine: callers feed it inputs in time order and get back the
// Annotations that closed. It closes on the 1.5s time gap and on a scroll of more than 25% of the viewport since
// the group's first Stroke. Other close reasons (navigation, Speech Boundary, draw toggle off, the `next` Voice
// Command, pause, session end) arrive as `{ kind: 'signal', reason }` inputs: the caller decides when a signal
// fires, the grouper only closes.
import { type Point, type Rect, union } from './geometry.ts';
import type { CloseReason } from './timeline.ts';

export const DEFAULT_GAP_MS = 1500;
/** A scroll of more than this fraction of the viewport (either axis) closes the open Annotation. */
export const SCROLL_CLOSE_FRACTION = 0.25;

export interface ViewportAt {
  scroll: Point;
  viewport: { width: number; height: number };
}

export interface StrokeRef {
  stroke_id: string;
  /** Pointer-down offset (ms since t0). */
  t: number;
  /** Pointer-up offset. */
  t_end: number;
  bbox: Rect;
  /** Scroll and viewport when the Stroke was drawn; enables the scroll rule. */
  at?: ViewportAt;
}

export type GroupingInput =
  | { kind: 'pointer_down'; t: number }
  | { kind: 'stroke'; stroke: StrokeRef }
  | { kind: 'tick'; t: number }
  | { kind: 'scroll'; t: number; at: ViewportAt }
  | {
      kind: 'signal';
      reason: Exclude<CloseReason, 'time_gap'>;
      t: number;
      /** Close only if the open group started before this time (a Speech Boundary spoken after the group began). */
      ifOpenedBefore?: number;
    };

export interface OpenGroup {
  strokes: StrokeRef[];
  t: number;
  t_end: number;
  /** Scroll position of the group's first Stroke. */
  anchor?: ViewportAt;
}

export interface ClosedGroup extends OpenGroup {
  bbox: Rect;
  close_reason: CloseReason;
  /** When the close was decided: last stroke end + gap for time gaps, the signal time otherwise. */
  closed_at: number;
}

export interface GroupingState {
  open: OpenGroup | null;
  /** Pointer is down: a Stroke is in progress, so a time gap cannot close the group yet. */
  drawing: boolean;
}

export interface GroupingOptions {
  gapMs?: number;
}

export const initialGroupingState = (): GroupingState => ({ open: null, drawing: false });

function close(open: OpenGroup, reason: CloseReason, closedAt: number): ClosedGroup {
  return { ...open, bbox: union(open.strokes.map((s) => s.bbox)), close_reason: reason, closed_at: closedAt };
}

/** True when `at` has scrolled more than 25% of the viewport away from `anchor`, on either axis. */
export function scrolledAway(anchor: ViewportAt, at: ViewportAt, fraction = SCROLL_CLOSE_FRACTION): boolean {
  return (
    Math.abs(at.scroll.y - anchor.scroll.y) > fraction * anchor.viewport.height ||
    Math.abs(at.scroll.x - anchor.scroll.x) > fraction * anchor.viewport.width
  );
}

export function stepGrouping(
  state: GroupingState,
  input: GroupingInput,
  { gapMs = DEFAULT_GAP_MS }: GroupingOptions = {},
): { state: GroupingState; closed: ClosedGroup[] } {
  const closed: ClosedGroup[] = [];
  let open = state.open;
  const expired = (t: number) => open !== null && t - open.t_end > gapMs;
  const closeGap = () => {
    closed.push(close(open!, 'time_gap', open!.t_end + gapMs));
    open = null;
  };

  switch (input.kind) {
    case 'pointer_down':
      if (expired(input.t)) closeGap();
      return { state: { open, drawing: true }, closed };
    case 'stroke': {
      const s = input.stroke;
      if (s.t_end < s.t) throw new RangeError(`stroke ${s.stroke_id} ends before it starts`);
      if (expired(s.t)) closeGap();
      if (open?.anchor && s.at && scrolledAway(open.anchor, s.at)) {
        closed.push(close(open, 'scroll', s.t));
        open = null;
      }
      open = open
        ? { ...open, strokes: [...open.strokes, s], t_end: Math.max(open.t_end, s.t_end) }
        : { strokes: [s], t: s.t, t_end: s.t_end, ...(s.at ? { anchor: s.at } : {}) };
      return { state: { open, drawing: false }, closed };
    }
    case 'tick':
      if (!state.drawing && expired(input.t)) closeGap();
      return { state: { open, drawing: state.drawing }, closed };
    case 'scroll':
      if (open?.anchor && scrolledAway(open.anchor, input.at)) {
        closed.push(close(open, 'scroll', input.t));
        open = null;
      }
      return { state: { open, drawing: state.drawing }, closed };
    case 'signal':
      if (!open || (input.ifOpenedBefore !== undefined && open.t >= input.ifOpenedBefore)) return { state, closed };
      closed.push(close(open, input.reason, input.t));
      return { state: { open: null, drawing: state.drawing }, closed };
  }
}

/** When a `tick` would close the open group, or null if nothing is pending. Callers set a timer for it. */
export function closeDeadline(state: GroupingState, { gapMs = DEFAULT_GAP_MS }: GroupingOptions = {}): number | null {
  if (!state.open || state.drawing) return null;
  return state.open.t_end + gapMs + 1;
}

/** Run a whole input sequence (sorted by time by the caller). Useful for replaying recorded Sessions. */
export function groupAll(
  inputs: readonly GroupingInput[],
  opts?: GroupingOptions,
): { closed: ClosedGroup[]; state: GroupingState } {
  let state = initialGroupingState();
  const closed: ClosedGroup[] = [];
  for (const input of inputs) {
    const r = stepGrouping(state, input, opts);
    state = r.state;
    closed.push(...r.closed);
  }
  return { closed, state };
}
