// Firefox MV3: the background event page hosts the media context in an iframe, sidebar_action is the control
// surface, and the video picker offers windows and screens (Firefox has no tab sharing or tabCapture). A Session
// started from the page's toolbar gets video from the picker in the toolbar's extension frame (docs/spikes/toolbar-start.md). Runtime Ports and
// captureVisibleTab are the same WebExtension APIs as in Chrome.
import { chromePlatform } from '../chrome';
import { canScanQr, type Platform } from '../types';
import { closeMediaFrame, ensureMediaFrame } from './media-frame';

/** The Firefox-only APIs used here (Chrome's types have neither). */
interface FirefoxApis {
  action: { onClicked: { addListener(cb: (tab: chrome.tabs.Tab) => void): void } };
  sidebarAction: { open(): Promise<void>; toggle(): Promise<void> };
}
const ff = () => (globalThis as unknown as { browser: FirefoxApis }).browser;

export const firefoxPlatform: Platform = {
  capabilities: () => ({
    mediaContext: true,
    controlSurface: true,
    tabVideo: true,
    screenshots: true,
    speechRecognition: false,
    toolbarVideo: 'frame_picker',
    viewport: true,
    qrScan: canScanQr(),
  }),

  mediaContext: { ensure: ensureMediaFrame, close: closeMediaFrame },

  controlSurface: {
    onActionClick: async (listener) => ff().action.onClicked.addListener(listener),
    // Firefox opens the sidebar in the window of the user action. It must run inside that action's handler (a
    // shortcut); a message from the page's toolbar is not one, and the caller falls back to a window.
    open: () => ff().sidebarAction.open(),
  },

  surfacePort: chromePlatform.surfacePort,

  tabVideo: {
    available: () => Boolean(navigator.mediaDevices?.getDisplayMedia),
    pick: ({ maxWidth, maxFps }) =>
      navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: maxWidth }, frameRate: { max: maxFps } },
        audio: false,
      }),
  },

  captureVisibleTab: chromePlatform.captureVisibleTab,
  // Firefox has the same downloads API as Chrome.
  saveFile: chromePlatform.saveFile,
};
