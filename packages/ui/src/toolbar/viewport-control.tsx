// The toolbar's viewport control (plan E6): a button in the toolbar's viewport slot showing the size, and a menu with
// the presets, Fit to tab, a W×H you can type, and Reset. The capture surface resizes the page (the extension reloads
// it into its frame host, src/background/viewport.ts); this only asks and shows what is pushed (ToolbarState.viewport).
// The freeform drag handles are the frame host's own, around its frame (extensions/web/src/entrypoints/viewport).
import { clampSize, type Size, sizeLabel, sizeWithScale, VIEWPORT_PRESETS } from '@inkup/core/viewport';
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import type { ToolbarTheme, ToolbarViewport, ViewportActions } from '../toolbar-state';

export interface ViewportControlProps {
  /** What is pushed; null hides the control (no mechanism can resize this page). */
  viewport: ToolbarViewport | null;
  actions: ViewportActions;
  /** Says why a request failed (the toolbar's notice). */
  onError(message: string): void;
  /** The toolbar's theme (E8): the menu opens next to it, so it matches. */
  theme?: ToolbarTheme;
  /** The trigger's classes: the toolbar styles it as one of its own buttons. */
  buttonClassName?: string;
}

const MENU_ITEM =
  'flex cursor-pointer items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-solid focus-visible:outline-ring aria-checked:bg-box-content';
const DIM = 'text-muted-foreground tabular-nums';
const FIELD =
  'w-[4.25rem] rounded-sm border border-input bg-background px-1.5 py-1 text-foreground tabular-nums focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-ring';

export function ViewportControl({ viewport, actions, onError, theme, buttonClassName }: ViewportControlProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const width = useRef<HTMLInputElement>(null);
  const height = useRef<HTMLInputElement>(null);

  const close = useCallback(() => setOpen(false), []);

  // Next to the button: above it when there is room, else below, always on screen.
  const place = useCallback(() => {
    const m = menu.current;
    const b = button.current;
    if (!m || !b || m.hidden) return;
    const br = b.getBoundingClientRect();
    const mr = m.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || innerWidth;
    const left = Math.max(8, Math.min(br.left, vw - mr.width - 8));
    const above = br.top - mr.height - 6;
    m.style.left = `${left}px`;
    m.style.top = `${above >= 8 ? above : Math.min(br.bottom + 6, innerHeight - mr.height - 8)}px`;
  }, []);

  // Closed when the control goes away; placed after every render while open.
  useLayoutEffect(() => {
    if (!viewport && open) setOpen(false);
    else place();
  });

  // On open, the keyboard goes to the first item.
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('button')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: PointerEvent) => {
      const path = e.composedPath();
      if (!path.includes(menu.current!) && !path.includes(button.current!)) close();
    };
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('resize', place);
    };
  }, [open, close, place]);

  const apply = (size: Size) => {
    close();
    void actions
      .set(clampSize(size))
      .then((r) => {
        if (!r.ok) onError(r.error);
      })
      .catch((err: unknown) => onError(String(err)));
  };
  const applyTyped = () => apply({ width: Number(width.current?.value), height: Number(height.current?.value) });
  const reset = () => {
    close();
    void actions.reset().catch((err: unknown) => onError(String(err)));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      close();
      button.current?.focus();
    } else if (e.key === 'Enter' && (e.target as Element).tagName === 'INPUT') applyTyped();
  };

  const s = viewport;
  const cur = s?.current ?? null;
  const is = (size: Size) => !!cur && cur.width === size.width && cur.height === size.height;
  const item = (key: string, onPick: () => void, label: string, dim: string, testId: string, checked: boolean) => (
    <button
      key={key}
      type="button"
      role="menuitemradio"
      data-vp={key}
      data-testid={testId}
      aria-checked={String(checked) as 'true' | 'false'}
      className={MENU_ITEM}
      onClick={onPick}
    >
      <span>{label}</span>
      <span className={DIM}>{dim}</span>
    </button>
  );

  let body: ReactNode = null;
  if (s?.blocked) {
    body = (
      <div className="max-w-56 px-2 pt-0.5 pb-1 whitespace-normal text-muted-foreground" data-testid="viewport-blocked">
        {s.blocked}
      </div>
    );
  } else if (s) {
    const last = s.last;
    const typed = cur ?? last ?? s.tab;
    body = (
      <>
        {last && !VIEWPORT_PRESETS.some((p) => p.width === last.width && p.height === last.height)
          ? item(
              `preset:${last.width}x${last.height}`,
              () => apply(last),
              'Last used here',
              sizeLabel(last),
              'viewport-last',
              is(last),
            )
          : null}
        {VIEWPORT_PRESETS.map((p) =>
          item(
            `preset:${p.width}x${p.height}`,
            () => apply(p),
            p.label,
            sizeLabel(p),
            `viewport-preset-${p.id}`,
            is(p),
          ),
        )}
        {item('fit', () => apply(s.tab), 'Fit to tab', sizeLabel(s.tab), 'viewport-fit', is(s.tab))}
        <div className="my-1 h-px bg-border" />
        <div className="flex items-center gap-1 px-2 py-1" key={`${typed.width}x${typed.height}`}>
          <input
            ref={width}
            type="number"
            inputMode="numeric"
            min={200}
            max={3840}
            aria-label="Width in CSS px"
            data-testid="viewport-width"
            defaultValue={String(typed.width)}
            className={FIELD}
          />
          <span className={DIM}>×</span>
          <input
            ref={height}
            type="number"
            inputMode="numeric"
            min={200}
            max={2160}
            aria-label="Height in CSS px"
            data-testid="viewport-height"
            defaultValue={String(typed.height)}
            className={FIELD}
          />
          <button
            type="button"
            data-vp="apply"
            data-testid="viewport-apply"
            className={cn(MENU_ITEM, 'font-semibold')}
            onClick={applyTyped}
          >
            Set
          </button>
        </div>
        {cur ? (
          <button
            type="button"
            role="menuitem"
            data-vp="reset"
            data-testid="viewport-reset"
            className={MENU_ITEM}
            onClick={reset}
          >
            <span>The tab's own size</span>
            <span className={DIM}>Reset</span>
          </button>
        ) : null}
        <div className="max-w-56 px-2 pt-0.5 pb-1 leading-snug whitespace-normal text-muted-foreground">
          Reloads the page into a frame of this size; drag its edges to resize. Reset gives the tab back.
        </div>
      </>
    );
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        data-testid="toolbar-viewport"
        aria-haspopup="menu"
        aria-expanded={open}
        title={s?.blocked ?? 'Viewport size'}
        data-blocked={String(!!s?.blocked)}
        hidden={!s}
        className={cn('tabular-nums', buttonClassName)}
        onClick={() => setOpen((o) => !o)}
      >
        {cur ? sizeWithScale(cur) : 'Viewport'}
      </button>
      <div
        ref={menu}
        role="menu"
        aria-label="Viewport size"
        data-testid="viewport-menu"
        data-theme={theme}
        hidden={!open || !s}
        onKeyDown={onKeyDown}
        className="pointer-events-auto fixed z-[2] flex min-w-52 flex-col gap-0.5 rounded-lg border border-border bg-popover p-1.5 font-sans text-xs leading-tight font-medium whitespace-nowrap text-popover-foreground shadow-[0_1px_2px_rgb(31_42_68/0.08),0_8px_24px_-8px_rgb(31_42_68/0.18)] select-none"
      >
        {open ? body : null}
      </div>
    </>
  );
}
