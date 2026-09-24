// The tabs showing a Session's review page, as the service worker sees them (decisions log #39: one per Session).
import type { Worker } from '@playwright/test';

export function reviewTabs(sw: Worker, sessionId: string): Promise<{ id: number; active: boolean }[]> {
  return sw.evaluate(async (id) => {
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter((t) => {
        if (!t.url?.startsWith(chrome.runtime.getURL('/review.html'))) return false;
        return new URL(t.url).searchParams.get('session') === id;
      })
      .map((t) => ({ id: t.id!, active: t.active }));
  }, sessionId);
}
