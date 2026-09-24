// Adaptive contrast (plan E8): what colour the page is behind a rect, read from computed styles, and what follows from
// it: the toolbar's light or dark theme (with hysteresis, so it does not flicker at the edge of a section) and each
// Stroke's ink colour, the first of a small palette that stands out at least 3:1 against the page.
//
// The page is read without screenshots: at each sample point the content script lists the elements there, topmost
// first (`document.elementsFromPoint`), each as its computed background colour and whether it paints an image
// (a background image or gradient, <img>, <video>, <canvas>…). Colours are composited front to back, with alpha,
// down to the canvas colour. An image that shows through makes the point indeterminate: the caller then samples a
// screenshot instead.

export interface Rgb {
  r: number;
  g: number;
  b: number;
}
export interface Rgba extends Rgb {
  /** 0–1 */
  a: number;
}

/** One element at a sample point, as its computed style paints it. */
export interface Layer {
  /** Computed `background-color`. */
  background: string;
  /** It paints an image (background image or gradient, img, video, canvas, svg, iframe…): its colour is unknown. */
  image: boolean;
}

export type Background = { kind: 'color'; color: Rgb; luminance: number } | { kind: 'indeterminate' };

export const WHITE: Rgb = { r: 255, g: 255, b: 255 };
export const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** Coverage left below which the layers underneath no longer matter. */
const OPAQUE = 0.01;

/**
 * A computed colour: `rgb()`/`rgba()` with commas or spaces and an optional `/ alpha`, `#rgb`/`#rrggbb`/`#rrggbbaa`,
 * `transparent`, or `color(srgb r g b / a)` (0–1 channels). Null for anything else.
 */
export function parseColor(css: string): Rgba | null {
  const s = css.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(s)?.[1];
  if (hex && [3, 6, 8].includes(hex.length)) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 };
  }
  const alpha = (v: string | undefined) =>
    v === undefined ? 1 : v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v);
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (rgb) return { r: +rgb[1]!, g: +rgb[2]!, b: +rgb[3]!, a: alpha(rgb[4]) };
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (srgb) return { r: +srgb[1]! * 255, g: +srgb[2]! * 255, b: +srgb[3]! * 255, a: alpha(srgb[4]) };
  return null;
}

/** `top` painted over an opaque `bottom`. */
export function over(top: Rgba, bottom: Rgb): Rgb {
  const mix = (t: number, b: number) => t * top.a + b * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b) };
}

/** WCAG 2 relative luminance, 0 (black) to 1 (white). */
export function luminance(c: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** What one sample point shows: its layers composited front to back over the canvas, or null over an image. */
export function pointColor(layers: readonly Layer[], canvas: Rgb = WHITE): Rgb | null {
  let acc = { r: 0, g: 0, b: 0 };
  let left = 1;
  for (const layer of layers) {
    if (left < OPAQUE) break;
    if (layer.image) return null;
    const c = parseColor(layer.background);
    if (!c || c.a <= 0) continue;
    acc = { r: acc.r + c.r * c.a * left, g: acc.g + c.g * c.a * left, b: acc.b + c.b * c.a * left };
    left *= 1 - c.a;
  }
  return { r: acc.r + canvas.r * left, g: acc.g + canvas.g * left, b: acc.b + canvas.b * left };
}

/** The background under a rect from its sample points (each a stack, topmost first): their mean, or indeterminate. */
export function effectiveBackground(points: readonly (readonly Layer[])[], canvas: Rgb = WHITE): Background {
  const colors = points.map((layers) => pointColor(layers, canvas));
  if (colors.length === 0 || colors.some((c) => c === null)) return { kind: 'indeterminate' };
  return solid(mean(colors as Rgb[]));
}

export const solid = (color: Rgb): Background & { kind: 'color' } => ({
  kind: 'color',
  color,
  luminance: luminance(color),
});

export const mean = (colors: readonly Rgb[]): Rgb => ({
  r: colors.reduce((s, c) => s + c.r, 0) / colors.length,
  g: colors.reduce((s, c) => s + c.g, 0) / colors.length,
  b: colors.reduce((s, c) => s + c.b, 0) / colors.length,
});

// ---- the toolbar's theme ----

/** The toolbar's own look: 'light' (light surfaces, for dark pages) or 'dark' (for light pages). */
export type Theme = 'light' | 'dark';
export type ThemeSetting = 'auto' | Theme;

/** A page darker than this gets the light toolbar; lighter than THEME_HIGH, the dark one. Between: no change. */
export const THEME_LOW = 0.35;
export const THEME_HIGH = 0.65;

/** The theme for a page luminance, keeping `current` inside the band between the thresholds (hysteresis). */
export function nextTheme(current: Theme, pageLuminance: number): Theme {
  if (pageLuminance <= THEME_LOW) return 'light';
  if (pageLuminance >= THEME_HIGH) return 'dark';
  return current;
}

// ---- ink ----

/** The Stroke palette, in order of preference: red first (the default ink), then yellow, cyan, magenta, white, black. */
export const INK_PALETTE = ['#e03131', '#fcc419', '#22b8cf', '#e64980', '#ffffff', '#000000'] as const;
export const DEFAULT_INK = INK_PALETTE[0];
/** WCAG's floor for graphics: a Stroke must stand out at least this much against the page. */
export const INK_CONTRAST = 3;

const hexRgb = (hex: string): Rgb => parseColor(hex)!;
export const toHex = (c: Rgb) =>
  `#${[c.r, c.g, c.b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

/** The Stroke's colour on `bg`: the first palette entry with at least 3:1 contrast, else the one with the most. */
export function pickInk(bg: Rgb): string {
  const ok = INK_PALETTE.find((hex) => contrastRatio(hexRgb(hex), bg) >= INK_CONTRAST);
  return ok ?? [...INK_PALETTE].sort((a, b) => contrastRatio(hexRgb(b), bg) - contrastRatio(hexRgb(a), bg))[0]!;
}

/**
 * The thin outline around a Stroke: black or white, whichever stands out from the ink by 3:1 (both may), and of
 * those the one further from the page (so red ink gets a white halo on a dark page and a black one on a light page).
 * Unknown page: the one further from the ink.
 */
export function haloFor(ink: string, bg: Rgb | null): '#000000' | '#ffffff' {
  const c = hexRgb(ink);
  const both = [
    { hex: '#000000' as const, rgb: BLACK },
    { hex: '#ffffff' as const, rgb: WHITE },
  ];
  const fits = both.filter((h) => contrastRatio(h.rgb, c) >= INK_CONTRAST);
  if (bg && fits.length > 1) return fits.sort((a, b) => contrastRatio(b.rgb, bg) - contrastRatio(a.rgb, bg))[0]!.hex;
  return (fits.length === 1 ? fits : both.sort((a, b) => contrastRatio(b.rgb, c) - contrastRatio(a.rgb, c)))[0]!.hex;
}
