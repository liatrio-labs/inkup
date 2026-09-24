// Shape recognition (PRD P0-3). Rules-based, pure: every $1/$P npm package is unmaintained (docs/PLAN.md), and
// five classes need only a few geometric features of the resampled path.
//
// - arrow: a long, nearly straight shaft followed (or preceded) by a short terminal hook, the barbs, that
//   points back along the shaft. Also detected across two Strokes of one Annotation: a straight line plus a
//   short V whose tip lands at one end of it (detectConnector).
// - underline: nearly straight and within 25° of horizontal.
// - scribble: at least three sharp reversals, and a path several times longer than the box it covers.
// - circle: the path closes on itself (ends near its start, or turns through a full revolution) without sharp
//   corners. Ellipses and overshooting loops count.
// - freeform: anything else, including straight lines at other angles and a lone V.
//
// Thresholds were tuned on the recorded Strokes in fixtures/strokes (tests/unit/core/shapes.test.ts).
import type { Point } from './geometry.ts';

export type Shape = 'circle' | 'underline' | 'arrow' | 'scribble' | 'freeform';

export interface ArrowGeometry {
  tail: Point;
  head: Point;
}

export interface StrokeShape {
  shape: Shape;
  /** Set when shape is arrow. */
  arrow: ArrowGeometry | null;
}

const N = 64;
/** Turning is measured between points K samples apart on each side, which smooths hand jitter. */
const K = 3;
const SHARP = (105 * Math.PI) / 180;
/** The widest opening between the two arms of a two-Stroke arrow's V. */
const V_OPENING = (100 * Math.PI) / 180;
const REVERSAL = (135 * Math.PI) / 180;
/** Shaft or line: max perpendicular deviation as a fraction of the chord. */
const STRAIGHT = 0.12;
const MIN_LINE = 40;
const HORIZONTAL = (25 * Math.PI) / 180;
/** Barbs point back along the shaft: max angle between a barb and the head→tail direction. A check mark's short
 *  arm sits at about 65°, a drawn arrow's barbs at 20–45°. */
const BARB_BACK = (55 * Math.PI) / 180;
/** Barbs stay within this fraction of the shaft's length of the head. */
const BARB_MAX = 0.4;

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const angleBetween = (u: Point, v: Point) => {
  const n = Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y);
  if (n === 0) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y) / n)));
};
/** Signed turn from direction u to direction v, in (-π, π]. */
const signedTurn = (u: Point, v: Point) => Math.atan2(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y);

export function pathLength(pts: readonly Point[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1]!, pts[i]!);
  return l;
}

/** `n` points evenly spaced along the path (the $1 recognizer's resample). */
export function resample(points: readonly Point[], n = N): Point[] {
  const pts = points.map((p) => ({ x: p.x, y: p.y }));
  const total = pathLength(pts);
  if (pts.length < 2 || total === 0) return Array.from({ length: n }, () => ({ ...(pts[0] ?? { x: 0, y: 0 }) }));
  const step = total / (n - 1);
  const out: Point[] = [pts[0]!];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const d = dist(a, b);
    if (acc + d >= step && d > 0) {
      const q = { x: a.x + ((step - acc) / d) * (b.x - a.x), y: a.y + ((step - acc) / d) * (b.y - a.y) };
      out.push(q);
      pts.splice(i, 0, q);
      acc = 0;
    } else acc += d;
  }
  while (out.length < n) out.push({ ...pts[pts.length - 1]! });
  return out.slice(0, n);
}

/** Max perpendicular distance of the points from the chord a→b. */
function maxDeviation(pts: readonly Point[], a: Point, b: Point): number {
  const len = dist(a, b);
  if (len === 0) return Math.max(...pts.map((p) => dist(p, a)));
  let max = 0;
  for (const p of pts) max = Math.max(max, Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len);
  return max;
}

const isStraight = (pts: readonly Point[]) => {
  const a = pts[0]!;
  const b = pts[pts.length - 1]!;
  const chord = dist(a, b);
  return chord >= MIN_LINE && maxDeviation(pts, a, b) <= STRAIGHT * chord;
};

/** Turn angle at each index (0 where undefined), measured over K samples each side. */
function turns(p: readonly Point[]): number[] {
  return p.map((_, i) => (i < K || i >= p.length - K ? 0 : signedTurn(sub(p[i]!, p[i - K]!), sub(p[i + K]!, p[i]!))));
}

/** Local maxima of |turn| above `min`, at least K samples apart, in path order. */
function corners(t: readonly number[], min: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const a = Math.abs(t[i]!);
    if (a < min) continue;
    let isMax = true;
    for (let j = Math.max(0, i - K); j <= Math.min(t.length - 1, i + K); j++)
      if (Math.abs(t[j]!) > a || (Math.abs(t[j]!) === a && j < i)) isMax = false;
    if (isMax) out.push(i);
  }
  return out;
}

/**
 * A shaft from p[0] to the head, then a short hook at the head pointing back along the shaft. The head is the
 * point farthest from the tail: barbs point back, so they never reach past it.
 */
