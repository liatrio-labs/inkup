// Development builds draw the icon over black-and-yellow construction stripes, so a build loaded from disk is never
// mistaken for the store release. Only the release workflows set INKUP_RELEASE_BUILD=1 (wxt.config.ts turns it into
// __INKUP_RELEASE_BUILD__); `wxt dev` and every local build are development builds.
// The desktop app draws the same stripes: 45° bands from bottom-left to top-right, round(size / 8) px wide measured
// along an axis, yellow first at the top-left, with the icon inset by one band so the stripes frame it on every side.
// Pure pixel code, so the WXT build (static manifest icons) and the background (the live toolbar icon) share it.

export const RELEASE_BUILD: boolean = typeof __INKUP_RELEASE_BUILD__ !== 'undefined' && __INKUP_RELEASE_BUILD__;

/** The two band colours, as RGB: even bands (the top-left corner) yellow, odd bands near-black. */
export const STRIPE_RGB = [
  [0xfa, 0xcc, 0x15],
  [0x11, 0x11, 0x11],
] as const;

/** RGBA pixels, row by row, like ImageData. */
export type Pixels = { width: number; height: number; data: Uint8ClampedArray };

/** How wide one band is on an icon of `size` px, and how far the icon is inset from each edge. */
export function stripeWidth(size: number): number {
  return Math.max(1, Math.round(size / 8));
}

/** Which band colour pixel (x, y) takes: 0 yellow, 1 black. Lines of equal x + y run bottom-left to top-right. */
export function stripeIndex(x: number, y: number, size: number): 0 | 1 {
  return (Math.floor((x + y) / stripeWidth(size)) % 2) as 0 | 1;
}

/** The stripes alone, filling the whole `size` square, fully opaque. */
export function stripePixels(size: number): Pixels {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = STRIPE_RGB[stripeIndex(x, y, size)];
      data.set([r, g, b, 255], (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}

/** Area-averaged resize with premultiplied alpha, so transparent pixels do not darken the edges. */
export function resize(src: Pixels, width: number, height: number): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < width; x++) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
        const wy = Math.min(y1, py + 1) - Math.max(y0, py);
        for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
          const w = wy * (Math.min(x1, px + 1) - Math.max(x0, px));
          const i = (py * src.width + px) * 4;
          const alpha = (src.data[i + 3]! / 255) * w;
          r += src.data[i]! * alpha;
          g += src.data[i + 1]! * alpha;
          b += src.data[i + 2]! * alpha;
          a += alpha;
          area += w;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) data.set([r / a, g / a, b / a], o);
      data[o + 3] = Math.round((a / area) * 255);
    }
  }
  return { width, height, data };
}

/** Draws `top` over `base` at (dx, dy), source-over, in place. */
export function drawOver(base: Pixels, top: Pixels, dx: number, dy: number): void {
  for (let y = 0; y < top.height; y++) {
    for (let x = 0; x < top.width; x++) {
      const t = (y * top.width + x) * 4;
      const b = ((y + dy) * base.width + x + dx) * 4;
      const ta = top.data[t + 3]! / 255;
      const ba = base.data[b + 3]! / 255;
      const oa = ta + ba * (1 - ta);
      for (let c = 0; c < 3; c++) {
        base.data[b + c] = oa === 0 ? 0 : (top.data[t + c]! * ta + base.data[b + c]! * ba * (1 - ta)) / oa;
      }
      base.data[b + 3] = Math.round(oa * 255);
    }
  }
}

/** The development icon: the stripes, then `icon` (any size, square) scaled to fit inside one band from each edge. */
export function stripedIcon(icon: Pixels, size: number): Pixels {
  const out = stripePixels(size);
  const inset = stripeWidth(size);
  drawOver(out, resize(icon, size - 2 * inset, size - 2 * inset), inset, inset);
  return out;
}
