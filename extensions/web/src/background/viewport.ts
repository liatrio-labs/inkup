// The toolbar's viewport control (plan E6), from the service worker's side: the frame host. The tab loads our page
// (src/entrypoints/viewport) around a sized frame of the page. Each page the frame loads runs the probe content
// script, which asks here for the overlay's content script in that frame. Sites that refuse framing (X-Frame-Options,
// CSP frame-ancestors) are reported per page. This logs `viewport_change` for a Session on that tab and shoots a
// resized page as exactly its frame. Chrome's debugger could resize in place, but was turned down (ADR 0023).
import { clampSize, fitScale, type Size } from '@inkup/core/viewport';
import type { ToolbarViewport } from '@/messaging';
import { platform } from '@/platform';
import { activeSession, frameHostLayouts, tabViewports } from '@/session-state';
import { devOverrides, type FrameHostLayout, type TabViewport, viewportSizes } from '@/settings';
import { effectiveUrl, framedUrl, frameHostUrl, hostAvailable } from '@/viewport/frame-host';
import { appendEvent } from './event-log';
import { CONTENT_SCRIPT } from './inject';
import { getActive, offsetOf } from './session';
import { modeOf } from './target-tab';

type Support = { ok: true } | { ok: false; reason: string; blocked?: boolean };

const available = async () => (await devOverrides.getValue())?.viewport ?? platform.capabilities().viewport;

const stateOf = async (tabId: number): Promise<TabViewport | undefined> => (await tabViewports.getValue())[tabId];

async function saveState(tabId: number, state: TabViewport | null): Promise<void> {
  const all = { ...(await tabViewports.getValue()) };
  if (state) all[tabId] = state;
  else delete all[tabId];
  await tabViewports.setValue(all);
}

async function tabSize(tabId: number): Promise<Size> {
  const tab = await chrome.tabs.get(tabId);
  return { width: tab.width ?? 1280, height: tab.height ?? 720 };
}

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

/** Why the page at `url` cannot be framed by our page, or null. Per URL, for the worker's lifetime. */
const refusals = new Map<string, Promise<string | null>>();
function frameRefusal(url: string): Promise<string | null> {
  const key = url.split('#')[0]!;
  let r = refusals.get(key);
  if (!r) {
    r = readFrameRefusal(key);
    refusals.set(key, r);
  }
  return r;
}

async function readFrameRefusal(url: string): Promise<string | null> {
  if (!/^https?:/.test(url)) return 'Only web pages can be shown at another size here.';
  const res = await fetch(url, { credentials: 'include', cache: 'no-store' }).catch(() => null);
  // Unreadable: let the frame try, and the reviewer sees what the site does.
  if (!res) return null;
  void res.body?.cancel().catch(() => {});
  const xfo = res.headers.get('x-frame-options');
  if (xfo && /deny|sameorigin/i.test(xfo))
    return `This site does not allow being shown in a frame (X-Frame-Options: ${xfo}), so its viewport cannot be resized here.`;
  const ancestors = /frame-ancestors([^;]*)/i.exec(res.headers.get('content-security-policy') ?? '')?.[1]?.trim();
  if (ancestors !== undefined && !/(^|\s)\*(\s|$)/.test(ancestors)) {
    return `This site does not allow being shown in a frame (Content-Security-Policy frame-ancestors ${ancestors || "'none'"}), so its viewport cannot be resized here.`;
  }
  return null;
}

async function supportFor(tab: chrome.tabs.Tab): Promise<Support> {
  if (tab.id !== undefined && (await stateOf(tab.id))) return { ok: true };
  const url = effectiveUrl(tab.url);
  if (!url || modeOf(url) !== 'page') return { ok: false, reason: 'Only web pages can be resized.' };
  if (!(await available())) return { ok: false, reason: 'This browser cannot resize a page’s viewport.' };
  const why = await frameRefusal(url);
  return why ? { ok: false, reason: why, blocked: true } : { ok: true };
}

/**
 * The toolbar's viewport control for a tab, or null where it cannot resize the page (the control is hidden). A page
 * that refuses framing gets the control with the refusal (`blocked`).
 */
export async function toolbarViewport(tabId: number): Promise<ToolbarViewport | null> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return null;
  const support = await supportFor(tab);
  if (!support.ok) {
    if (!support.blocked) return null;
    return {
      current: null,
      tab: hostAvailable({ width: tab.width ?? 0, height: tab.height ?? 0 }),
      last: null,
      blocked: support.reason,
    };
  }
  const [state, sizes] = await Promise.all([stateOf(tabId), viewportSizes.getValue()]);
  const url = state?.url ?? effectiveUrl(tab.url) ?? '';
  return {
    current: state ? { width: state.width, height: state.height, scale: state.scale } : null,
    tab: hostAvailable({ width: tab.width ?? 0, height: tab.height ?? 0 }),
    last: sizes[originOf(url)] ?? null,
  };
}

/** Logs the size for the Session recording this tab, if any. */
async function logChange(
  tabId: number,
  change: { width: number; height: number; scale: number; mechanism: 'frame_host' | 'none' },
): Promise<void> {
  const s = await getActive();
  if (!s || s.tab_id !== tabId || s.stopping) return;
  await appendEvent(s.id, {
    type: 'viewport_change',
    t: offsetOf(s),
    width: Math.round(change.width),
    height: Math.round(change.height),
    scale: change.scale,
    mechanism: change.mechanism,
  });
}

