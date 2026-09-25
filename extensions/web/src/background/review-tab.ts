// One review tab per Session (decisions log #40): Stop and every "Open review" link focus the tab already showing
// that Session's review, and open one only when there is none.
//
// Finding it: the extension holds the `tabs` permission (wxt.config.ts), so `tabs.query` returns each tab's `url` in
// Chrome, Firefox and Safari alike. The query takes every tab and matches here rather than passing a `url` pattern:
// match patterns for the extension's own scheme differ between browsers, and a pattern cannot ignore other query
// parameters. `runtime.getContexts` would not need `tabs`, but it is newer and not in every browser this ships to, and
// `clients.matchAll` exists only in Chrome's service worker (Firefox runs an event page) and gives no tab id.

import { isReviewOf, reviewPath } from '@/lib/review-url';

/**
 * Focuses the tab showing this Session's review, else opens one. `windowId`: where a new tab goes, and which of
 * several matching tabs wins.
 */
export async function openReview(
  sessionId: string,
  windowId?: number,
): Promise<{ tab_id: number | null; reused: boolean }> {
  const origin = chrome.runtime.getURL('');
  const tabs = (await chrome.tabs.query({})).filter((t) => isReviewOf(t.url, sessionId, origin));
  const tab = tabs.find((t) => t.windowId === windowId) ?? tabs[0];
  if (tab?.id !== undefined) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return { tab_id: tab.id, reused: true };
  }
  const url = chrome.runtime.getURL(reviewPath(sessionId));
  const created = await (windowId !== undefined
    ? chrome.tabs.create({ url, windowId }).catch(() => chrome.tabs.create({ url }))
    : chrome.tabs.create({ url }));
  return { tab_id: created.id ?? null, reused: false };
}
