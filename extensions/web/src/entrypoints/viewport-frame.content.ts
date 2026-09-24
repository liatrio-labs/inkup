// The frame host's probe (plan E6, src/viewport/frame-host.ts). It runs in every frame of every page but does nothing
// unless it is the frame our viewport page holds (named FRAME_NAME); there it tells the service worker which page
// loaded, and the service worker injects the overlay's content script into this frame and mirrors the page into the
// host page's URL. The manifest content script runs only in top frames, so without this the framed page would have
// no toolbar and no drawing.
import { defineContentScript } from '#imports';
import { sendMessage } from '@/messaging';
import { FRAME_NAME } from '@/viewport/frame-host';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',
  main() {
    if (window === window.top || window.name !== FRAME_NAME) return;
    void sendMessage('viewportFrameLoaded', { url: location.href, title: document.title }).catch(() => {});
  },
});