/** Resizes the tab's page viewport to `requested` (clamped): the tab loads the frame host, or it relays the frame. */
export async function setViewport(
  tabId: number,
  requested: Size,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, error: 'That tab is gone.' };
  const support = await supportFor(tab);
  if (!support.ok) return { ok: false, error: support.reason };
  const size = clampSize(requested);
  const url = (await stateOf(tabId))?.url ?? effectiveUrl(tab.url) ?? '';
  await viewportSizes.setValue({ ...(await viewportSizes.getValue()), [originOf(url)]: size });
  // The host page lays out the frame from this state.
  const scale = fitScale(size, hostAvailable(await tabSize(tabId)));
  await saveState(tabId, { ...size, scale, url });
  if (!framedUrl(tab.url)) await chrome.tabs.update(tabId, { url: frameHostUrl(url) });
  await logChange(tabId, { ...size, scale, mechanism: 'frame_host' });
  return { ok: true };
}

/** The tab's own size again: the tab gets back the page the frame host framed. */
export async function resetViewport(tabId: number): Promise<void> {
  const state = await stateOf(tabId);
  if (!state) return;
  await saveState(tabId, null);
  await clearLayout(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && framedUrl(tab.url)) await chrome.tabs.update(tabId, { url: state.url });
  const own = await tabSize(tabId).catch(() => ({ width: 1, height: 1 }));
  await logChange(tabId, { ...own, scale: 1, mechanism: 'none' });
}

/** The frame host's frame loaded a page: give it the overlay, and remember the page for the host's URL. */
export async function viewportFrameLoaded(sender: chrome.runtime.MessageSender, page: { url: string }): Promise<void> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || !sender.frameId || !framedUrl(sender.tab?.url)) return;
  const state = await stateOf(tabId);
  if (!state) return;
  await chrome.scripting
    .executeScript({ target: { tabId, frameIds: [sender.frameId] }, files: [CONTENT_SCRIPT] })
    .catch((e: unknown) => console.warn('viewport: no overlay in the frame', e));
  if (state.url !== page.url) await saveState(tabId, { ...state, url: page.url });
}

export async function viewportHostLayout(tabId: number | undefined, layout: FrameHostLayout): Promise<void> {
  if (tabId === undefined) return;
  await frameHostLayouts.setValue({ ...(await frameHostLayouts.getValue()), [tabId]: layout });
}

async function clearLayout(tabId: number) {
  const all = await frameHostLayouts.getValue();
  if (!(tabId in all)) return;
  const { [tabId]: _gone, ...rest } = all;
  await frameHostLayouts.setValue(rest);
}

/** True when the tab shows the frame host: its page is in the frame, not the tab's top document. */
export const isFramed = async (tabId: number) => !!(await stateOf(tabId));

/**
 * A screenshot of the tab's page as a PNG blob: exactly its frame when resized. `scale`: how much the page was scaled
 * down in the image (the frame host shows a size larger than the tab scaled down).
 */
export async function captureTab(tabId: number, windowId: number): Promise<{ blob: Blob; scale: number }> {
  const shot = await (await fetch(await platform.captureVisibleTab(windowId))).blob();
  const layout = (await stateOf(tabId)) ? (await frameHostLayouts.getValue())[tabId] : undefined;
  if (!layout) return { blob: shot, scale: 1 };
  const image = await createImageBitmap(shot);
  const px = image.width / (await tabSize(tabId)).width;
  const [sx, sy, sw, sh] = [layout.x, layout.y, layout.width, layout.height].map((v) => Math.round(v * px)) as [
    number,
    number,
    number,
    number,
  ];
  const canvas = new OffscreenCanvas(Math.max(1, sw), Math.max(1, sh));
  canvas.getContext('2d')!.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  image.close();
  return { blob: await canvas.convertToBlob({ type: 'image/png' }), scale: layout.scale };
}

/** Follows what ends a resized viewport, and logs the size in force when a Session starts. */
export function initViewport(): void {
  // A Session starting on a resized tab logs the size first, so its timeline says what every Annotation was seen at.
  activeSession.watch((s, before) => {
    if (!s || before?.id === s.id) return;
    void stateOf(s.tab_id)
      .then(
        (state) =>
          state &&
          logChange(s.tab_id, {
            width: state.width,
            height: state.height,
            scale: state.scale,
            mechanism: 'frame_host',
          }),
      )
      .catch(console.warn);
  });
  // The reviewer left the frame host (typed an address, went back): the tab is at its own size again.
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url === undefined || framedUrl(change.url)) return;
    void (async () => {
      if (!(await stateOf(tabId))) return;
      await saveState(tabId, null);
      await clearLayout(tabId);
      const own = await tabSize(tabId);
      await logChange(tabId, { ...own, scale: 1, mechanism: 'none' });
    })().catch(console.warn);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      if (await stateOf(tabId)) await saveState(tabId, null);
      await clearLayout(tabId);
    })().catch(console.warn);
  });
}
