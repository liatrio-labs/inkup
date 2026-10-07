// The theme against DESIGN.md (R1.2, R1.3): every palette variable equals its DESIGN.md colour in light and dark,
// shadcn's variables map onto them, every text pair is at least 4.5:1, and data-theme on a shadow host flips the scheme.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toShadowCss } from '../src/mount-in-shadow';
import shadowCss from '../src/styles/shadow.css?inline';

const ROOT = join(__dirname, '../../..');
const THEME = readFileSync(join(__dirname, '../src/styles/theme.css'), 'utf8');

/** DESIGN.md's frontmatter group (`colors:` or `rounded:`) as name → value. */
function designGroup(group: string): Record<string, string> {
  const front = readFileSync(join(ROOT, 'DESIGN.md'), 'utf8').split('---')[1] ?? '';
  const body = new RegExp(`^${group}:\\n((?:  .*\\n)+)`, 'm').exec(front)?.[1] ?? '';
  return Object.fromEntries([...body.matchAll(/^ {2}([\w-]+): "(.*)"$/gm)].map((m) => [m[1], m[2]]));
}
const COLORS = designGroup('colors');
const ROUNDED = designGroup('rounded');

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
const DARK_BY_MEDIA = block(
  THEME.slice(THEME.indexOf('@media (prefers-color-scheme: dark)')),
  ':root:not([data-theme="light"])',
);
const DARK_BY_ATTR = block(THEME, ':root[data-theme="dark"]');
const scheme = (mode: 'light' | 'dark') => (mode === 'light' ? LIGHT : { ...LIGHT, ...DARK_BY_ATTR });

