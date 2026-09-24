// Safari's extension windows (src/platform/safari/windows.ts), against a fake of the windows and tabs APIs: one
// window per role, reused while it is open, reopened once the user has closed it, and remembered in
// storage.session across a restarted service worker. The user closing one is reported (onClosed, #9); our own
// close() is not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { extensionWindow } from '@/platform/safari/windows';

type Listener = (tabId: number, change: { status?: string }) => void;

function fakeChrome() {
  const open = new Map<number, { tabId: number; left: number; top: number; width: number }>();
  const listeners = new Set<Listener>();
  const removed = new Set<(windowId: number) => void>();
  let nextId = 10;
  const created: chrome.windows.CreateData[] = [];
  const api = {
    runtime: { getURL: (p: string) => `safari-web-extension://abc${p}` },
    windows: {
      create: vi.fn(async (data: chrome.windows.CreateData) => {
        created.push(data);
        const id = nextId++;
        const tabId = id * 100;
        open.set(id, { tabId, left: 0, top: 0, width: data.width ?? 0 });
        // The page finishes loading a moment later.
        setTimeout(() => {
          for (const l of listeners) l(tabId, { status: 'complete' });
        }, 5);
        return { id, tabs: [{ id: tabId }] };
      }),
      get: vi.fn(async (id: number) => {
        const w = open.get(id);
        if (!w) throw new Error(`No window with id: ${id}`);
        return { id, ...w };
      }),
      update: vi.fn(async () => ({})),
      // Like the browser: onRemoved fires for a window the extension removed too.
      remove: vi.fn(async (id: number) => {
        open.delete(id);
        removed.forEach((l) => {
          l(id);
        });
      }),
      onRemoved: { addListener: (l: (windowId: number) => void) => removed.add(l) },
    },
    tabs: {
      get: vi.fn(async () => ({ status: 'loading' })),
      onUpdated: {
        addListener: (l: Listener) => listeners.add(l),
        removeListener: (l: Listener) => listeners.delete(l),
      },
    },
  };
  /** The user closes a window with its close button. */
  const userCloses = (id: number) => {
    open.delete(id);
    removed.forEach((l) => {
      l(id);
    });
  };
  return {
    api,
    open,
    created,
    listeners,
    userCloses,
    addWindow: (id: number, w: { left: number; top: number; width: number }) => open.set(id, { tabId: 0, ...w }),
  };
}

let fake: ReturnType<typeof fakeChrome>;

beforeEach(() => {
  fakeBrowser.reset();
  fake = fakeChrome();
  vi.stubGlobal('chrome', fake.api);
});
afterEach(() => vi.unstubAllGlobals());

