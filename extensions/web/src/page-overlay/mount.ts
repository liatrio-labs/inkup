// Our own extension pages as review targets (feedback batch 1, U5). Content scripts cannot be declared for
// chrome-extension:// pages, so the review, Sessions, options and onboarding pages call this at startup: it runs
// the same overlay client as the content script, in a plain shadow host. The service worker reaches the page
// with tabs.sendMessage (which extension pages in a tab receive) and reads its page context from the overlay.
// The side panel and the offscreen document never call it.
import { runOverlayClient } from '@/content/client';
import { HOST_TAG } from '@/content/instance';

export function mountPageOverlay(): void {
  void runOverlayClient(async () => {
    const host = document.createElement(HOST_TAG);
    const shadow = host.attachShadow({ mode: 'open' });
    const container = document.createElement('div');
    container.style.pointerEvents = 'none';
    Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none' });
    shadow.append(container);
    document.documentElement.append(host);
    return { container, host, remove: () => host.remove() };
  });
}