/** A variable resolved through its var() chain in one scheme. */
function resolve(vars: Record<string, string>, name: string): string {
  const value = vars[name];
  if (value === undefined) throw new Error(`${name} is not set`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  return ref ? resolve(vars, ref[1] as string) : value;
}

// ---- colour maths (WCAG 2.x) ----
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

describe('theme.css against DESIGN.md', () => {
  // Theme variable → DESIGN.md colour. DESIGN.md's `muted` is a text colour; shadcn's --muted is a ground, so the
  // palette names it --ink-muted.
  const PALETTE: Record<string, string> = {
    '--ink': 'ink',
    '--ink-2': 'ink-2',
    '--ink-muted': 'muted',
    '--paper': 'paper',
    '--paper-2': 'paper-2',
    '--paper-3': 'paper-3',
    '--hairline': 'hairline',
    '--guide': 'guide',
    '--pen': 'pen',
    '--pen-ink': 'pen-ink',
    '--on-ink': 'on-ink',
    '--done': 'done',
    '--working': 'working',
    '--box-content': 'box-content',
  };

  it.each(Object.entries(PALETTE))('%s is DESIGN.md %s, light and dark', (variable, colour) => {
    expect(COLORS[colour]).toBeDefined();
    expect(resolve(scheme('light'), variable)).toBe(COLORS[colour]);
    expect(resolve(scheme('dark'), variable)).toBe(COLORS[`${colour}-dark`]);
  });

  it("maps shadcn's variables onto the palette", () => {
    const light = scheme('light');
    const dark = scheme('dark');
    expect(resolve(light, '--background')).toBe(COLORS.paper);
    expect(resolve(light, '--foreground')).toBe(COLORS.ink);
    expect(resolve(light, '--primary')).toBe(COLORS.ink);
    expect(resolve(light, '--primary-foreground')).toBe(COLORS['on-ink']);
    expect(resolve(light, '--muted-foreground')).toBe(COLORS.muted);
    expect(resolve(light, '--border')).toBe(COLORS.hairline);
    expect(resolve(light, '--ring')).toBe(COLORS.ink);
    // Destructive is error text as well as a fill, so light uses pen-ink, the red that passes AA as text.
    expect(resolve(light, '--destructive')).toBe(COLORS['pen-ink']);
    expect(resolve(dark, '--background')).toBe(COLORS['paper-dark']);
    expect(resolve(dark, '--foreground')).toBe(COLORS['ink-dark']);
    expect(resolve(dark, '--primary')).toBe(COLORS['ink-dark']);
    expect(resolve(dark, '--destructive')).toBe(COLORS['pen-dark']);
    expect(resolve(dark, '--border')).toBe(COLORS['hairline-dark']);
  });

  it('takes its radii from DESIGN.md rounded', () => {
    expect(LIGHT['--radius']).toBe(ROUNDED.m);
    const px = (v: string | undefined) => Number.parseFloat(v ?? 'NaN');
    // @theme inline: radius-sm = radius - 4px, radius-lg = radius, radius-xl = radius + 4px.
    expect(px(ROUNDED.m) - 4).toBe(px(ROUNDED.s));
    expect(px(ROUNDED.m) + 4).toBe(px(ROUNDED.l));
    expect(THEME).toContain('--radius-sm: calc(var(--radius) - 4px);');
    expect(THEME).toContain('--radius-xl: calc(var(--radius) + 4px);');
    expect(THEME).toContain(`--radius-tag: ${ROUNDED.tag};`);
    expect(THEME).toContain(`--radius-pill: ${ROUNDED.pill};`);
  });

  it('writes the dark block the same way for the media query and for data-theme', () => {
    expect(DARK_BY_MEDIA).toEqual(DARK_BY_ATTR);
  });

  // Every text colour the primitives and pages put on a ground. `white` on destructive is the destructive button
  // (`bg-destructive text-white`, and `dark:bg-destructive/60` over the page in dark).
  const PAIRS: [fg: string, bg: string][] = [
    ['--foreground', '--background'],
    ['--card-foreground', '--card'],
    ['--popover-foreground', '--popover'],
    ['--primary-foreground', '--primary'],
    ['--secondary-foreground', '--secondary'],
    ['--muted-foreground', '--muted'],
    ['--muted-foreground', '--background'],
    ['--muted-foreground', '--card'],
    ['--accent-foreground', '--accent'],
    ['--destructive', '--background'],
    ['--destructive', '--card'],
    ['white', '--destructive'],
    ['--done', '--background'],
    ['--done', '--card'],
    ['--working', '--background'],
    ['--working', '--card'],
    ['--foreground', '--muted'],
  ];

  for (const mode of ['light', 'dark'] as const) {
    it.each(PAIRS)(`${mode}: %s on %s is at least 4.5:1`, (fg, bg) => {
      const vars = scheme(mode);
      const ground = parse(resolve(vars, '--background'));
      let back = over(parse(resolve(vars, bg)), ground);
      if (fg === 'white' && mode === 'dark') back = over([...back.slice(0, 3), 0.6] as RGBA, ground);
      const text = fg === 'white' ? parse('#ffffff') : over(parse(resolve(vars, fg)), back);
      const ratio = contrast(text, back);
      expect(ratio, `${mode} ${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('the scheme switch (R1.3)', () => {
  const css = toShadowCss(shadowCss);

  it('puts the light theme on :host, and dark on :host by data-theme and by the media query', () => {
    expect(block(css, ':host')['--background']).toBe('var(--paper)');
    expect(block(css, ':host([data-theme="dark"])')['--paper']).toBe(COLORS['paper-dark']);
    expect(block(css, ':host([data-theme="dark"])')['--ink']).toBe(COLORS['ink-dark']);
    const media = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
    expect(block(media, ':host(:not([data-theme="light"]))')['--paper']).toBe(COLORS['paper-dark']);
  });

  it('lets data-theme win over the system: the dark variant matches data-theme="dark" and skips data-theme="light"', () => {
    // A `dark:` utility, as compiled into the shadow sheet.
    expect(css).toMatch(/:where\(:host\(\[data-theme="dark"\]\) \*\)/);
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*[^{]*:where\(:host\(:not\(\[data-theme="light"\]\)\) \*\)/,
    );
    // And the pages' variant, before the rewrite.
    expect(THEME).toContain('&:where(:root[data-theme="dark"] *)');
    expect(THEME).toContain('&:where(:root:not([data-theme="light"]) *)');
  });

  it('flips a shadow host to dark with data-theme="dark" and back to light with data-theme="light"', () => {
    // happy-dom matches :host(...) from an adopted sheet against the host. The media query is renamed to one that
    // never matches, so this is the system-light case; a real browser in each scheme is in the T01 proofs.
    const el = document.createElement('div');
    document.body.append(el);
    const root = el.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      toShadowCss(
        THEME.slice(THEME.indexOf(':root {'), THEME.indexOf('@theme inline')).replace(/@media[^{]*\{/, '@media (x) {'),
      ),
    );
    root.adoptedStyleSheets = [sheet];
    const paper = () => getComputedStyle(el).getPropertyValue('--paper').trim();

    expect(paper()).toBe(COLORS.paper);
    el.dataset.theme = 'dark';
    expect(paper()).toBe(COLORS['paper-dark']);
    el.dataset.theme = 'light';
    expect(paper()).toBe(COLORS.paper);
    el.remove();
  });
});
