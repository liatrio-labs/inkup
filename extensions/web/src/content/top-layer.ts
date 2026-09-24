// Keeps the overlay host (canvas, toolbar, comment boxes: the whole shadow host) above the page. A z-index is not
// enough: the browser's top layer (a modal <dialog>, a popover, an element in fullscreen) paints above any z-index,
// and a page element at the same maximum z-index later in the document wins the tie.
//
// - The host is a manual popover, shown, so it is in the top layer itself. Top-layer order is last shown wins, so it is
//   shown again (hidePopover, showPopover) whenever the page adds to the top layer: a popover's `toggle`, a dialog's
//   `open`, `fullscreenchange`. Its own `:host` style undoes the UA popover box (it stays a full-viewport,
//   transparent, pointer-events: none layer; only the toolbar and, while drawing, the canvas take pointer events).
// - Painting on top is not the whole story: a modal dialog makes everything outside it inert, and so does element
//   fullscreen (Chrome 153 and Firefox 155 both hit-test past an inert popover to the page). So while one is open the
//   host moves inside it and moves back to the document root when it closes. An element that cannot have children
//   (a <video> in fullscreen) leaves the toolbar painted on top but unclickable until fullscreen ends.
// - Moving an iframe reloads it everywhere but in Chrome's `moveBefore`, and Firefox's toolbar Start frame records the
//   Session's video (docs/spikes/toolbar-start.md). `canMove` says when the host must stay where it is; in a dialog
//   that closed it moves anyway, as the toolbar would not show at all there.
// - The page may re-raise its own layer in answer to ours: past MAX_RAISES in RAISE_WINDOW_MS the host stops for the
//   rest of the window and tries once more after it.
// - Where there is no popover (Safari before 17) the host keeps the maximum z-index as the last child of the root
//   element, and goes back there when the page appends a maximum-z element after it.

const Z_MAX = '2147483647';
const DEBOUNCE_MS = 30;
const RAISE_WINDOW_MS = 2000;
const MAX_RAISES = 10;

const HOST_CSS = `:host {
  position: fixed !important; inset: 0 !important; margin: 0 !important; padding: 0 !important; border: 0 !important;
  width: auto !important; height: auto !important; max-width: none !important; max-height: none !important;
  display: block !important; overflow: visible !important; background: transparent !important;
  pointer-events: none !important; z-index: ${Z_MAX} !important;
}`;

export interface TopLayer {
  /** Check where the host should be now (after `canMove` may have changed). */
  refresh(): void;
  destroy(): void;
}

type Movable = Element & { moveBefore?: (node: Node, child: Node | null) => void };

export function keepOnTop(host: HTMLElement, opts: { canMove: () => boolean }): TopLayer {
  const home = document.documentElement;
  const popover = typeof host.showPopover === 'function';
  const style = document.createElement('style');
  style.textContent = HOST_CSS;
  // Last in the shadow root, so it wins over WXT's `:host { all: initial !important }` reset.
  host.shadowRoot?.append(style);
  if (popover) host.setAttribute('popover', 'manual');

  // Modal dialogs and fullscreen elements, oldest first; the newest still open holds the host.
  let blockers: Element[] = [];
  let raises: number[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  const blocking = (el: Element) =>
    el.isConnected &&
    (el === document.fullscreenElement || (el instanceof HTMLDialogElement && el.open && isModal(el)));
  const canHold = (el: Element) =>
    !(
      el instanceof HTMLMediaElement ||
      el instanceof HTMLImageElement ||
      el instanceof HTMLCanvasElement ||
      el instanceof HTMLIFrameElement
    );

  function move(parent: Element) {
    const p = parent as Movable;
    try {
      if (p.moveBefore) p.moveBefore(host, null);
      else p.append(host);
    } catch {
      p.append(host);
    }
  }

  function show() {
    if (!popover) return;
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch {
      // Not connected, or the page is in the middle of changing the top layer: the next event tries again.
    }
  }

  /** Moves the host where it must be; shows it again when it moved, was hidden, or `raise` (the page added a layer). */
  function place(raise: boolean) {
    blockers = blockers.filter(blocking);
    const holder = [...blockers].reverse().find(canHold) ?? home;
    const parent = host.parentElement;
    // Held back (the Start frame is recording), the host stays put unless it is in a dialog that has closed, where it
    // would not show at all.
    const stay = host.isConnected && !opts.canMove() && (parent === home || blockers.includes(parent!));
    const target = stay ? parent! : holder;
    const moved = parent !== target || (!popover && target === home && home.lastElementChild !== host);
    if (moved) move(target);
    if (moved || raise || (popover && !host.matches(':popover-open'))) show();
  }

  function schedule() {
    if (destroyed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const now = Date.now();
      raises = raises.filter((t) => now - t < RAISE_WINDOW_MS);
      if (raises.length >= MAX_RAISES) {
        timer = setTimeout(
          () => {
            timer = undefined;
            schedule();
          },
          RAISE_WINDOW_MS - (now - raises[0]!),
        );
        return;
      }
      raises.push(now);
      place(true);
    }, DEBOUNCE_MS);
  }

  const onToggle = (e: Event) => {
    if (e.target !== host && (e as ToggleEvent).newState === 'open') schedule();
  };
  const onFullscreen = () => {
    if (document.fullscreenElement) blockers.push(document.fullscreenElement);
    schedule();
  };
  const observer = new MutationObserver((records) => {
    let changed = !host.isConnected;
    for (const r of records) {
      if (r.type === 'attributes') {
        if (!(r.target instanceof HTMLDialogElement)) continue;
        if (r.target.open && isModal(r.target)) blockers.push(r.target);
        changed = true;
      } else if (
        !popover &&
        r.target === home &&
        [...r.addedNodes].some((n) => n !== host && n instanceof Element && getComputedStyle(n).zIndex === Z_MAX)
      ) {
        changed = true;
      }
    }
    if (changed) schedule();
  });

  document.addEventListener('toggle', onToggle, true);
  document.addEventListener('fullscreenchange', onFullscreen);
  observer.observe(home, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
  for (const d of document.querySelectorAll('dialog')) if (blocking(d)) blockers.push(d);
  if (document.fullscreenElement) blockers.push(document.fullscreenElement);
  place(true);

  return {
    refresh: () => !destroyed && place(false),
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener('toggle', onToggle, true);
      document.removeEventListener('fullscreenchange', onFullscreen);
      if (popover && host.matches(':popover-open')) host.hidePopover();
      style.remove();
    },
  };
}

function isModal(d: HTMLDialogElement): boolean {
  try {
    return d.matches(':modal');
  } catch {
    return true;
  }
}
