// Safari MV3 (docs/spikes/safari.md): no offscreen document, side panel or downloads API. The media context and the
// control surface each get a small extension window, and files save through a download link. Tab video is
// Safari's window or screen picker; it cannot offer a single tab.
import { chromePlatform } from '../chrome';
import { canScanQr, type Platform, type SavedFile } from '../types';
import { extensionWindow } from './windows';

// offscreen.html is the same page Chrome loads as its offscreen document; here it is visible, which is what lets
// it open the microphone. Pure, so the other browsers' builds drop them.
const recorder = /* @__PURE__ */ extensionWindow('safariRecorderWindow', 'offscreen.html', { width: 360, height: 180 });
const panel = /* @__PURE__ */ extensionWindow('safariPanelWindow', 'sidepanel.html', { width: 400, height: 760 });

/** A download link: Safari has no downloads API, so nothing reports when the file lands. */
function saveWithLink(blob: Blob, filename: string): Promise<SavedFile> {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return Promise.resolve({ ok: true, downloadId: null });
}

const hasDisplayMedia = () => Boolean(navigator.mediaDevices?.getDisplayMedia);

export const safariPlatform: Platform = {
  capabilities: () => ({
    mediaContext: true,
    controlSurface: true,
    tabVideo: hasDisplayMedia(),
    screenshots: true,
    speechRecognition: 'SpeechRecognition' in globalThis || 'webkitSpeechRecognition' in globalThis,
    // Unverified in Safari (docs/spikes/toolbar-start.md, manual check S5): Start from the panel window for video.
    toolbarVideo: 'none',
    // The frame host is plain extension pages and scripting, but unverified in Safari (manual check S6).
    viewport: false,
    qrScan: canScanQr(),
  }),

  mediaContext: {
    // Focused, so the page is visible when the Session's offscreenStart opens the microphone.
    ensure: async () => void (await recorder.ensure({ focus: true })),
    close: () => recorder.close(),
    // The reviewer can close the recorder window like any other: that is Stop (#9), as closing the panel is in Chrome.
    onClosed: (listener) => recorder.onClosed(listener),
    audioChunkMs: 5_000,
  },

  controlSurface: {
    onActionClick: async (listener) => chrome.action.onClicked.addListener(listener),
    open: async (windowId) => void (await panel.ensure({ focus: true, near: windowId })),
  },

  // runtime Ports and captureVisibleTab behave as in Chrome.
  surfacePort: chromePlatform.surfacePort,

  tabVideo: {
    available: hasDisplayMedia,
    // WebKit ignores Chrome's picker hints (displaySurface, selfBrowserSurface, ...), so ask for the caps only.
    pick: ({ maxWidth, maxFps }) =>
      navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: maxWidth }, frameRate: { max: maxFps } },
        audio: false,
      }),
  },

  captureVisibleTab: chromePlatform.captureVisibleTab,

  saveFile: saveWithLink,
};
