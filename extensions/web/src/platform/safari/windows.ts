// Safari has no offscreen document and no side panel (docs/spikes/safari.md), so both roles go to small extension
// windows. A hidden page cannot hold the microphone there: WebKit parks even a granted getUserMedia until the
// page's view is visible, and Safari's background page and offscreen view never are. The window id lives in
// storage.session so a restarted service worker finds the window it opened.
import { storage } from '@wxt-dev/storage';

const LOAD_TIMEOUT_MS = 10_000;

export interface ExtensionWindow {
  /**
   * Opens the page in a window of its own, or returns the one already open (focusing it when `focus` is set).
   * `near` is the window to sit beside. Resolves with the window id once the page has loaded.
   */
  ensure(opts?: { focus?: boolean; near?: number }): Promise<number>;
  /** Closes the window if it is open. */
  close(): Promise<void>;
  /**
   * Calls `listener` when the user closes the window (#9); `close()` does not. Register it when the service worker
   * starts: the window id is remembered, so a restarted worker still hears it.
   */
  onClosed(listener: () => void): void;
}

function pageLoaded(tabId: number, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`${path} did not load in its window`));
    }, LOAD_TIMEOUT_MS);
    const onUpdated = (id: number, change: { status?: string }) => {
      if (id !== tabId || change.status !== 'complete') return;
      done();
      resolve();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    // It may have loaded before the listener was added.
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status !== 'complete') return;
        done();
        resolve();
      },
      () => {},
    );
  });
}

async function besideWindow(near: number | undefined, width: number): Promise<{ left?: number; top?: number }> {
  if (near === undefined) return {};
  try {
    const w = await chrome.windows.get(near);
    if (w.left === undefined || w.width === undefined) return {};
    return { left: Math.max(0, w.left + w.width - width), top: w.top };
  } catch {
    return {};
  }
}

export function extensionWindow(key: string, path: string, size: { width: number; height: number }): ExtensionWindow {
  const remembered = storage.defineItem<number | null>(`session:${key}`, { fallback: null });
  let opening: Promise<number> | null = null;

  async function openWindowId(): Promise<number | null> {
    const id = await remembered.getValue();
    if (id === null) return null;
    try {
      await chrome.windows.get(id);
      return id;
    } catch {
      await remembered.setValue(null);
      return null;
    }
  }

  async function open(near: number | undefined): Promise<number> {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(`/${path}`),
      type: 'popup',
      focused: true,
      ...size,
      ...(await besideWindow(near, size.width)),
    });
    const tabId = win?.tabs?.[0]?.id;
    if (win?.id === undefined || tabId === undefined) throw new Error(`could not open ${path} in a window`);
    await remembered.setValue(win.id);
    await pageLoaded(tabId, path);
    return win.id;
  }

  return {
    async ensure({ focus = false, near } = {}) {
      const id = await openWindowId();
      if (id !== null) {
        if (focus) await chrome.windows.update(id, { focused: true });
        return id;
      }
      opening ??= open(near).finally(() => (opening = null));
      return opening;
    },
    async close() {
      const id = await openWindowId();
      // Forgotten first, so onClosed does not take this for the user closing it.
      await remembered.setValue(null);
      if (id !== null) await chrome.windows.remove(id).catch(() => {});
    },
    onClosed(listener) {
      chrome.windows.onRemoved.addListener((windowId) => {
        void remembered.getValue().then(async (id) => {
          if (id !== windowId) return;
          await remembered.setValue(null);
          listener();
        });
      });
    },
  };
}
