// Which tab a Session binds to: the active tab of the last focused window, when a Session can run there
// (packages/core/src/target.ts). When the panel page runs as a tab (tests open sidepanel.html that way), that active tab
// is the panel itself, so fall back to the most recently used target, web pages first. Any other tab that
// cannot be recorded is refused with a reason instead of silently recording a different tab. The page's toolbar and
// the shortcut name their own tab instead (targetTab).
import { type SessionMode, type TargetMode, targetMode } from '@inkup/core/target';
import { effectiveUrl } from '@/viewport/frame-host';

export const ownOrigin = () => chrome.runtime.getURL('').replace(/\/$/, '');
/** Under the frame host (a resized viewport, plan E6) the mode is the framed page's. */
export const modeOf = (url: string | undefined): TargetMode => targetMode(effectiveUrl(url), ownOrigin());
/** A tab as a Session sees it: under the frame host, its URL is the framed page's. */
const reviewed = <T extends chrome.tabs.Tab>(t: T): T => ({ ...t, url: effectiveUrl(t.url) });

type BoundTab = chrome.tabs.Tab & { id: number; windowId: number };
export type Target = { ok: true; tab: BoundTab; mode: SessionMode } | { ok: false; error: string };

const usable = (t: chrome.tabs.Tab) =>
  t.id !== undefined && t.windowId !== undefined && modeOf(t.url) !== 'not_a_target';

/** A given tab (the one whose page toolbar or shortcut asked), when a Session can run there. */
export async function targetTab(tabId: number): Promise<Target> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, error: 'That tab is gone.' };
  if (!usable(tab)) return { ok: false, error: `This tab cannot be recorded (${(tab.url ?? '').split('?')[0]}).` };
  return { ok: true, tab: reviewed(tab) as BoundTab, mode: modeOf(tab.url) as SessionMode };
}

export async function pickTargetTab(): Promise<Target> {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const bind = (t: chrome.tabs.Tab): Target => ({
    ok: true,
    tab: reviewed(t) as BoundTab,
    mode: modeOf(t.url) as SessionMode,
  });
  if (active && usable(active)) return bind(active);
  if (active?.url === chrome.runtime.getURL('/sidepanel.html')) {
    const rank = (t: chrome.tabs.Tab) => (modeOf(t.url) === 'page' ? 0 : 1);
    const tabs = (await chrome.tabs.query({})).filter((t) => usable(t) && !t.url!.startsWith('about:'));
    tabs.sort((a, b) => rank(a) - rank(b) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    if (tabs[0]) return bind(tabs[0]);
  }
  if (!active?.url) return { ok: false, error: 'Open the page you want to review first.' };
  return {
    ok: false,
    error: `This tab cannot be recorded (${active.url.split('?')[0]}). Switch to the page you want to review and click Start again.`,
  };
}
