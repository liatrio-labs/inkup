// Content script (PRD P0-2). Injected on every page load (so it re-injects after each navigation), but it
// mounts nothing unless the service worker says this tab is being recorded or shows the floating toolbar. The only
// thing it ever adds to the page is one shadow-root host holding the drawing canvas and the toolbar.
import { createShadowRootUi, defineContentScript } from '#imports';
import { type OverlayRoot, runOverlayClient } from '@/content/client';
import { HOST_TAG } from '@/content/instance';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  async main(ctx) {
    await runOverlayClient(async () => {
      let root: Omit<OverlayRoot, 'remove'> | null = null;
      const ui = await createShadowRootUi(ctx, {
        name: HOST_TAG,
        position: 'modal',
        zIndex: 2147483647,
        // The root element, not <body>: ties at the maximum z-index go to the later element (content/top-layer.ts).
        append: (_anchor, host) => document.documentElement.append(host),
        onMount: (container, _shadow, host) => {
          // Full-viewport and transparent: only the canvas (while drawing) and the toolbar take pointer events.
          container.style.pointerEvents = 'none';
          root = { container, host };
        },
      });
      ui.mount();
      return { ...root!, remove: () => ui.remove() };
    });
  },
});
