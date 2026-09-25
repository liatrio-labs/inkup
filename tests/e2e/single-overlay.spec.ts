// F2 proof (#18): a tab still loading when the extension installs gets the manifest's content script and the copy
// background/inject.ts puts into open tabs, and still shows exactly one overlay host and one toolbar. After an update
// (the same unpacked path loaded again, which fires onInstalled with reason "update") the old copy, whose runtime is now dead,
// leaves the page and the new one takes over. Playwright can only load extensions at launch, so this drives Chromium
// over raw CDP, as inject.spec.ts does.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromiumArgs, EXTENSION_PATH, expect, test } from './fixtures';
import { type CdpSession, RawChromium } from './raw-cdp';

/** A page whose HTML arrives in two parts, `delayMs` apart: it is still loading while the extension installs. */
function slowSite(delayMs: number): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.write(
      '<!doctype html><html><head><title>Slow Fixture</title></head><body><h1 id="title">A page still loading</h1>',
    );
    setTimeout(() => res.end('<p>Loaded.</p></body></html>'), delayMs);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

/** Overlay hosts and toolbars on the page (the hosts' shadow roots are open). */
const COUNT = `(() => {
  const hosts = [...document.querySelectorAll('var-review-overlay')];
  const toolbars = hosts.flatMap((h) => [...(h.shadowRoot?.querySelectorAll('[data-testid="toolbar"]') ?? [])]);
  return { hosts: hosts.length, toolbars: toolbars.length, state: toolbars[0]?.getAttribute('data-state') ?? null };
})()`;

const clickIcon = (sw: CdpSession, url: string) =>
  sw.evaluate(
    `chrome.tabs.query({}).then((ts) => { const t = ts.find((t) => t.url === '${url}'); chrome.action.onClicked.dispatch(t); return t.id; })`,
  );

async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < until) {
    last = await fn().catch(() => undefined as T);
    if (last !== undefined && ok(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
}

test('a tab loading at install shows one overlay host and one toolbar; after an update the new copy replaces the orphaned one', async () => {
  // Long enough for every wait inside to fail first, so the browser is always closed.
  test.setTimeout(240_000);
  const site = await slowSite(2500);
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/slow.html`;
  const args = chromiumArgs({ fakeAudio: 'review-two-notes.wav', captureSourceTitle: 'Slow Fixture' }).filter(
    (a) => !a.startsWith('--load-extension') && !a.startsWith('--disable-extensions-except'),
  );
  const browser = await RawChromium.launch([...args, '--enable-unsafe-extension-debugging']);
  try {
    const cdp = await browser.browserSession();
    await cdp.send('Target.createTarget', { url });
    const page = await browser.waitForTarget((t) => t.type === 'page' && t.url === url);
    // The target lists its URL before the navigation commits, while the tab still holds its initial about:blank, whose
    // readyState is already "complete". Wait for the slow page's own document.
    const state = await poll(
      () => page.evaluate<string | null>(`location.href === '${url}' ? document.readyState : null`),
      (s) => s !== null,
      'the slow page to commit',
    );
    expect(state).toBe('loading');

    // Install while the page is loading: onInstalled injects into it, and the manifest's script runs there too.
    const loaded = await cdp.send<{ id: string }>('Extensions.loadUnpacked', { path: EXTENSION_PATH });
    expect(loaded.result?.id).toMatch(/^[a-p]{32}$/);
    const { session: sw } = await browser.extensionServiceWorker('InkUp');
    await page.evaluate(
      `new Promise((r) => (document.readyState === 'complete' ? r(1) : addEventListener('load', () => r(1))))`,
    );
    // Both copies have had their chance to run.
    await new Promise((r) => setTimeout(r, 1500));

    await clickIcon(sw, url);
    const once = await poll(
      () => page.evaluate<{ hosts: number; toolbars: number; state: string | null }>(COUNT),
      (c) => c.toolbars > 0,
      'the toolbar',
    );
    // A moment later, in case a second copy mounts late.
    await new Promise((r) => setTimeout(r, 1000));
    expect(await page.evaluate(COUNT)).toEqual({ hosts: 1, toolbars: 1, state: 'idle' });
    expect(once.hosts).toBe(1);

    // An update: the old copy stays in the page with a dead runtime until the new one claims the page.
    const oldWorker = (await browser.targets()).find(
      (t) => t.type === 'service_worker' && t.url.includes(loaded.result.id),
    )!;
    // Loading the same unpacked path again reloads the extension in place: onInstalled says "update".
    const again = await cdp.send<{ id: string }>('Extensions.loadUnpacked', { path: EXTENSION_PATH });
    expect(again.result?.id).toBe(loaded.result.id);
    await poll(
      () => browser.targets(),
      (ts) => !ts.some((t) => t.id === oldWorker.id),
      'the old worker to go',
    );
    sw.close();
    const { session: sw2 } = await browser.extensionServiceWorker('InkUp', 20_000);
    // The orphaned toolbar leaves once the new version's copy is injected (reload clears the toolbar's tabs).
    await poll(
      () => page.evaluate<{ hosts: number }>(COUNT),
      (c) => c.hosts === 0,
      'the orphaned overlay to leave',
      30_000,
    );
    await clickIcon(sw2, url);
    await poll(
      () => page.evaluate<{ toolbars: number }>(COUNT),
      (c) => c.toolbars > 0,
      'the new toolbar',
    );
    await new Promise((r) => setTimeout(r, 1000));
    expect(await page.evaluate(COUNT)).toEqual({ hosts: 1, toolbars: 1, state: 'idle' });
    // The new copy is live: it answers the service worker.
    const answered = await sw2.evaluate<string>(
      `chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === '${url}')).then((t) => chrome.tabs.sendMessage(t.id, { id: 1, type: 'contentPing', data: null, timestamp: Date.now() })).then((r) => JSON.stringify(r), (e) => 'no-receiver:' + e.message)`,
    );
    expect(answered).toContain('true');
    sw2.close();
    page.close();
    cdp.close();
  } finally {
    browser.close();
    site.close();
  }
});
