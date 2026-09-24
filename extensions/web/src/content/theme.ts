// Adaptive contrast on the page (plan E8; the rules are in packages/core/src/contrast.ts). Reads the page's colour under
// a rect from computed styles (`document.elementsFromPoint`, our own host left out), and keeps the toolbar's theme:
// light over dark pages, dark over light ones, or what the reviewer fixed in its theme setting.
//
// Where the styles cannot tell (an image, a gradient, a video shows through), the toolbar asks the service worker to
// sample a capture: the band around the toolbar, not the toolbar itself. Samples are rare (after a move, a scroll or a
// page change settles, at most one every SAMPLE_EVERY_MS) and share the screenshot queue.
//
// The comment boxes and the Object Select highlight take their theme from the page under them the same way, without
// sampling: where the styles cannot tell, they follow the toolbar.
import {
  type Background,
  effectiveBackground,
  type Layer,
  luminance,
  nextTheme,
  parseColor,
  type Rgb,
  type Theme,
  type ThemeSetting,
  WHITE,
} from '@inkup/core/contrast';
import type { SampleInput } from '@/background/screenshots';

/** How the theme was decided: computed styles, a captured sample, or the reviewer's setting. */
export type ThemeSource = 'style' | 'sample' | 'setting';

const IMAGE_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'SVG', 'IFRAME', 'OBJECT', 'EMBED', 'PICTURE']);
const SETTLE_MS = 250;
const MUTATION_SETTLE_MS = 500;
const SAMPLE_EVERY_MS = 1500;
/** A sample the service worker skipped (a screenshot was just taken) is tried again this many times. */
const SAMPLE_RETRIES = 3;
/** The band around the toolbar that a sample reads, in CSS px. */
const RING = 12;

// One toolbar per page: what it shows now and the reviewer's setting, which the comment boxes and highlight follow.
let toolbarTheme: Theme = 'dark';
let themeSetting: ThemeSetting = 'auto';

function layersAt(x: number, y: number, host: Element): Layer[] {
  if (typeof document.elementsFromPoint !== 'function') return [];
  return document
    .elementsFromPoint(x, y)
    .filter((el) => el !== host && !host.contains(el))
    .map((el) => {
      const cs = getComputedStyle(el);
      return {
        background: cs.backgroundColor,
        image: cs.backgroundImage !== 'none' || IMAGE_TAGS.has(el.tagName.toUpperCase()),
      };
    });
}

/** The page's own canvas: the root's background, else the body's (CSS propagates it), else white. */
function canvasColor(): Rgb {
  for (const el of [document.documentElement, document.body]) {
    const c = el && parseColor(getComputedStyle(el).backgroundColor);
    if (c && c.a > 0)
      return c.a >= 1
        ? c
        : { r: c.r * c.a + 255 * (1 - c.a), g: c.g * c.a + 255 * (1 - c.a), b: c.b * c.a + 255 * (1 - c.a) };
  }
  return WHITE;
}

/** The page under `rect` (viewport px): its centre and four inset corners, kept on screen. */
export function backgroundUnder(rect: DOMRect, host: Element): Background {
  const inset = Math.min(4, rect.width / 4, rect.height / 4);
  const clampX = (x: number) => Math.min(window.innerWidth - 1, Math.max(0, x));
  const clampY = (y: number) => Math.min(window.innerHeight - 1, Math.max(0, y));
  const points = [
    [rect.left + rect.width / 2, rect.top + rect.height / 2],
    [rect.left + inset, rect.top + inset],
    [rect.right - inset, rect.top + inset],
    [rect.left + inset, rect.bottom - inset],
    [rect.right - inset, rect.bottom - inset],
  ].map(([x, y]) => layersAt(clampX(x!), clampY(y!), host));
  return effectiveBackground(points, canvasColor());
}

/** The theme for something of ours over `rect`: the setting when fixed, else the page under it, else the toolbar's. */
export function themeFor(rect: DOMRect, host: Element): Theme {
  if (themeSetting !== 'auto') return themeSetting;
  const bg = backgroundUnder(rect, host);
  return bg.kind === 'color' ? nextTheme(toolbarTheme, bg.luminance) : toolbarTheme;
}