function arrowAlong(p: readonly Point[]): ArrowGeometry | null {
  const tail = p[0]!;
  let c = 0;
  for (let i = 1; i < p.length; i++) if (dist(tail, p[i]!) > dist(tail, p[c]!)) c = i;
  const head = p[c]!;
  const shaft = p.slice(0, c + 1);
  if (pathLength(shaft) < 0.5 * pathLength(p) || !isStraight(shaft)) return null;
  const chord = dist(tail, head);
  const hook = p.slice(c);
  if (hook.some((q) => dist(q, head) > BARB_MAX * chord)) return null;
  const far = hook.reduce((best, q) => (dist(q, head) > dist(best, head) ? q : best), head);
  if (dist(far, head) < Math.max(8, 0.06 * chord)) return null;
  if (angleBetween(sub(far, head), sub(tail, head)) > BARB_BACK) return null;
  return { tail, head };
}

export function classifyStroke(points: readonly Point[]): StrokeShape {
  const L = pathLength(points);
  if (points.length < 2 || L < 8) return { shape: 'freeform', arrow: null };
  const p = resample(points);
  const arrow = arrowAlong(p) ?? arrowAlong([...p].reverse());
  if (arrow) return { shape: 'arrow', arrow };

  const first = p[0]!;
  const last = p[p.length - 1]!;
  if (isStraight(p)) {
    const dir = sub(last, first);
    const tilt = Math.abs(Math.atan2(dir.y, dir.x));
    return { shape: Math.min(tilt, Math.PI - tilt) <= HORIZONTAL ? 'underline' : 'freeform', arrow: null };
  }

  const xs = p.map((q) => q.x);
  const ys = p.map((q) => q.y);
  const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const t = turns(p);
  const reversals = corners(t, REVERSAL).length;
  if (reversals >= 3 && L >= 2.5 * diag) return { shape: 'scribble', arrow: null };

  // Signed turning over the whole path; a closed loop turns through about 2π.
  let turning = 0;
  for (let i = 1; i < p.length - 1; i++) turning += signedTurn(sub(p[i]!, p[i - 1]!), sub(p[i + 1]!, p[i]!));
  const closed = dist(first, last) <= 0.3 * diag || Math.abs(turning) >= 1.9 * Math.PI;
  if (closed && Math.abs(turning) >= 1.5 * Math.PI && corners(t, SHARP).length <= 1)
    return { shape: 'circle', arrow: null };
  return { shape: 'freeform', arrow: null };
}

export interface ShapedStroke {
  stroke_id: string;
  points: readonly Point[];
}

export interface ConnectorGeometry extends ArrowGeometry {
  /** The Strokes that make up the arrow (one, or a shaft and a V). */
  stroke_ids: string[];
}

/** A short V: one sharp corner with two real arms. Returns its tip and arm ends. */
function vee(points: readonly Point[]): { tip: Point; arms: [Point, Point]; size: number } | null {
  const p = resample(points, 32);
  const L = pathLength(p);
  const a = p[0]!;
  const b = p[p.length - 1]!;
  // The tip is the point farthest from both ends; local turning is too sensitive to jitter at a V's corner.
  let c = 0;
  for (let i = 1; i < p.length; i++) if (dist(a, p[i]!) + dist(b, p[i]!) > dist(a, p[c]!) + dist(b, p[c]!)) c = i;
  const tip = p[c]!;
  if (dist(a, tip) < 0.2 * L || dist(b, tip) < 0.2 * L) return null;
  if (angleBetween(sub(a, tip), sub(b, tip)) > V_OPENING) return null;
  // Both arms are nearly straight: no loops or hooks.
  if (pathLength(p.slice(0, c + 1)) > 1.3 * dist(a, tip) || pathLength(p.slice(c)) > 1.3 * dist(b, tip)) return null;
  return { tip, arms: [a, b], size: Math.max(dist(a, tip), dist(b, tip)) };
}

/**
 * The Connector of an Annotation, if any: a single-Stroke arrow, or a straight shaft plus a short V whose tip
 * lands within max(24px, 20% of the shaft) of one of its ends with both arms pointing back along it.
 * Returns the per-Stroke shapes too, with both parts of a two-Stroke arrow marked `arrow`.
 */
export function detectConnector(strokes: readonly ShapedStroke[]): {
  shapes: Map<string, StrokeShape>;
  connector: ConnectorGeometry | null;
} {
  const shapes = new Map(strokes.map((s) => [s.stroke_id, classifyStroke(s.points)]));
  for (const s of strokes) {
    const sh = shapes.get(s.stroke_id)!;
    if (sh.arrow) return { shapes, connector: { ...sh.arrow, stroke_ids: [s.stroke_id] } };
  }
  for (const shaft of strokes) {
    const r = resample(shaft.points);
    if (!isStraight(r)) continue;
    const ends = [r[0]!, r[r.length - 1]!] as const;
    const length = dist(ends[0], ends[1]);
    for (const other of strokes) {
      if (other === shaft) continue;
      const v = vee(other.points);
      if (!v || v.size > BARB_MAX * length) continue;
      for (const [i, end] of ends.entries()) {
        const tail = ends[1 - i]!;
        if (dist(v.tip, end) > Math.max(24, 0.2 * length)) continue;
        if (v.arms.some((arm) => angleBetween(sub(arm, v.tip), sub(tail, v.tip)) > BARB_BACK)) continue;
        const arrow: StrokeShape = { shape: 'arrow', arrow: { tail, head: v.tip } };
        shapes.set(shaft.stroke_id, arrow);
        shapes.set(other.stroke_id, { shape: 'arrow', arrow: null });
        return { shapes, connector: { tail, head: v.tip, stroke_ids: [shaft.stroke_id, other.stroke_id] } };
      }
    }
  }
  return { shapes, connector: null };
}
