// Tabs open before install (or before an update, whose old content scripts are orphaned) have no working
// content script. Inject ours into every open http(s) tab so drawing works without a reload, and the MAIN-world
// bridge (E4) with it, so those tabs report sources too. A tab whose content script already answers (one loading at
// install got the manifest's) is left alone; should both still run, the content script keeps one copy per page
// (content/instance.ts, #18).
import { sendMessage } from '@/messaging';

export const CONTENT_SCRIPT = 'content-scripts/content.js';
export const BRIDGE_SCRIPT = 'content-scripts/bridge.js';
const PING_MS = 500;

/** A live content script of this extension answers in the tab. An orphaned one cannot: its runtime is gone. */
async function hasLiveContentScript(tabId: number): Promise<boolean> {
  const answer = sendMessage('contentPing', undefined, tabId).catch(() => false);
  return (await Promise.race([answer, new Promise<false>((r) => setTimeout(() => r(false), PING_MS))])) === true;
}

export async function injectIntoOpenTabs(): Promise<number> {
  const tabs = (await chrome.tabs.query({})).filter((t) => t.id !== undefined && /^https?:/.test(t.url ?? ''));
  const results = await Promise.allSettled(
    tabs.map(async (t) => {
      if (await hasLiveContentScript(t.id!)) return false;
      await chrome.scripting
        .executeScript({ target: { tabId: t.id! }, files: [BRIDGE_SCRIPT], world: 'MAIN' })
        .catch(() => {});
      await chrome.scripting.executeScript({ target: { tabId: t.id! }, files: [CONTENT_SCRIPT] });
      return true;
    }),
  );
  return results.filter((r) => r.status === 'fulfilled' && r.value).length;
}
