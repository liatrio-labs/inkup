// The [data-island] blocks in shadow.css hand-copy theme.css's light and dark palettes (the comment box, draw note and
// highlight take the theme of the page under them, ADR 0011). Hold every copied property to the value theme.css gives
// it for the same scheme, so a palette change in theme.css cannot drift past the islands silently.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const STYLES = join(__dirname, '../src/styles');
const THEME = readFileSync(join(STYLES, 'theme.css'), 'utf8');
const SHADOW = readFileSync(join(STYLES, 'shadow.css'), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector` (comments stripped), as name → value. */
function block(css: string, selector: string): Record<string, string> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const at = new RegExp(`(?:^|\\n)\\s*${escaped} \\{`).exec(clean)?.index ?? -1;
  if (at < 0) throw new Error(`no rule for ${selector}`);
  const body = clean.slice(clean.indexOf('{', at) + 1, clean.indexOf('}', at));
  const entries = body
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map(
      (d) =>
        [
          d.slice(0, d.indexOf(':')).trim(),
          d
            .slice(d.indexOf(':') + 1)
            .trim()
            .replace(/\s+/g, ' '),
        ] as const,
    );
  return Object.fromEntries(entries);
}

// The palette theme.css gives each scheme: the dark block overrides `:root`, and anything it leaves alone (such as
// --muted-foreground) is inherited from the light one.
const LIGHT = block(THEME, ':root');
const DARK = { ...LIGHT, ...block(THEME, ':root[data-theme="dark"]') };
const PALETTE = { light: LIGHT, dark: DARK } as const;

describe('shadow.css [data-island] palettes', () => {
  for (const mode of ['light', 'dark'] as const) {
    describe(mode, () => {
      const island = block(SHADOW, `[data-island][data-theme="${mode}"]`);
      const palette = PALETTE[mode];

      it('declares the colour scheme and a palette to compare', () => {
        expect(island['color-scheme']).toBe(mode);
        expect(Object.keys(island).filter((p) => p.startsWith('--')).length).toBeGreaterThan(5);
      });

      it('copies no property theme.css does not define', () => {
        const unknown = Object.keys(island).filter((p) => !(p in palette));
        expect(unknown).toEqual([]);
      });

      it("matches theme.css's value for every custom property", () => {
        const custom = Object.entries(island).filter(([p]) => p.startsWith('--'));
        const drift = custom
          .filter(([p, v]) => palette[p] !== v)
          .map(([p, v]) => `${p}: island ${v}, theme.css ${palette[p]}`);
        expect(drift).toEqual([]);
      });
    });
  }
});
