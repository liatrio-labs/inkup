// A tab opened before the extension is installed gets the content script injected (scripting permission), so
// drawing works there without a reload. Playwright can only load extensions at launch, so this drives Chromium
// over raw CDP: open the page first, then install with Extensions.loadUnpacked, then ask the tab's content
// script to answer a message.
import { chromiumArgs, EXTENSION_PATH, expect, test } from './fixtures';
import { RawChromium } from './raw-cdp';

test('the content script is injected into http(s) tabs already open at install', async ({ site }) => {
  const args = chromiumArgs({ fakeAudio: 'review-two-notes.wav', captureSourceTitle: 'Pricing Fixture' }).filter(
    (a) => !a.startsWith('--load-extension') && !a.startsWith('--disable-extensions-except'),
  );
  const browser = await RawChromium.launch([...args, '--enable-unsafe-extension-debugging']);
  try {
    const cdp = await browser.browserSession();
    const pricingUrl = `${site.primaryOrigin}/pricing.html`;
    await cdp.send('Target.createTarget', { url: pricingUrl });
    const page = await browser.waitForTarget((t) => t.type === 'page' && t.url === pricingUrl);
    await page.evaluate(
      `new Promise(r => document.readyState === 'complete' ? r(1) : addEventListener('load', () => r(1)))`,
    );

    const loaded = await cdp.send<{ id: string }>('Extensions.loadUnpacked', { path: EXTENSION_PATH });
    expect(loaded.result?.id).toMatch(/^[a-p]{32}$/);
    const { session: sw } = await browser.extensionServiceWorker('InkUp');

    // @webext-core/messaging wire format; a live content script answers { res: undefined }, no script rejects.
    const probe = `chrome.tabs.query({}).then(ts => ts.find(t => t.url === '${pricingUrl}'))
      .then(t => chrome.tabs.sendMessage(t.id, { id: 1, type: 'contentState', data: null, timestamp: Date.now() }))
      .then(r => 'answered:' + JSON.stringify(r), e => 'no-receiver:' + e.message)`;
    await expect.poll(() => sw.evaluate<string>(probe), { timeout: 10_000 }).toMatch(/^answered:/);
    // Install also opened onboarding.
    await expect.poll(async () => (await browser.targets()).some((t) => t.url.endsWith('/onboarding.html'))).toBe(true);
    sw.close();
    page.close();
    cdp.close();
  } finally {
    browser.close();
  }
});
