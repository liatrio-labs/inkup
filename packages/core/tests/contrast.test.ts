import { describe, expect, it } from 'vitest';
import {
  BLACK,
  contrastRatio,
  DEFAULT_INK,
  effectiveBackground,
  haloFor,
  INK_CONTRAST,
  INK_PALETTE,
  type Layer,
  luminance,
  nextTheme,
  parseColor,
  pickInk,
  pointColor,
  THEME_HIGH,
  THEME_LOW,
  WHITE,
} from '../src/contrast.ts';

const layer = (background: string, image = false): Layer => ({ background, image });
const near = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) =>
  Math.abs(a.r - b.r) < 0.6 && Math.abs(a.g - b.g) < 0.6 && Math.abs(a.b - b.b) < 0.6;

describe('colours', () => {
  it('parses the forms computed styles use', () => {
    expect(parseColor('rgb(26, 27, 30)')).toEqual({ r: 26, g: 27, b: 30, a: 1 });
    expect(parseColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor('rgb(10 20 30 / 25%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.25 });
    expect(parseColor('rgba(0, 0, 0, 0)')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor('transparent')?.a).toBe(0);
    expect(parseColor('#c92a2a')).toEqual({ r: 201, g: 42, b: 42, a: 1 });
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('color(srgb 1 0 0 / 0.5)')).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
    expect(parseColor('currentcolor')).toBeNull();
  });

  it('WCAG luminance and contrast', () => {
    expect(luminance(WHITE)).toBeCloseTo(1);
    expect(luminance(BLACK)).toBe(0);
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21);
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21);
    // WCAG's own example pair: #777 on white is just under 4.5:1.
    expect(contrastRatio(parseColor('#777777')!, WHITE)).toBeCloseTo(4.48, 1);
  });
});

describe('the background under a point', () => {
  it('is the topmost opaque background, whatever is underneath', () => {
    expect(pointColor([layer('rgb(26, 27, 30)'), layer('rgb(255, 255, 255)')])).toEqual({ r: 26, g: 27, b: 30 });
  });

  it('skips transparent elements down to the canvas colour', () => {
    expect(pointColor([layer('rgba(0, 0, 0, 0)'), layer('transparent')], { r: 20, g: 20, b: 20 })).toEqual({
      r: 20,
      g: 20,
      b: 20,
    });
  });

  it('composites semi-transparent layers front to back', () => {
    // 50% black over 50% white over red: 0.5·black + 0.25·white + 0.25·red.
    const c = pointColor([layer('rgba(0, 0, 0, 0.5)'), layer('rgba(255, 255, 255, 0.5)'), layer('rgb(255, 0, 0)')])!;
    expect(near(c, { r: 127.5, g: 63.75, b: 63.75 })).toBe(true);
    // A translucent layer over the canvas.
    expect(near(pointColor([layer('rgba(0, 0, 0, 0.25)')], WHITE)!, { r: 191.25, g: 191.25, b: 191.25 })).toBe(true);
  });

  it('is indeterminate where an image shows through, but not where an opaque layer covers it', () => {
    expect(pointColor([layer('rgba(0, 0, 0, 0)', true)])).toBeNull();
    expect(pointColor([layer('rgba(0, 0, 0, 0.5)'), layer('rgba(0, 0, 0, 0)', true)])).toBeNull();
    expect(pointColor([layer('rgb(255, 255, 255)'), layer('rgba(0, 0, 0, 0)', true)])).toEqual(WHITE);
  });

  it('averages the sample points; any indeterminate point makes the rect indeterminate', () => {
    const bg = effectiveBackground([[layer('rgb(0, 0, 0)')], [layer('rgb(255, 255, 255)')]]);
    expect(bg).toMatchObject({ kind: 'color', color: { r: 127.5, g: 127.5, b: 127.5 } });
    expect(effectiveBackground([[layer('rgb(0, 0, 0)')], [layer('transparent', true)]])).toEqual({
      kind: 'indeterminate',
    });
    expect(effectiveBackground([])).toEqual({ kind: 'indeterminate' });
  });
});

describe('the toolbar theme', () => {
  it('is light over dark pages and dark over light ones', () => {
    expect(nextTheme('dark', luminance(parseColor('#1a1b1e')!))).toBe('light');
    expect(nextTheme('light', luminance(parseColor('#f8f9fa')!))).toBe('dark');
    // The red section is dark enough for the light toolbar.
    expect(nextTheme('dark', luminance(parseColor('#c92a2a')!))).toBe('light');
  });

  it('switches only past 0.35 and 0.65 (hysteresis)', () => {
    expect(nextTheme('dark', THEME_LOW)).toBe('light');
    expect(nextTheme('dark', THEME_LOW + 0.01)).toBe('dark');
    expect(nextTheme('light', THEME_HIGH - 0.01)).toBe('light');
    expect(nextTheme('light', THEME_HIGH)).toBe('dark');
    // Wobbling inside the band never flips it.
    let theme = nextTheme('dark', 0.2);
    for (const l of [0.4, 0.6, 0.36, 0.64, 0.5]) theme = nextTheme(theme, l);
    expect(theme).toBe('light');
  });
});

describe('ink', () => {
  const rgb = (hex: string) => parseColor(hex)!;

  it('is red on white and on dark pages', () => {
    expect(pickInk(WHITE)).toBe(DEFAULT_INK);
    expect(pickInk(rgb('#1a1b1e'))).toBe(DEFAULT_INK);
  });

  it('is not red on red, and stands out at least 3:1', () => {
    const red = rgb('#c92a2a');
    const ink = pickInk(red);
    expect(ink).not.toBe(DEFAULT_INK);
    expect(contrastRatio(rgb(ink), red)).toBeGreaterThanOrEqual(INK_CONTRAST);
  });

  it('always stands out 3:1 on any grey, and takes the first palette entry that does', () => {
    for (let v = 0; v <= 255; v += 5) {
      const bg = { r: v, g: v, b: v };
      const ink = pickInk(bg);
      expect(contrastRatio(rgb(ink), bg), `on grey ${v}`).toBeGreaterThanOrEqual(INK_CONTRAST);
      const earlier = INK_PALETTE.slice(0, INK_PALETTE.indexOf(ink as (typeof INK_PALETTE)[number]));
      for (const e of earlier) expect(contrastRatio(rgb(e), bg)).toBeLessThan(INK_CONTRAST);
    }
  });

  it('halo: stands out from the ink, and on a dark page is the light one when both would', () => {
    expect(haloFor('#e03131', rgb('#1a1b1e'))).toBe('#ffffff');
    expect(haloFor('#e03131', WHITE)).toBe('#000000');
    expect(haloFor('#fcc419', rgb('#c92a2a'))).toBe('#000000');
    for (const ink of INK_PALETTE)
      expect(contrastRatio(rgb(haloFor(ink, null)), rgb(ink))).toBeGreaterThanOrEqual(INK_CONTRAST);
  });
});
