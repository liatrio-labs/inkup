// The toolbar's viewport control (plan E6): a button in the toolbar's viewport slot showing the size, and a menu with
// the presets, Fit to tab, a W×H you can type, and Reset. The service worker reloads the page into the frame host
// (src/background/viewport.ts); this only asks and shows what it pushes (ToolbarState.viewport). The freeform drag
// handles are the frame host's own, around its frame (src/entrypoints/viewport).
import { clampSize, type Size, sizeLabel, sizeWithScale, VIEWPORT_PRESETS } from '@inkup/core/viewport';
import type { ToolbarViewport } from '@/messaging';

export interface ViewportActions {
  set(size: Size): Promise<{ ok: true } | { ok: false; error: string }>;
  reset(): Promise<unknown>;
}

export const VIEWPORT_CSS = `
.var-vp-menu { all: initial; position: fixed; z-index: 2; box-sizing: border-box; pointer-events: auto;
  font: 500 12px/1.2 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; color: #f4f4f5; }
.var-vp-menu { display: flex; flex-direction: column; gap: 2px; min-width: 200px; padding: 6px; border-radius: 10px; background: #18181b;
  box-shadow: 0 8px 24px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.08); }
.var-vp-menu[hidden] { display: none !important; }
.var-vp-menu button { all: unset; box-sizing: border-box; cursor: pointer; padding: 6px 8px; border-radius: 6px; display: flex; justify-content: space-between; gap: 12px; }
.var-vp-menu button:hover, .var-vp-menu button:focus-visible { background: #3f3f46; }
.var-vp-menu button[aria-checked="true"] { background: #1e3a8a; }
.var-vp-menu .var-vp-dim { color: #a1a1aa; font-variant-numeric: tabular-nums; }
.var-vp-menu .var-vp-row { display: flex; align-items: center; gap: 4px; padding: 4px 8px; }
.var-vp-menu input { all: unset; box-sizing: border-box; width: 58px; padding: 4px 6px; border-radius: 6px; background: #27272a; color: #f4f4f5;
  font-variant-numeric: tabular-nums; }
.var-vp-menu input:focus-visible { outline: 2px solid #60a5fa; }
.var-vp-menu .var-vp-sep { height: 1px; margin: 4px 0; background: #3f3f46; }
.var-vp-menu .var-vp-note { color: #a1a1aa; padding: 2px 8px 4px; max-width: 220px; white-space: normal; line-height: 1.35; }
/* The light theme, with the toolbar's (E8). */
.var-vp-menu[data-theme="light"] { color: #18181b; background: #fafafa; box-shadow: 0 8px 24px rgba(0,0,0,.35), 0 0 0 1px rgba(0,0,0,.12); }
.var-vp-menu[data-theme="light"] button:hover, .var-vp-menu[data-theme="light"] button:focus-visible { background: #e4e4e7; }
.var-vp-menu[data-theme="light"] button[aria-checked="true"] { background: #dbeafe; }
.var-vp-menu[data-theme="light"] .var-vp-dim, .var-vp-menu[data-theme="light"] .var-vp-note { color: #52525b; }
.var-vp-menu[data-theme="light"] input { background: #e4e4e7; color: #18181b; }
.var-vp-menu[data-theme="light"] input:focus-visible { outline-color: #2563eb; }
.var-vp-menu[data-theme="light"] .var-vp-sep { background: #d4d4d8; }
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') e.className = String(v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...children);
  return e;
}

export class ViewportControl {
  /** Goes in the toolbar's viewport slot; the menu is fixed in the overlay root. */
  readonly button: HTMLButtonElement;
  private readonly menu: HTMLElement;
  private state: ToolbarViewport | null = null;

  constructor(
    container: HTMLElement,
    private readonly actions: ViewportActions,
    private readonly fail: (message: string) => void,
  ) {
    this.button = el(
      'button',
      {
        type: 'button',
        'data-testid': 'toolbar-viewport',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        title: 'Viewport size',
      },
      'Viewport',
    );
    this.button.addEventListener('click', () => this.toggleMenu());
    this.menu = el('div', {
      class: 'var-vp-menu',
      role: 'menu',
      'aria-label': 'Viewport size',
      'data-testid': 'viewport-menu',
      hidden: true,
    });
    this.menu.addEventListener('click', this.onMenuClick);
    this.menu.addEventListener('keydown', this.onMenuKey);
    container.append(this.menu);
    document.addEventListener('pointerdown', this.onOutside, true);
    window.addEventListener('resize', this.place);
  }

  update(state: ToolbarViewport | null): void {
    this.state = state;
    this.button.hidden = !state;
    this.button.textContent = state?.current ? sizeWithScale(state.current) : 'Viewport';
    this.button.title = state?.blocked ?? 'Viewport size';
    this.button.dataset.blocked = String(!!state?.blocked);
    if (!state) this.closeMenu();
    else if (!this.menu.hidden) this.renderMenu();
    this.place();
  }

  hideForCapture(hidden: boolean): void {
    this.menu.style.visibility = hidden ? 'hidden' : '';
  }

  /** The toolbar's theme (E8): the menu opens next to it, so it matches. */
  setTheme(theme: 'light' | 'dark'): void {
    this.menu.dataset.theme = theme;
  }

  destroy(): void {
    document.removeEventListener('pointerdown', this.onOutside, true);
    window.removeEventListener('resize', this.place);
    this.menu.remove();
    this.button.remove();
  }

  // ---- the menu ----

  private toggleMenu(): void {
    if (this.menu.hidden) {
      this.renderMenu();
      this.menu.hidden = false;
      this.button.setAttribute('aria-expanded', 'true');
      this.place();
      this.menu.querySelector<HTMLElement>('button')?.focus();
    } else this.closeMenu();
  }

  private closeMenu(): void {
    this.menu.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
  }

  private renderMenu(): void {
    const s = this.state;
    if (!s) return;
    if (s.blocked) {
      this.menu.replaceChildren(el('div', { class: 'var-vp-note', 'data-testid': 'viewport-blocked' }, s.blocked));
      return;
    }
    const cur = s.current;
    const item = (
      action: string,
      label: string,
      dim: string,
      attrs: Record<string, string | boolean | undefined> = {},
    ) =>
      el(
        'button',
        { type: 'button', role: 'menuitemradio', 'data-vp': action, ...attrs },
        el('span', {}, label),
        el('span', { class: 'var-vp-dim' }, dim),
      );
    const is = (size: Size) => !!cur && cur.width === size.width && cur.height === size.height;
    const rows: (Node | string)[] = VIEWPORT_PRESETS.map((p) =>
      item(`preset:${p.width}x${p.height}`, p.label, sizeLabel(p), {
        'data-testid': `viewport-preset-${p.id}`,
        'aria-checked': String(is(p)),
      }),
    );
    if (s.last && !VIEWPORT_PRESETS.some((p) => p.width === s.last!.width && p.height === s.last!.height)) {
      rows.unshift(
        item(`preset:${s.last.width}x${s.last.height}`, 'Last used here', sizeLabel(s.last), {
          'data-testid': 'viewport-last',
          'aria-checked': String(is(s.last)),
        }),
      );
    }
    rows.push(
      item('fit', 'Fit to tab', sizeLabel(s.tab), { 'data-testid': 'viewport-fit', 'aria-checked': String(is(s.tab)) }),
    );
    const typed = cur ?? s.last ?? s.tab;
    const w = el('input', {
      type: 'number',
      inputmode: 'numeric',
      min: '200',
      max: '3840',
      'aria-label': 'Width in CSS px',
      'data-testid': 'viewport-width',
      value: String(typed.width),
    });
    const h = el('input', {
      type: 'number',
      inputmode: 'numeric',
      min: '200',
      max: '2160',
      'aria-label': 'Height in CSS px',
      'data-testid': 'viewport-height',
      value: String(typed.height),
    });
    rows.push(
      el('div', { class: 'var-vp-sep' }),
      el(
        'div',
        { class: 'var-vp-row' },
        w,
        el('span', { class: 'var-vp-dim' }, '×'),
        h,
        el('button', { type: 'button', 'data-vp': 'apply', 'data-testid': 'viewport-apply' }, 'Set'),
      ),
    );
    if (cur)
      rows.push(
        el(
          'button',
          { type: 'button', role: 'menuitem', 'data-vp': 'reset', 'data-testid': 'viewport-reset' },
          el('span', {}, "The tab's own size"),
          el('span', { class: 'var-vp-dim' }, 'Reset'),
        ),
      );
    rows.push(
      el(
        'div',
        { class: 'var-vp-note' },
        'Reloads the page into a frame of this size; drag its edges to resize. Reset gives the tab back.',
      ),
    );
    this.menu.replaceChildren(...rows);
  }

  private onMenuClick = (e: MouseEvent) => {
    const action = (e.target as Element | null)?.closest?.('[data-vp]')?.getAttribute('data-vp');
    const s = this.state;
    if (!action || !s) return;
    if (action.startsWith('preset:')) {
      const [w, h] = action.slice(7).split('x').map(Number);
      return this.apply({ width: w!, height: h! });
    }
    if (action === 'fit') return this.apply(s.tab);
    if (action === 'apply') return this.applyTyped();
    if (action === 'reset') {
      this.closeMenu();
      void this.actions.reset().catch((err: unknown) => this.fail(String(err)));
    }
  };

  private onMenuKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      this.closeMenu();
      this.button.focus();
    } else if (e.key === 'Enter' && (e.target as Element | null)?.tagName === 'INPUT') this.applyTyped();
  };

  private applyTyped(): void {
    const value = (id: string) => Number(this.menu.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)?.value);
    this.apply({ width: value('viewport-width'), height: value('viewport-height') });
  }

  private apply(size: Size): void {
    this.closeMenu();
    void this.actions
      .set(clampSize(size))
      .then((r) => {
        if (!r.ok) this.fail(r.error);
      })
      .catch((err: unknown) => this.fail(String(err)));
  }

  private onOutside = (e: PointerEvent) => {
    if (this.menu.hidden) return;
    const path = e.composedPath();
    if (!path.includes(this.menu) && !path.includes(this.button)) this.closeMenu();
  };

  // ---- placement ----

  private place = () => {
    if (this.menu.hidden) return;
    const b = this.button.getBoundingClientRect();
    const m = this.menu.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || innerWidth;
    const left = Math.max(8, Math.min(b.left, vw - m.width - 8));
    const above = b.top - m.height - 6;
    Object.assign(this.menu.style, {
      left: `${left}px`,
      top: `${above >= 8 ? above : Math.min(b.bottom + 6, innerHeight - m.height - 8)}px`,
    });
  };
}
