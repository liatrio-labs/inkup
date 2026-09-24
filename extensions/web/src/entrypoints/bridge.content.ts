// The MAIN-world bridge (E4). The overlay content script runs in an isolated world and cannot see the page's
// JavaScript objects; this one runs in the page's own world, so it can read React fibers and Vue instances. It holds
// no extension APIs: it answers source probes over DOM events (src/bridge/protocol.ts), and holds the page API
// (`window.__inkup`, E5) while the overlay says this tab is being recorded.
// Chrome and Firefox (128+) run `world: 'MAIN'` content scripts from the manifest; see docs/browsers.md for Safari.
import { defineContentScript } from '#imports';
import { servePageApi } from '@/bridge/page-api';
import { BRIDGE_READY } from '@/bridge/protocol';
import { serveSourceProbes } from '@/bridge/serve';

export default defineContentScript({
  matches: ['<all_urls>'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    // Injected again into tabs open at install (background/inject.ts): one bridge per page.
    const once = Symbol.for('inkup.bridge');
    if ((window as unknown as Record<symbol, boolean>)[once]) return;
    Object.defineProperty(window, once, { value: true });
    serveSourceProbes();
    servePageApi();
    document.dispatchEvent(new CustomEvent(BRIDGE_READY));
  },
});
