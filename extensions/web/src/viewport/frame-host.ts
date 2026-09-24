// The frame host (plan E6, docs/spikes/viewport.md): to resize a tab's viewport, the tab shows our
// page (src/entrypoints/viewport) holding a sized, centred frame of the page under review, so the page gets a real
// viewport of that size. The tab's URL is then ours; the page's is in `?u=`, kept current as the frame navigates.
// Shared by the service worker, the host page and the frame's probe.
import type { Size } from '@inkup/core/viewport';

export const FRAME_HOST_PATH = '/viewport.html';
/** The frame's name: the probe content script (every frame) only asks for the overlay in a frame with this name. */
export const FRAME_NAME = 'var-viewport-frame';
/** The host page's bar (size readout, Reset) and the margin around the frame, CSS px. */
export const HOST_BAR = 40;
export const HOST_PAD = 16;

export const frameHostUrl = (pageUrl: string) =>
  `${chrome.runtime.getURL(FRAME_HOST_PATH)}?u=${encodeURIComponent(pageUrl)}`;

/** The framed page's URL when `url` is the frame host, else null. */
export function framedUrl(url: string | undefined): string | null {
  if (!url?.startsWith(chrome.runtime.getURL(FRAME_HOST_PATH))) return null;
  return new URL(url).searchParams.get('u');
}

/** The page a tab is reviewing: under the frame host, the framed page. */
export const effectiveUrl = (url: string | undefined): string | undefined => framedUrl(url) ?? url;

/** The room the host page has for the frame in a tab of `tab` size. */
export const hostAvailable = (tab: Size): Size => ({
  width: Math.max(1, tab.width - 2 * HOST_PAD),
  height: Math.max(1, tab.height - HOST_BAR - 2 * HOST_PAD),
});
