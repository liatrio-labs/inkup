// Chrome MV3: offscreen document, side panel, runtime Ports, getDisplayMedia, tabCapture, captureVisibleTab, downloads.
import { canScanQr, type Platform, type SurfacePort } from '../types';
import { closeOffscreen, ensureOffscreen } from './offscreen';
import { saveWithDownloadsApi } from './save-file';

function wrap<Out, In>(port: chrome.runtime.Port): SurfacePort<Out, In> {
  return {
    postMessage: (msg) => port.postMessage(msg),
    onMessage: (listener) => port.onMessage.addListener((msg: In) => listener(msg)),
    onDisconnect: (listener) => port.onDisconnect.addListener(() => listener()),
    disconnect: () => port.disconnect(),
  };
}

export const chromePlatform: Platform = {
  capabilities: () => ({
    mediaContext: true,
    controlSurface: true,
    tabVideo: true,
    screenshots: true,
    speechRecognition: true,
    toolbarVideo: 'tab_capture',
    viewport: true,
    qrScan: canScanQr(),
  }),

  mediaContext: { ensure: ensureOffscreen, close: closeOffscreen },

  controlSurface: {
    // The panel behaviour persists in the profile: an earlier version set it to open on click. The listener goes on
    // first, in the worker's first turn: a click that wakes the worker is dispatched once its script has run, and a
    // listener added after an await misses it.
    onActionClick: async (listener) => {
      chrome.action.onClicked.addListener(listener);
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    },
    open: (windowId) => chrome.sidePanel.open({ windowId }),
  },

  surfacePort: {
    connect: (name) => wrap(chrome.runtime.connect({ name })),
    onConnect: (name, listener) =>
      chrome.runtime.onConnect.addListener((port) => {
        if (port.name === name) listener(wrap(port));
      }),
  },

  tabVideo: {
    available: () => Boolean(navigator.mediaDevices?.getDisplayMedia),
    pick: ({ maxWidth, maxFps }) =>
      navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser', width: { max: maxWidth }, frameRate: { max: maxFps } },
        audio: false,
        preferCurrentTab: false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'exclude',
        monitorTypeSurfaces: 'exclude',
      } as DisplayMediaStreamOptions),
    // The media context opens it with getUserMedia({ chromeMediaSource: 'tab' }); it follows the tab across navigations.
    captureId: (tabId) => chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }),
  },

  captureVisibleTab: (windowId) => chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),

  saveFile: saveWithDownloadsApi,
};
