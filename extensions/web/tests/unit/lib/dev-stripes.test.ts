import { describe, expect, it } from 'vitest';
import {
  type Pixels,
  RELEASE_BUILD,
  resize,
  STRIPE_RGB,
  stripedIcon,
  stripeIndex,
  stripePixels,
  stripeWidth,
} from '@/lib/dev-stripes';

const rgba = (p: Pixels, x: number, y: number) =>
  Array.from(p.data.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4));
const solid = (size: number, px: [number, number, number, number]): Pixels => {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) data.set(px, i * 4);
  return { width: size, height: size, data };
};
const YELLOW = [...STRIPE_RGB[0], 255];
const BLACK = [...STRIPE_RGB[1], 255];

describe('the development stripes', () => {
  it('are yellow #facc15 and near-black #111111', () => {
    expect(STRIPE_RGB).toEqual([
      [0xfa, 0xcc, 0x15],
      [0x11, 0x11, 0x11],
    ]);
  });

  it('are round(size / 8) px wide, at least 1', () => {
    expect([1, 4, 8, 16, 32, 48, 96, 128].map(stripeWidth)).toEqual([1, 1, 1, 2, 4, 6, 12, 16]);
  });

  it('run at 45° from bottom-left to top-right, alternating every band', () => {
    for (const size of [16, 32, 48, 128]) {
      const w = stripeWidth(size);
      // Constant along each bottom-left to top-right diagonal.
      for (let k = 0; k < 2 * size - 1; k++) {
        const colours = new Set<number>();
        for (let x = Math.max(0, k - size + 1); x <= Math.min(k, size - 1); x++)
          colours.add(stripeIndex(x, k - x, size));
        expect(colours.size).toBe(1);
      }
      // Yellow in the top-left corner, then w px of each colour in turn along the top edge.
      const row = Array.from({ length: 4 * w }, (_, x) => stripeIndex(x, 0, size));
      expect(row).toEqual([...Array(w).fill(0), ...Array(w).fill(1), ...Array(w).fill(0), ...Array(w).fill(1)]);
    }
  });

  it('fill the whole square, opaque', () => {
    const s = stripePixels(16);
    expect(rgba(s, 0, 0)).toEqual(YELLOW);
    expect(rgba(s, 2, 0)).toEqual(BLACK);
    expect(rgba(s, 15, 15)).toEqual(BLACK); // (15 + 15) / 2: band 15
  });
});

describe('the striped icon', () => {
  it('draws the icon inset by one band, so the stripes show on every edge even when the icon fills its square', () => {
    for (const size of [16, 32, 48, 96, 128]) {
      const w = stripeWidth(size);
      const out = stripedIcon(solid(size, [200, 10, 10, 255]), size);
      for (let i = 0; i < size; i++) {
        for (const [x, y] of [
          [i, 0],
          [0, i],
          [i, size - 1],
          [size - 1, i],
        ] as const) {
          expect(rgba(out, x, y)).toEqual([...STRIPE_RGB[stripeIndex(x, y, size)], 255]);
        }
      }
      expect(rgba(out, w, w)).toEqual([200, 10, 10, 255]);
      expect(rgba(out, size - w - 1, size - w - 1)).toEqual([200, 10, 10, 255]);
      expect(rgba(out, w - 1, w)).not.toEqual([200, 10, 10, 255]);
    }
  });

  it('lets the stripes through where the icon is transparent (its rounded corners)', () => {
    const icon = solid(16, [200, 10, 10, 255]);
    icon.data.set([0, 0, 0, 0], 0); // top-left pixel transparent
    const out = stripedIcon(icon, 16);
    // (2, 2) is where the icon's top-left corner lands: stripes show through, partly covered by the resize.
    expect(rgba(out, 2, 2)).not.toEqual([200, 10, 10, 255]);
    expect(rgba(out, 2, 2)[3]).toBe(255);
  });
});

describe('resize', () => {
  it('keeps a solid colour solid, and does not darken edges next to transparent pixels', () => {
    expect(rgba(resize(solid(16, [10, 20, 30, 255]), 12, 12), 5, 5)).toEqual([10, 20, 30, 255]);
    const half = solid(4, [255, 255, 255, 255]);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) half.data.set([0, 0, 0, 0], (y * 4 + x) * 4);
    const [r, g, b, a] = rgba(resize(half, 1, 1), 0, 0);
    expect([r, g, b]).toEqual([255, 255, 255]);
    expect(a).toBe(128);
  });
});

describe('the release flag', () => {
  it('is off in every build the release workflows did not make, tests included', () => {
    expect(RELEASE_BUILD).toBe(false);
  });
});
