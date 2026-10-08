// The status tones (src/product/tone.ts, resolution-style.ts, vetting-style.ts) against the theme (R1.3): every colour
// they use is a DESIGN.md token from theme.css, never a stock Tailwind hue or a hex, and every text colour is at least
// 4.5:1 on what is behind it in light and dark: its own fill when it has one, else the page, a card and a muted well.
// tests/e2e/dark-mode.spec.ts measures the same pairs in a browser.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RESOLUTION_STYLE, RESOLUTION_TEXT } from '../src/product/resolution-style';
import { TONE } from '../src/product/tone';
import { VETTING_STYLE } from '../src/product/vetting-style';

const THEME = readFileSync(join(__dirname, '../src/styles/theme.css'), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector` (comments stripped). */
function block(css: string, selector: string): Record<string, string> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const at = new RegExp(`(?:^|\\n)\\s*${escaped} \\{`).exec(clean)?.index ?? -1;
  if (at < 0) throw new Error(`no rule for ${selector}`);
  const body = clean.slice(clean.indexOf('{', at) + 1, clean.indexOf('}', at));
  return Object.fromEntries(
    body
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]),
  );
}

const LIGHT = block(THEME, ':root');
const SCHEMES = { light: LIGHT, dark: { ...LIGHT, ...block(THEME, ':root[data-theme="dark"]') } } as const;
/** Tailwind colour name → the theme variable behind it, from `@theme inline` (`--color-done: var(--done)`). */
const COLOR_VARS: Record<string, string> = Object.fromEntries(
  Object.entries(block(THEME, '@theme inline'))
    .filter(([k]) => k.startsWith('--color-'))
    .map(([k, v]) => [k.slice('--color-'.length), /^var\((--[\w-]+)\)$/.exec(v)?.[1] ?? v]),
);

function resolve(vars: Record<string, string>, name: string): string {
  const value = vars[name];
  if (value === undefined) throw new Error(`${name} is not set`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  return ref ? resolve(vars, ref[1] as string) : value;
}

// ---- colour maths (WCAG 2.x), as tests/theme.test.ts ----
type RGBA = [number, number, number, number];
function parse(color: string): RGBA {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const n = Number.parseInt(hex[1] as string, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(color);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
  throw new Error(`cannot parse ${color}`);
}
const over = ([r, g, b, a]: RGBA, [R, G, B]: RGBA): RGBA => [
  r * a + R * (1 - a),
  g * a + G * (1 - a),
  b * a + B * (1 - a),
  1,
];
function luminance([r, g, b]: RGBA): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(fg: RGBA, bg: RGBA): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** A tone's colour utilities: `text-done`, `bg-muted-foreground/50`, `dark:border-guide` → kind, token, alpha. */
interface Use {
  kind: 'text' | 'bg' | 'border';
  token: string;
  alpha: number;
  raw: string;
}
function uses(classes: string): Use[] {
  return classes.split(/\s+/).flatMap((raw) => {
    const m = /^(?:dark:)?(text|bg|border)-(.+?)(?:\/(\d+))?$/.exec(raw);
    if (!m || !((m[2] as string) in COLOR_VARS)) return [];
    return [{ kind: m[1] as Use['kind'], token: m[2] as string, alpha: m[3] ? Number(m[3]) / 100 : 1, raw }];
  });
}

/** The colour a utility paints in `mode`, over `ground`. */
function paint(use: Use, mode: keyof typeof SCHEMES, ground: RGBA): RGBA {
  const [r, g, b, a] = parse(resolve(SCHEMES[mode], COLOR_VARS[use.token] as string));
  return over([r, g, b, a * use.alpha], ground);
}

const ALL: [string, string][] = [
  ...Object.entries(TONE).map(([k, v]) => [`TONE.${k}`, v] as [string, string]),
  ...Object.entries(RESOLUTION_STYLE).map(([k, v]) => [`RESOLUTION_STYLE.${k}`, v] as [string, string]),
  ...Object.entries(RESOLUTION_TEXT).map(([k, v]) => [`RESOLUTION_TEXT.${k}`, v] as [string, string]),
  ...Object.entries(VETTING_STYLE).map(([k, v]) => [`VETTING_STYLE.${k}`, v] as [string, string]),
];
/** Where a tone without a fill of its own sits: the page, a card, a muted well. */
const GROUNDS = ['background', 'card', 'muted'] as const;

describe('the status tones', () => {
  it('reads the theme', () => {
    expect(COLOR_VARS.done).toBe('--done');
    expect(COLOR_VARS['pen-ink']).toBe('--pen-ink');
    expect(uses('border-l-2 border-working pl-2 text-foreground bg-muted-foreground/50').map((u) => u.raw)).toEqual([
      'border-working',
      'text-foreground',
      'bg-muted-foreground/50',
    ]);
  });

  it.each(ALL)('%s paints only with DESIGN.md tokens', (_name, classes) => {
    const colours = classes
      .split(/\s+/)
      .filter((c) => /^(?:dark:)?(?:text|bg|border)-/.test(c))
      .filter((c) => !/^(?:dark:)?(?:text-(?:xs|sm|base|lg|xl)|border-[lrtbxy]?-?\d*)$/.test(c));
    const stray = colours.filter((c) => !uses(c).length);
    expect(stray, 'stock Tailwind hues, hex or unknown colours').toEqual([]);
    expect(classes).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:white|black)\b/i);
  });

  for (const mode of ['light', 'dark'] as const) {
    it.each(ALL.filter(([, c]) => uses(c).some((u) => u.kind === 'text')))(
      `${mode}: %s text is at least 4.5:1 on its ground`,
      (name, classes) => {
        const all = uses(classes);
        const text = all.find((u) => u.kind === 'text') as Use;
        const fill = all.find((u) => u.kind === 'bg');
        for (const ground of GROUNDS) {
          const page = parse(resolve(SCHEMES[mode], '--background'));
          const under = over(parse(resolve(SCHEMES[mode], `--${ground}`)), page);
          const back = fill ? paint(fill, mode, under) : under;
          const ratio = contrast(paint(text, mode, back), back);
          expect(ratio, `${mode} ${name} on ${fill?.raw ?? ground}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        }
      },
    );

    it(`${mode}: the connected dot is at least 3:1 on the page (a non-text mark)`, () => {
      const page = parse(resolve(SCHEMES[mode], '--background'));
      const dot = uses(TONE.okDot)[0] as Use;
      expect(contrast(paint(dot, mode, page), page)).toBeGreaterThanOrEqual(3);
    });
  }

  it('gives each Resolution its DESIGN.md status hue: In work amber, Done green, the rest muted or the pen', () => {
    expect(RESOLUTION_TEXT.in_progress).toBe('text-working');
    expect(RESOLUTION_TEXT.resolved).toBe('text-done');
    expect(RESOLUTION_STYLE.in_progress).toContain('border-working');
    expect(RESOLUTION_STYLE.resolved).toContain('border-done');
    expect(RESOLUTION_STYLE.wont_fix).toContain('bg-muted');
    // Red pen is a mark, never a fill (DESIGN.md "The Red Pen Rule").
    for (const [, classes] of ALL) expect(classes).not.toMatch(/\bbg-pen/);
  });
});
