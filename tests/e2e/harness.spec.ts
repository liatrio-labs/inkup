import { expect, test } from './fixtures';

test('extension loads with the PLAN manifest and the side panel opens as a tab', async ({
  serviceWorker,
  openExtensionPage,
  extensionId,
}) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.permissions).toEqual(
    expect.arrayContaining(['sidePanel', 'offscreen', 'storage', 'unlimitedStorage', 'downloads', 'tabs', 'scripting']),
  );
  expect(manifest.host_permissions).toEqual(['<all_urls>']);
  expect(manifest.content_security_policy).toMatchObject({
    extension_pages: expect.stringContaining("'wasm-unsafe-eval'"),
  });
  expect(Object.keys(manifest.commands ?? {})).toEqual(expect.arrayContaining(['toggle-session', 'toggle-draw']));

  const panel = await openExtensionPage('sidepanel.html');
  await expect(panel.getByRole('heading', { name: 'InkUp' })).toBeVisible();
  // Tailwind + shadcn styles are applied (Button gets the primary background).
  const bg = await panel.getByTestId('start').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');
});

test('fixture site serves pricing with a cross-origin iframe', async ({ context, site }) => {
  const page = await context.newPage();
  await page.goto(`${site.primaryOrigin}/pricing.html`);
  await expect(page.locator('.hero .card button.cta')).toHaveText('Get started');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Docs' })).toBeVisible();
  const frame = page.frameLocator('#partner-frame');
  await expect(frame.locator('button.partner-action')).toBeVisible();
  const heights = await page
    .locator('.plans .card')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  expect(heights[0]).not.toBe(heights[1]);
});
