// The toolbar's microphone picker: a chevron split from Mute during a Session (beside Start before one) and a menu of
// "System default" and each audio input, the one in use checked. The capture surface owns the microphone and its
// device list (the extension's media context, never the page: the page has other permissions and other deviceIds);
// this only shows what is pushed (ToolbarState.mic) and asks (MicActions). Before a Session nobody holds the list, so
// opening the menu asks for it. Without the microphone grant the menu says so and offers setup instead of a list of
// unnamed inputs. The menu is our own, like the viewport control's: it lives in the overlay's shadow root.
import { type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import type { MicActions, ToolbarMic, ToolbarMicDevice, ToolbarTheme } from '../toolbar-state';

export interface MicPickerProps {
  /** What is pushed; null hides the picker. */
  mic: ToolbarMic | null;
  actions: MicActions;
  /** Says why a request failed (the toolbar's notice). */
  onError(message: string): void;
  /** Opens setup, where the microphone is allowed. */
  onSetup(): void;
  /** The toolbar's theme (E8): the menu opens next to it, so it matches. */
  theme?: ToolbarTheme;
  /** The trigger's classes: the toolbar styles it as one of its own buttons. */
  buttonClassName?: string;
  disabled?: boolean;
}

const MENU_ITEM =
  'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-solid focus-visible:outline-ring';
const NOTE = 'max-w-60 px-2 pt-0.5 pb-1 leading-snug whitespace-normal text-muted-foreground';
const CHEVRON = 'M6 9l6 6 6-6';
const CHECK = 'M5 12l5 5 9-10';

const ITEMS = '[role="menuitemradio"],[role="menuitem"]';

export function MicPicker({ mic, actions, onError, onSetup, theme, buttonClassName, disabled }: MicPickerProps) {
  const [open, setOpen] = useState(false);
  /** The inputs listed when the menu opened (before a Session); undefined while listing. */
  const [listed, setListed] = useState<ToolbarMicDevice[] | null | undefined>(undefined);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const opening = useRef(0);

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

  useLayoutEffect(() => {
    if ((!mic || disabled) && open) setOpen(false);
    else place();
  });

  // Opened: list the inputs where nothing pushed them (before a Session).
  useEffect(() => {
    if (!open || !mic?.granted || mic.devices) return;
    const n = ++opening.current;
    setListed(undefined);
    actions.list().then(
      (d) => n === opening.current && setListed(d),
      () => n === opening.current && setListed(null),
    );
  }, [open, mic?.granted, mic?.devices, actions]);

  const devices = mic?.devices ?? (listed === undefined ? undefined : listed);
  const known = devices ?? [];
  // A remembered input that is not connected now: the default is what a Start would use.
  const selected = mic?.selected && known.some((d) => d.id === mic.selected) ? mic.selected : null;

  // On open, and once the list arrives, the keyboard goes to the checked item (or the first).
  // (Once each: the toolbar re-renders every 500 ms while recording, and must not pull the keyboard back.)
  const focusedFor = useRef<string | null>(null);
  const focusKey = open ? `${mic?.granted}:${devices === undefined ? 'listing' : 'listed'}` : null;
  useEffect(() => {
    if (focusedFor.current === focusKey) return;
    focusedFor.current = focusKey;
    if (!focusKey) return;
    const m = menu.current;
    const target = m?.querySelector<HTMLElement>('[aria-checked="true"]') ?? m?.querySelector<HTMLElement>(ITEMS);
    target?.focus();
  });

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

  const choose = (id: string | null) => {
    close();
    button.current?.focus();
    if (id === selected) return;
    void actions
      .set(id)
      .then((r) => {
        if (!r.ok) onError(r.error);
      })
      .catch((err: unknown) => onError(String(err)));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      close();
      button.current?.focus();
      return;
    }
    const items = [...(menu.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    if (!items.length) return;
    const at = items.indexOf((e.target as HTMLElement).closest<HTMLElement>(ITEMS) ?? items[0]!);
    const go = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key];
    if (go === undefined) return;
    e.preventDefault();
    items[(go + items.length) % items.length]!.focus();
  };

  const item = (id: string | null, label: string) => (
    <button
      key={id ?? 'default'}
      type="button"
      role="menuitemradio"
      data-mic={id ?? ''}
      data-testid={id ? 'mic-device' : 'mic-default'}
      aria-checked={String(id === selected) as 'true' | 'false'}
      tabIndex={-1}
      className={MENU_ITEM}
      onClick={() => choose(id)}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={cn('size-3.5 flex-none', id !== selected && 'invisible')}
      >
        <path d={CHECK} />
      </svg>
      <span className="max-w-60 truncate">{label}</span>
    </button>
  );

  let body = null;
  if (mic && !mic.granted) {
    body = (
      <>
        <div className={NOTE} data-testid="mic-not-granted">
          The microphone is not allowed yet. Allow it in setup to choose which one records.
        </div>
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          data-testid="mic-setup"
          className={cn(MENU_ITEM, 'font-semibold')}
          onClick={() => {
            close();
            onSetup();
          }}
        >
          Finish setup
        </button>
      </>
    );
  } else if (mic && devices === undefined) {
    body = (
      <div className={NOTE} data-testid="mic-listing">
        Looking for microphones…
      </div>
    );
  } else if (mic) {
    const remembered = mic.selected && devices && !selected;
    body = (
      <>
        {item(null, 'System default')}
        {known.map((d) => item(d.id, d.label))}
        {devices === null ? (
          <div className={NOTE} data-testid="mic-unlisted">
            The microphones could not be listed.
          </div>
        ) : null}
        {remembered ? (
          <div className={NOTE} data-testid="mic-missing">
            The microphone you chose is not connected; the system default records.
          </div>
        ) : null}
      </>
    );
  }

  const current = selected ? known.find((d) => d.id === selected)?.label : null;
  const label = mic && !mic.granted ? 'Choose the microphone (not allowed yet)' : 'Choose the microphone';
  return (
    <>
      <button
        ref={button}
        type="button"
        data-testid="toolbar-mic-picker"
        data-granted={mic ? String(mic.granted) : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={current ? `Microphone: ${current}` : mic?.granted === false ? label : 'Microphone: System default'}
        hidden={!mic}
        disabled={disabled}
        className={cn('w-4 justify-center px-0 [&_svg]:block [&_svg]:size-3', buttonClassName)}
        onClick={() => setOpen((o) => !o)}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d={CHEVRON} />
        </svg>
      </button>
      <div
        ref={menu}
        role="menu"
        aria-label="Microphone"
        data-testid="mic-menu"
        data-theme={theme}
        hidden={!open || !mic}
        onKeyDown={onKeyDown}
        className="pointer-events-auto fixed z-[2] flex min-w-52 flex-col gap-0.5 rounded-lg border border-border bg-popover p-1.5 font-sans text-xs leading-tight font-medium whitespace-nowrap text-popover-foreground shadow-[0_1px_2px_rgb(31_42_68/0.08),0_8px_24px_-8px_rgb(31_42_68/0.18)] select-none"
      >
        {open ? body : null}
      </div>
    </>
  );
}
