// The toolbar stays on top of whatever the page puts over it (content/top-layer.ts). On fixtures/site/overlap.html,
// each in turn covers the whole viewport: (a) a fixed element at the maximum z-index added after our host, (b) a modal
// <dialog> (showModal), (c) a popover (showPopover), (d) an element in fullscreen. For each the page hit-tests our
// toolbar's button at its centre (elementFromPoint, then inside our shadow root) and a real click on Draw (and Snap)
// works. Over the modal, drawing still gets the pointer and records a Stroke. Over the max-z element, the popover and
// fullscreen the ink itself shows: with the pointer still down the page's topmost element under the Stroke is our host
// and the screen there has pixels of its ink (the colour E8 picked), and the Annotation's screenshot has them too. When
// the dialog closes the host is back under the root element.
import type { Page } from '@playwright/test';
import { ALLOW_TAB_CAPTURE, expect, grantMic, test } from './fixtures';
import { inkPixels, screenPng, stroke } from './helpers/draw';
import { activeSessionId, ofType, screenshotPng, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'review-two-notes.wav', extraArgs: [ALLOW_TAB_CAPTURE] });

/** What the page hit-tests at the centre of the toolbar's `action` button: 'ours' when it is that button. */
const hitAt = (page: Page, action: string) =>
  page.evaluate((action) => {
    const host = document.querySelector('var-review-overlay')!;
    const button = host.shadowRoot!.querySelector(`[data-testid="toolbar-${action}"]`)!;
    const r = button.getBoundingClientRect();
    const [x, y] = [r.x + r.width / 2, r.y + r.height / 2];
    const hit = document.elementFromPoint(x, y);
    if (hit !== host) return hit ? hit.id || hit.tagName.toLowerCase() : 'nothing';
    return button.contains(host.shadowRoot!.elementFromPoint(x, y)) ? 'ours' : 'our host, not the button';
  }, action);

const hostParent = (page: Page) =>
  page.evaluate(() => document.querySelector('var-review-overlay')!.parentElement!.tagName.toLowerCase());

/** A real click on Draw flips it. */
async function toggleDraw(page: Page) {
  const draw = page.getByTestId('toolbar-draw');
  const was = await draw.getAttribute('aria-pressed');
  await draw.click();
  await expect(draw).toHaveAttribute('aria-pressed', was === 'true' ? 'false' : 'true');
}

/**
 * Draws a Stroke over whatever covers the page (Draw is on). With the pointer still down, what the page hit-tests
 * under the Stroke and the ink pixels on screen there; then, once its Annotation is recorded, the ink pixels in its
 * screenshot.
 */
async function inkOver(page: Page, ext: Page, sessionId: string) {
  const vp = page.viewportSize()!;
  const pts = [
    [0.3, 0.4],
    [0.4, 0.45],
    [0.5, 0.4],
    [0.6, 0.45],
  ].map(([x, y]) => [vp.width * x!, vp.height * y!] as [number, number]);
  const anns = ofType(await sessionEvents(ext, sessionId), 'annotation').length;
  await page.mouse.move(...pts[0]!);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(...p, { steps: 4 });
  const top = await page.evaluate(([x, y]) => {
    const hit = document.elementFromPoint(x, y);
    return hit === document.querySelector('var-review-overlay')
      ? 'ours'
      : hit?.id || hit?.tagName.toLowerCase() || 'nothing';
  }, pts[1]!);
  // Under load one capture in a group run showed no ink while the screencast had it: take three.
  const clip = {
    x: vp.width * 0.3 - 8,
    y: vp.height * 0.4 - 8,
    width: vp.width * 0.3 + 16,
    height: vp.height * 0.05 + 16,
  };
  const screens = [await screenPng(page, clip), await screenPng(page, clip), await screenPng(page, clip)];
  await page.mouse.up();
  await expect
    .poll(async () => ofType(await sessionEvents(ext, sessionId), 'annotation').length, { timeout: 15_000 })
    .toBe(anns + 1);
  const events = await sessionEvents(ext, sessionId);
  const ann = ofType(events, 'annotation').at(-1)!;
  // The ink E8 picked for this cover.
  const ink = ofType(events, 'stroke').at(-1)!.color ?? '#e03131';
  const png = ann.screenshot_id ? await screenshotPng(ext, ann.screenshot_id) : null;
  let onScreen = 0;
  for (const screen of screens) onScreen = Math.max(onScreen, await inkPixels(page, screen, ink));
  return { top, ink, onScreen, inShot: png ? await inkPixels(page, png, ink) : 0 };
}

