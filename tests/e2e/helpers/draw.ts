// Real mouse paths for e2e tests and Stroke fixtures. Every helper draws with page.mouse (pointer down, moves,
// up), so the overlay records genuine pointer events. `hand` adds seeded jitter and a slow wobble, which is what
// the "hand-drawn" Stroke fixtures use.
import type { Page } from '@playwright/test';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Pt = readonly [number, number];

export interface HandOptions {
  /** Max random offset per point, px. */
  jitter?: number;
  /** Amplitude of a slow sinusoidal wobble, px. */
  wobble?: number;
  seed?: number;
}

/** mulberry32: a tiny seeded PRNG, so jittery paths are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function humanize(points: readonly Pt[], { jitter = 0, wobble = 0, seed = 1 }: HandOptions = {}): Pt[] {
  if (!jitter && !wobble) return [...points];
  const r = rng(seed);
  const phase = r() * Math.PI * 2;
  return points.map(([x, y], i) => {
    const w = wobble * Math.sin(phase + (i / points.length) * Math.PI * 3);
    return [x + (r() * 2 - 1) * jitter + w, y + (r() * 2 - 1) * jitter - w * 0.6] as const;
  });
}

/** Points along a polyline, `per` points per segment. */
function polyline(vertices: readonly Pt[], per: number): Pt[] {
  const out: Pt[] = [vertices[0]!];
  for (let i = 1; i < vertices.length; i++) {
    const [ax, ay] = vertices[i - 1]!;
    const [bx, by] = vertices[i]!;
    for (let j = 1; j <= per; j++) out.push([ax + ((bx - ax) * j) / per, ay + ((by - ay) * j) / per]);
  }
  return out;
}

/** One Stroke through `points` (viewport coordinates). */
export async function stroke(page: Page, points: readonly Pt[]) {
  await page.mouse.move(...points[0]!);
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(...p, { steps: 1 });
  await page.mouse.up();
}

/** Draws an ellipse around `box` (viewport coordinates) with real mouse events: pointer down, ~48 moves, up. */
export async function circle(page: Page, box: Box, margin = 1.08, hand?: HandOptions & { overshoot?: number }) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rx = (box.width / 2) * margin;
  const ry = (box.height / 2) * margin;
  const sweep = 2 * Math.PI * (1 + (hand?.overshoot ?? 0));
  const pts: Pt[] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * sweep;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  await stroke(page, humanize(pts, hand));
}

/** A horizontal line just under `box`. */
export async function underline(page: Page, box: Box, hand?: HandOptions) {
  const y = box.y + box.height + 4;
  await stroke(
    page,
    humanize(
      polyline(
        [
          [box.x, y],
          [box.x + box.width, y],
        ],
        30,
      ),
      hand,
    ),
  );
}

/** Back-and-forth zigzag over `box`, `passes` times. */
export async function scribble(page: Page, box: Box, passes = 8, hand?: HandOptions) {
  const v: Pt[] = [];
  for (let i = 0; i <= passes; i++)
    v.push([i % 2 === 0 ? box.x : box.x + box.width, box.y + (box.height * i) / passes]);
  await stroke(page, humanize(polyline(v, 6), hand));
}

export interface ArrowOptions extends HandOptions {
  /** Barb length, px (default 22% of the shaft, at most 40). */
  barb?: number;
  /** Draw the head as a separate V Stroke after the shaft. */
  twoStroke?: boolean;
}

/** An arrow from `from` to `to` (viewport coordinates): shaft, then barbs at `to` pointing back. */
export async function arrow(page: Page, from: Pt, to: Pt, opts: ArrowOptions = {}) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  const barb = opts.barb ?? Math.min(40, len * 0.22);
  const back = Math.atan2(-dy, -dx);
  const b1: Pt = [to[0] + barb * Math.cos(back + 0.5), to[1] + barb * Math.sin(back + 0.5)];
  const b2: Pt = [to[0] + barb * Math.cos(back - 0.5), to[1] + barb * Math.sin(back - 0.5)];
  const perShaft = Math.max(12, Math.round(len / 12));
  if (opts.twoStroke) {
    await stroke(page, humanize(polyline([from, to], perShaft), opts));
    await stroke(page, humanize(polyline([b1, to, b2], 6), { ...opts, seed: (opts.seed ?? 1) + 7 }));
  } else {
    await stroke(page, humanize(polyline([from, to, b1, to, b2], perShaft), opts));
  }
}

export const center = (b: Box): Pt => [b.x + b.width / 2, b.y + b.height / 2];

/** Pixels of a Stroke's ink colour (`#rrggbb`, E8 picks it per Stroke) in a PNG (base64), decoded in `page`. */
export function inkPixels(page: Page, png: string, ink: string): Promise<number> {
  return page.evaluate(
    async ({ b64, ink }) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(ink.slice(i, i + 2), 16));
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
      c.drawImage(img, 0, 0);
      const px = c.getImageData(0, 0, img.width, img.height).data;
      let n = 0;
      for (let i = 0; i < px.length; i += 4)
        if (Math.abs(px[i]! - r!) + Math.abs(px[i + 1]! - g!) + Math.abs(px[i + 2]! - b!) < 60) n++;
      return n;
    },
    { b64: png, ink },
  );
}

/** A capture of `clip` now: the page as it is composited, top layer included (base64 PNG). */
export async function screenPng(page: Page, clip: Box): Promise<string> {
  return (await page.screenshot({ clip })).toString('base64');
}
