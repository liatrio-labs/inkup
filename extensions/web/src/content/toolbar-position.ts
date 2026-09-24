// Where the floating toolbar sits: its top-left corner in viewport px, kept fully on screen with a small margin. A
// saved position from a wider window is pulled back in, and a toolbar wider than the viewport pins to its left edge.

export interface Size {
  width: number;
  height: number;
}

export interface Pos {
  x: number;
  y: number;
}

export const EDGE_MARGIN = 8;

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));

export function clampPosition(pos: Pos, size: Size, viewport: Size, margin = EDGE_MARGIN): Pos {
  return {
    x: Math.round(clamp(pos.x, margin, viewport.width - size.width - margin)),
    y: Math.round(clamp(pos.y, margin, viewport.height - size.height - margin)),
  };
}

/** The first position: bottom right, clear of the page's own corner widgets by a little more than the margin. */
export function defaultPosition(size: Size, viewport: Size): Pos {
  return clampPosition({ x: viewport.width - size.width - 24, y: viewport.height - size.height - 24 }, size, viewport);
}