test('the toolbar stays topmost and clickable over a max-z element, a modal dialog, a popover and fullscreen', async ({
  context,
  serviceWorker: sw,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  await grantMic(openExtensionPage);
  const page = await context.newPage();
  await page.goto(`${site.primaryOrigin}/overlap.html`);
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://*/overlap.html' });
    (chrome.action.onClicked as unknown as { dispatch(tab: chrome.tabs.Tab): void }).dispatch(tab!);
  });
  await page.getByTestId('toolbar-start').click();
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'recording');
  const sessionId = (await activeSessionId(sw))!;
  const ext = await openExtensionPage('sessions.html');
  const count = async (type: 'stroke' | 'screenshot') => ofType(await sessionEvents(ext, sessionId), type).length;
  await page.bringToFront();
  expect(await hostParent(page)).toBe('html');
  expect(await hitAt(page, 'draw')).toBe('ours');

  // (a) A fixed element at the maximum z-index, appended after our host.
  await page.evaluate(() => {
    const cover = Object.assign(document.createElement('div'), { id: 'cover', className: 'cover' });
    document.documentElement.append(cover);
  });
  await expect.poll(() => hitAt(page, 'draw')).toBe('ours');
  await toggleDraw(page);
  const overCover = await inkOver(page, ext, sessionId);
  expect(overCover.top).toBe('ours');
  expect(overCover.onScreen).toBeGreaterThan(200);
  expect(overCover.inShot).toBeGreaterThan(200);
  await toggleDraw(page);
  await page.evaluate(() => document.getElementById('cover')!.remove());

  // (b) A modal dialog: the host moves inside it (outside, it would be inert) and back when it closes.
  await page.evaluate(() => (document.getElementById('modal') as HTMLDialogElement).showModal());
  await expect.poll(() => hitAt(page, 'draw')).toBe('ours');
  expect(await hostParent(page)).toBe('dialog');
  await toggleDraw(page);
  const strokes = await count('stroke');
  const vp = page.viewportSize()!;
  await stroke(page, [
    [vp.width * 0.3, vp.height * 0.4],
    [vp.width * 0.4, vp.height * 0.45],
    [vp.width * 0.5, vp.height * 0.4],
    [vp.width * 0.6, vp.height * 0.45],
  ]);
  await expect.poll(() => count('stroke'), { timeout: 15_000 }).toBe(strokes + 1);
  await toggleDraw(page);
  await page.evaluate(() => (document.getElementById('modal') as HTMLDialogElement).close());
  await expect.poll(() => hostParent(page)).toBe('html');
  expect(await hitAt(page, 'draw')).toBe('ours');

  // (c) A popover.
  await page.evaluate(() => document.getElementById('pop')!.showPopover());
  await expect.poll(() => hitAt(page, 'snap')).toBe('ours');
  const shots = await count('screenshot');
  await page.getByTestId('toolbar-snap').click();
  await expect.poll(() => count('screenshot'), { timeout: 15_000 }).toBe(shots + 1);
  await toggleDraw(page);
  const overPopover = await inkOver(page, ext, sessionId);
  expect(overPopover.top).toBe('ours');
  expect(overPopover.onScreen).toBeGreaterThan(200);
  expect(overPopover.inShot).toBeGreaterThan(200);
  await toggleDraw(page);
  await page.evaluate(() => document.getElementById('pop')!.hidePopover());

  // (d) An element in fullscreen (a click on the page's button: fullscreen needs the user's gesture).
  await page.locator('#go-fullscreen').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null)).toBe('stage');
  await expect.poll(() => hitAt(page, 'draw')).toBe('ours');
  expect(await hostParent(page)).toBe('div');
  await toggleDraw(page);
  const overFullscreen = await inkOver(page, ext, sessionId);
  expect(overFullscreen.top).toBe('ours');
  expect(overFullscreen.onScreen).toBeGreaterThan(200);
  expect(overFullscreen.inShot).toBeGreaterThan(200);
  await toggleDraw(page);
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => hostParent(page)).toBe('html');
  expect(await hitAt(page, 'draw')).toBe('ours');

  await page.getByTestId('toolbar-stop').click();
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
});
