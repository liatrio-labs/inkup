// The frame host page (plan E6, src/viewport/frame-host.ts): the tab's view while the viewport control resizes a
// page. It holds the page in a frame
// of the chosen size, centred on a neutral backdrop, scaled down to fit when larger than the tab (the scale is in the
// bar), with freeform handles on the frame's edges. The frame is a real viewport: media queries and matchMedia follow.
//
// It lays out from the service worker's state for this tab (storage.session tabViewports), reports where the frame
// is (the service worker crops screenshots to it), and mirrors the framed page into its own URL, so the Session sees
// each navigation in the frame as one of the tab. With no state for this tab it hands the tab back to the page.
import { clampSize, frameRect, type Size, sizeLabel, sizeWithScale } from '@inkup/core/viewport';
import { sendMessage } from '@/messaging';
import { tabViewports } from '@/session-state';
import type { TabViewport } from '@/settings';
import { FRAME_NAME, framedUrl, frameHostUrl, HOST_BAR, HOST_PAD, hostAvailable } from '@/viewport/frame-host';

const wrap = document.getElementById('wrap')!;
const frame = document.getElementById('frame') as HTMLIFrameElement;
const readout = document.querySelector<HTMLElement>('[data-testid="viewport-readout"]')!;
const urlEl = document.querySelector<HTMLElement>('[data-testid="viewport-url"]')!;
// The name is in the markup (the probe looks for it); it must stay FRAME_NAME.
if (frame.name !== FRAME_NAME) frame.name = FRAME_NAME;

let tabId: number | null = null;
let state: TabViewport | null = null;
/** The size a drag is showing before release. */
let preview: Size | null = null;

function layout(): void {
  if (!state) return;
  const size = preview ?? state;
  const r = frameRect(size, hostAvailable({ width: innerWidth, height: innerHeight }));
  const x = HOST_PAD + r.x;
  const y = HOST_BAR + HOST_PAD + r.y;
  Object.assign(wrap.style, { left: `${x}px`, top: `${y}px`, width: `${r.width}px`, height: `${r.height}px` });
  Object.assign(frame.style, {
    width: `${size.width}px`,
    height: `${size.height}px`,
    transform: r.scale < 1 ? `scale(${r.scale})` : '',
  });
  wrap.hidden = false;
  readout.textContent = sizeWithScale({ ...size, scale: r.scale });
  if (!preview)
    void sendMessage('viewportHostLayout', { x, y, width: r.width, height: r.height, scale: r.scale }).catch(() => {});
}

async function follow(next: TabViewport | undefined): Promise<void> {
  if (!next) {
    // Reset elsewhere, or a host page with nothing to host (restored from history): give the tab the page back.
    const page = state?.url ?? framedUrl(location.href);
    if (page) location.replace(page);
    return;
  }
  const first = !state;
  state = next;
  urlEl.textContent = next.url;
  document.title = `${sizeLabel(next)} · ${next.url}`;
  if (first) frame.src = framedUrl(location.href) ?? next.url;
  // The frame navigated: say so in this page's URL (the Session logs it as the tab's navigation).
  if (framedUrl(location.href) !== next.url) history.replaceState(null, '', frameHostUrl(next.url));
  layout();
}

// ---- freeform drag ----

let drag: { id: number; edge: string; start: Size; x: number; y: number; scale: number } | null = null;

for (const handle of document.querySelectorAll<HTMLElement>('.handle')) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state) return;
    e.preventDefault();
    const scale = frameRect(state, hostAvailable({ width: innerWidth, height: innerHeight })).scale;
    drag = {
      id: e.pointerId,
      edge: handle.dataset.edge!,
      start: { width: state.width, height: state.height },
      x: e.clientX,
      y: e.clientY,
      scale,
    };
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* not a live pointer (a synthetic event): the handle still gets the moves dispatched at it */
    }
    document.body.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = drag.edge === 'bottom' ? 0 : (e.clientX - drag.x) / drag.scale;
    const dy = drag.edge === 'right' ? 0 : (e.clientY - drag.y) / drag.scale;
    preview = clampSize({ width: drag.start.width + dx, height: drag.start.height + dy });
    layout();
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    document.body.classList.remove('dragging');
    const size = preview;
    preview = null;
    if (size && (size.width !== state?.width || size.height !== state?.height))
      void sendMessage('viewportSet', size).catch(() => {});
    layout();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

document.getElementById('reset')!.addEventListener('click', () => void sendMessage('viewportReset').catch(() => {}));
addEventListener('resize', layout);

void (async () => {
  const tab = await chrome.tabs.getCurrent();
  tabId = tab?.id ?? null;
  if (tabId === null) return;
  const id = String(tabId);
  await follow((await tabViewports.getValue())[id]);
  tabViewports.watch((all) => void follow(all[id]));
})();
