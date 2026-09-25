import { describe, expect, it } from 'vitest';
import { dotGeometry, HOST_DOT_COLORS, hostDot, type IconContext, paintIcon } from '@/background/host-dot';
import { STRIPE_RGB, stripeWidth } from '@/lib/dev-stripes';

describe('the toolbar icon dot', () => {
  it('is green with a connected Host', () => {
    expect(hostDot({ state: 'connected', host_version: '0.1.0', capabilities: [] })).toMatchObject({
      state: 'connected',
      color: HOST_DOT_COLORS.connected,
    });
  });

  it('is blue when no Host is paired: the extension works on its own', () => {
    expect(hostDot({ state: 'unpaired' })).toEqual({
      state: 'local',
      color: HOST_DOT_COLORS.local,
      title: 'InkUp: local only (no Host paired)',
    });
  });

  it('is amber while a paired Host is being reached or is away', () => {
    for (const status of [
      { state: 'connecting' },
      { state: 'pairing' },
      { state: 'offline', error: 'refused', retry: true },
    ] as const) {
      expect(hostDot(status)).toMatchObject({ state: 'offline', color: HOST_DOT_COLORS.offline });
    }
  });

  it('uses three distinct colours', () => {
    expect(new Set(Object.values(HOST_DOT_COLORS)).size).toBe(3);
  });

  it('is a small circle in the bottom-right corner, ring included, inside the icon', () => {
    for (const size of [16, 32]) {
      const { cx, cy, r, ring } = dotGeometry(size);
      expect(cx + r + ring).toBeLessThanOrEqual(size);
      expect(cy + r + ring).toBeLessThanOrEqual(size);
      expect(cx).toBeGreaterThan(size / 2);
      expect(cy).toBeGreaterThan(size / 2);
      // Covers well under a quarter of the icon, unlike the badge it replaces.
      expect((Math.PI * (r + ring) ** 2) / size ** 2).toBeLessThan(0.25);
    }
  });
});

/** A 2D context that records each call, and whose pixels are the plain icon: solid red, filling its square. */
function recordingContext(size: number) {
  const calls: string[] = [];
  let put: Uint8ClampedArray | undefined;
  const ctx = {
    fillStyle: '',
    drawImage: () => calls.push('icon'),
    getImageData: () => {
      const data = new Uint8ClampedArray(size * size * 4);
      for (let i = 0; i < size * size; i++) data.set([200, 10, 10, 255], i * 4);
      return { width: size, height: size, data };
    },
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (img: { data: Uint8ClampedArray }) => {
      put = img.data;
      calls.push('stripes');
    },
    beginPath: () => {},
    arc: () => {},
    fill() {
      calls.push(`dot ${this.fillStyle}`);
    },
  };
  return { ctx: ctx as unknown as IconContext, calls, put: () => put };
}

describe('painting the toolbar icon', () => {
  const dot = hostDot({ state: 'unpaired' });

  it('in a development build: the stripes, the icon inset on them, then the dot on top', () => {
    for (const size of [16, 32]) {
      const { ctx, calls, put } = recordingContext(size);
      paintIcon(ctx, {} as CanvasImageSource, size, dot, true);
      // The icon is read back and put down again over the stripes, before the dot's ring and dot are filled.
      expect(calls).toEqual(['icon', 'stripes', 'dot #ffffff', `dot ${dot.color}`]);
      const px = (x: number, y: number) => Array.from(put()!.subarray((y * size + x) * 4, (y * size + x) * 4 + 4));
      expect(px(0, 0)).toEqual([...STRIPE_RGB[0], 255]);
      expect(px(size / 2, size / 2)).toEqual([200, 10, 10, 255]);
      expect(px(stripeWidth(size) - 1, size / 2)).not.toEqual([200, 10, 10, 255]);
    }
  });

  it('in a release build: the plain icon and the dot, no stripes', () => {
    const { ctx, calls, put } = recordingContext(16);
    paintIcon(ctx, {} as CanvasImageSource, 16, dot, false);
    expect(calls).toEqual(['icon', 'dot #ffffff', `dot ${dot.color}`]);
    expect(put()).toBeUndefined();
  });
});