export interface ThemeTarget {
  /** Where the toolbar (or its pill) is now; null while hidden. */
  rect(): DOMRect | null;
  setTheme(theme: Theme, from: ThemeSource, setting: ThemeSetting): void;
}

export interface ThemeDeps {
  host: Element;
  target: ThemeTarget;
  sample(input: SampleInput): Promise<Rgb | null>;
  loadSetting(): Promise<ThemeSetting>;
  watchSetting(cb: (s: ThemeSetting) => void): () => void;
}

/** Keeps the toolbar's theme in step with the page behind it. */
export class ToolbarThemer {
  private theme: Theme = toolbarTheme;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastSample = 0;
  private seq = 0;
  private retries = 0;
  private readonly unwatch: () => void;
  private readonly observer: MutationObserver;
  private destroyed = false;

  constructor(private readonly deps: ThemeDeps) {
    this.unwatch = deps.watchSetting((s) => this.setSetting(s));
    void deps.loadSetting().then((s) => this.setSetting(s));
    window.addEventListener('scroll', this.onSettle, { capture: true, passive: true });
    window.addEventListener('resize', this.onSettle);
    window.addEventListener('popstate', this.onSettle);
    window.addEventListener('hashchange', this.onSettle);
    // A single-page app changing what is under the toolbar. Our own host's changes do not count.
    this.observer = new MutationObserver((records) => {
      if (records.some((r) => r.target !== deps.host && !deps.host.contains(r.target)))
        this.schedule(MUTATION_SETTLE_MS);
    });
    this.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  }

  /** The toolbar moved (dragged, collapsed, placed): look again now. */
  moved(): void {
    this.schedule(0);
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.timer);
    this.unwatch();
    this.observer.disconnect();
    window.removeEventListener('scroll', this.onSettle, { capture: true });
    window.removeEventListener('resize', this.onSettle);
    window.removeEventListener('popstate', this.onSettle);
    window.removeEventListener('hashchange', this.onSettle);
  }

  private onSettle = () => this.schedule(SETTLE_MS);

  private setSetting(s: ThemeSetting) {
    themeSetting = s;
    this.schedule(0);
  }

  private schedule(ms: number, retry = false) {
    if (this.destroyed) return;
    if (!retry) this.retries = 0;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.evaluate(), ms);
  }

  private async evaluate() {
    const seq = ++this.seq;
    if (themeSetting !== 'auto') return this.apply(themeSetting, 'setting');
    const rect = this.deps.target.rect();
    if (!rect || rect.width === 0) return;
    const bg = backgroundUnder(rect, this.deps.host);
    if (bg.kind === 'color') return this.apply(nextTheme(this.theme, bg.luminance), 'style');
    const wait = this.lastSample + SAMPLE_EVERY_MS - Date.now();
    if (wait > 0) return this.schedule(wait, true);
    this.lastSample = Date.now();
    const plain = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    const rgb = await this.deps
      .sample({ rect: plain, viewport: { width: window.innerWidth, height: window.innerHeight }, ring: RING })
      .catch(() => null);
    // A newer look (or a setting) won meanwhile.
    if (seq !== this.seq || this.destroyed || themeSetting !== 'auto') return;
    if (rgb) this.apply(nextTheme(this.theme, luminance(rgb)), 'sample');
    else if (this.retries++ < SAMPLE_RETRIES) this.schedule(SAMPLE_EVERY_MS, true);
  }

  private apply(theme: Theme, from: ThemeSource) {
    this.theme = toolbarTheme = theme;
    this.deps.target.setTheme(theme, from, themeSetting);
  }
}

/** Auto → Light → Dark → Auto. */
export const nextSetting = (s: ThemeSetting): ThemeSetting =>
  s === 'auto' ? 'light' : s === 'light' ? 'dark' : 'auto';
