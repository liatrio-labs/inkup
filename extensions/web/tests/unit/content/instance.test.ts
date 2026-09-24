import { afterEach, describe, expect, it, vi } from 'vitest';

/** A fresh copy of the content script's guard, bound to its own `chrome.runtime` (as each injected copy is). */
async function copy(runtime: { id?: string }) {
  vi.resetModules();
  vi.stubGlobal('chrome', { runtime });
  const mod = await import('@/content/instance');
  vi.unstubAllGlobals();
  return mod;
}

describe('one overlay client per page (#18)', () => {
  afterEach(() => {
    delete (window as unknown as Record<symbol, unknown>)[Symbol.for('inkup.overlay-client')];
    document.querySelectorAll('var-review-overlay').forEach((e) => {
      e.remove();
    });
  });

  it('a second live copy of the same extension does nothing', async () => {
    const first = await copy({ id: 'ext' });
    const second = await copy({ id: 'ext' });
    const leave = vi.fn();
    expect(first.claimPage(leave)).toBe(true);
    expect(second.claimPage(vi.fn())).toBe(false);
    expect(leave).not.toHaveBeenCalled();
  });

  it('after an update the new copy claims the page and the orphaned one leaves, taking its host with it', async () => {
    const oldRuntime: { id?: string } = { id: 'ext' };
    const old = await copy(oldRuntime);
    const leave = vi.fn();
    expect(old.claimPage(leave)).toBe(true);
    const host = document.createElement(old.HOST_TAG);
    document.documentElement.append(host);
    // The update: the old copy's runtime is gone, its script still runs.
    delete oldRuntime.id;
    const fresh = await copy({ id: 'ext' });
    expect(fresh.claimPage(vi.fn())).toBe(true);
    expect(leave).toHaveBeenCalledOnce();
    expect(host.isConnected).toBe(false);
  });

  it('a claim sent while the copy is alive (a page imitating one) changes nothing', async () => {
    const live = await copy({ id: 'ext' });
    const leave = vi.fn();
    live.claimPage(leave);
    document.dispatchEvent(new CustomEvent('inkup:overlay-claim'));
    expect(leave).not.toHaveBeenCalled();
  });
});
