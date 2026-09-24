// Plain rectangle math in page coordinates (CSS px, origin at the document's top-left).

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export const area = (r: Rect): number => Math.max(0, r.width) * Math.max(0, r.height);

export function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export const intersectionArea = (a: Rect, b: Rect): number => {
  const i = intersection(a, b);
  return i ? area(i) : 0;
};

/** Smallest rect containing all points. A single point yields a zero-size rect. */
export function boundsOfPoints(points: readonly Point[]): Rect {
  if (points.length === 0) throw new RangeError('boundsOfPoints needs at least one point');
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function union(rects: readonly Rect[]): Rect {
  if (rects.length === 0) throw new RangeError('union needs at least one rect');
  return boundsOfPoints(
    rects.flatMap((r) => [
      { x: r.x, y: r.y },
      { x: r.x + r.width, y: r.y + r.height },
    ]),
  );
}

export const containsPoint = (r: Rect, p: Point): boolean =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/**
 * Sample points on an n×n grid inside `r` (cell centres). Used by the content script to hit-test the
 * page under an Annotation with elementsFromPoint.
 */
export function gridPoints(r: Rect, n = 8): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      out.push({ x: r.x + ((j + 0.5) * r.width) / n, y: r.y + ((i + 0.5) * r.height) / n });
    }
  }
  return out;
}

/** Keep at most `max` items, evenly spaced, always including the first and last. */
export function evenlySample<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  if (max <= 1) return items.slice(0, Math.max(0, max));
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.round((i * (items.length - 1)) / (max - 1))]!);
  return out;
}