describe('extensionWindow', () => {
  it('opens the page in a focused popup window once, and waits for it to load', async () => {
    const w = extensionWindow('testWindow', 'offscreen.html', { width: 360, height: 180 });
    const [a, b] = await Promise.all([w.ensure(), w.ensure()]);
    expect(a).toBe(b);
    expect(await w.ensure()).toBe(a);
    expect(fake.api.windows.create).toHaveBeenCalledTimes(1);
    expect(fake.created[0]).toMatchObject({
      url: 'safari-web-extension://abc/offscreen.html',
      type: 'popup',
      focused: true,
      width: 360,
      height: 180,
    });
    expect(fake.listeners.size).toBe(0);
  });

  it('focuses the open window only when asked', async () => {
    const w = extensionWindow('testWindow', 'sidepanel.html', { width: 400, height: 760 });
    const id = await w.ensure();
    await w.ensure();
    expect(fake.api.windows.update).not.toHaveBeenCalled();
    await w.ensure({ focus: true });
    expect(fake.api.windows.update).toHaveBeenCalledWith(id, { focused: true });
  });

  it('opens a new window after the user closed the old one', async () => {
    const w = extensionWindow('testWindow', 'offscreen.html', { width: 360, height: 180 });
    const first = await w.ensure();
    fake.open.delete(first);
    const second = await w.ensure();
    expect(second).not.toBe(first);
    expect(fake.api.windows.create).toHaveBeenCalledTimes(2);
  });

  it('finds its window again from a restarted worker, and close forgets it', async () => {
    const id = await extensionWindow('testWindow', 'offscreen.html', { width: 360, height: 180 }).ensure();
    const restarted = extensionWindow('testWindow', 'offscreen.html', { width: 360, height: 180 });
    expect(await restarted.ensure()).toBe(id);
    await restarted.close();
    expect(fake.api.windows.remove).toHaveBeenCalledWith(id);
    await restarted.close();
    expect(fake.api.windows.remove).toHaveBeenCalledTimes(1);
  });

  it('sits at the right edge of the window it is opened beside', async () => {
    fake.addWindow(1, { left: 100, top: 50, width: 1200 });
    await extensionWindow('testWindow', 'sidepanel.html', { width: 400, height: 760 }).ensure({ near: 1 });
    expect(fake.created[0]).toMatchObject({ left: 900, top: 50 });
  });

  it('rejects when the page never loads', async () => {
    vi.useFakeTimers();
    try {
      fake.api.windows.create.mockImplementationOnce(async () => ({ id: 99, tabs: [{ id: 9900 }] }));
      const p = extensionWindow('testWindow', 'offscreen.html', { width: 360, height: 180 }).ensure();
      const caught = p.catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await caught).toMatchObject({ message: 'offscreen.html did not load in its window' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('extensionWindow.onClosed (#9)', () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('reports the user closing the window, once, and a later ensure opens a new one', async () => {
    const w = extensionWindow('testWindow', 'offscreen.html', { width: 360, height: 180 });
    const closed = vi.fn();
    w.onClosed(closed);
    const id = await w.ensure();
    fake.userCloses(id);
    await settle();
    expect(closed).toHaveBeenCalledTimes(1);
    // The same id again (a stale event) is not reported twice.
    fake.api.windows.remove(id);
    await settle();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(await w.ensure()).not.toBe(id);
  });

  it('does not report its own close(), or another window closing', async () => {
    const w = extensionWindow('testWindow', 'offscreen.html', { width: 360, height: 180 });
    const closed = vi.fn();
    w.onClosed(closed);
    fake.addWindow(1, { left: 0, top: 0, width: 800 });
    await w.ensure();
    fake.userCloses(1);
    await settle();
    await w.close();
    await settle();
    expect(fake.api.windows.remove).toHaveBeenCalledTimes(1);
    expect(closed).not.toHaveBeenCalled();
  });

  it('a restarted worker still hears the user close the window the old one opened', async () => {
    const id = await extensionWindow('testWindow', 'offscreen.html', { width: 360, height: 180 }).ensure();
    const restarted = extensionWindow('testWindow', 'offscreen.html', { width: 360, height: 180 });
    const closed = vi.fn();
    restarted.onClosed(closed);
    fake.userCloses(id);
    await settle();
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

describe('safariPlatform.mediaContext (#9)', () => {
  it("is Safari's recorder window: the user closing it is reported, closing it at Stop is not, and it writes audio every 5 s", async () => {
    const { safariPlatform } = await import('@/platform/safari');
    const closed = vi.fn();
    safariPlatform.mediaContext.onClosed!(closed);
    await safariPlatform.mediaContext.ensure();
    expect(fake.created.at(-1)).toMatchObject({ url: 'safari-web-extension://abc/offscreen.html', type: 'popup' });
    await safariPlatform.mediaContext.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).not.toHaveBeenCalled();

    await safariPlatform.mediaContext.ensure();
    const [id] = [...fake.open.keys()].slice(-1);
    fake.userCloses(id!);
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(safariPlatform.mediaContext.audioChunkMs).toBe(5_000);
  });

  it('the other browsers have no user-closable media context', async () => {
    const { chromePlatform } = await import('@/platform/chrome');
    const { firefoxPlatform } = await import('@/platform/firefox');
    expect(chromePlatform.mediaContext.onClosed).toBeUndefined();
    expect(firefoxPlatform.mediaContext.onClosed).toBeUndefined();
  });
});

describe('safariPlatform.saveFile', () => {
  it('saves through a download link, since Safari has no downloads API', async () => {
    const { safariPlatform } = await import('@/platform/safari');
    const clicked: { href: string; download: string }[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
    try {
      const saved = await safariPlatform.saveFile(new Blob(['{}'], { type: 'application/json' }), 'session-1234.json');
      expect(saved).toEqual({ ok: true, downloadId: null });
      expect(clicked).toEqual([{ href: expect.stringMatching(/^blob:/), download: 'session-1234.json' }]);
      expect(document.querySelector('a[download]')).toBeNull();
    } finally {
      click.mockRestore();
    }
  });
});
