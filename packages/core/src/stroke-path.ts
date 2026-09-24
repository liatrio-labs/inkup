// Stroke outlines as SVG paths (review page overlay). Same perfect-freehand settings as the page overlay's
// canvas ink, so the overlay matches what the reviewer drew.
import { getStroke } from 'perfect-freehand';
import type { Point } from './geometry.ts';

export const INK_OPTIONS = { size: 7, thinning: 0.5, smoothing: 0.5, streamline: 0.5, last: true } as const;

const r = (n: number) => Math.round(n * 10) / 10;

/** The halo under a Stroke's ink (E8) is this much wider. */
export const HALO_EXTRA = 4;

/**
 * SVG path data for a Stroke, in the coordinate space of a screenshot: page points minus the screenshot's
 * scroll offset, in CSS px. Pair with viewBox "0 0 viewport.width viewport.height". `extra` widens it (the halo).
 */
export function strokeOutlinePath(points: readonly Point[], scroll: Point, extra = 0): string {
  const outline = getStroke(
    points.map((p) => [p.x - scroll.x, p.y - scroll.y]),
    { ...INK_OPTIONS, size: INK_OPTIONS.size + extra },
  );
  if (outline.length < 2) return '';
  const [first, ...rest] = outline as [number, number][];
  let d = `M${r(first![0])} ${r(first![1])}`;
  let prev = first!;
  for (const cur of rest) {
    d += ` Q${r(prev[0])} ${r(prev[1])} ${r((prev[0] + cur[0]) / 2)} ${r((prev[1] + cur[1]) / 2)}`;
    prev = cur;
  }
  return `${d} Z`;
}
