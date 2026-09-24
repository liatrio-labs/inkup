// The toolbar stays on top in Firefox (content/top-layer.ts), on fixtures/site/overlap.html: (a) a fixed element at the
// maximum z-index added after our host, (b) a modal <dialog>, (c) a popover, (d) an element in fullscreen. For each the
// page hit-tests our toolbar's button at its centre and a real click on Draw (and Snap) works. Over the max-z element,
// the popover and fullscreen the ink itself shows: with the pointer still down the page's topmost element under the
// Stroke is our host and the screen there has pixels of its ink (the colour E8 picked), and the Annotation's screenshot
// has them too.
//
// While the toolbar's Start frame records the Session's video the host must not move (Firefox reloads an iframe in a
// shadow root on any move, which would end the video): over a modal dialog it stays under the root element, and the
// video survives the dialog.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { inkPixels, screenPng } from '../e2e/helpers/draw';
import { type ExtPage, expect, ROOT, test } from './fixtures';

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

async function toggleDraw(page: Page) {
  const draw = page.getByTestId('toolbar-draw');
  const was = await draw.getAttribute('aria-pressed');
  await draw.click();
  await expect(draw).toHaveAttribute('aria-pressed', was === 'true' ? 'false' : 'true');
}

function eventCount(ext: ExtPage, sessionId: string, type: string): Promise<number> {
  return ext.evaluate(
    async ({ id, type }) => {
      const idb = await new Promise<IDBDatabase>((res) => {
        const r = indexedDB.open('inkup');
        r.onsuccess = () => res(r.result);
      });
      const rows = await new Promise<{ type: string }[]>((res) => {
        const r = idb.transaction('events').objectStore('events').index('session_id').getAll(id);
        r.onsuccess = () => res(r.result as { type: string }[]);
      });
      return rows.filter((e) => e.type === type).length;
    },
    { id: sessionId, type },
  );
}

/** The screenshot of the latest Annotation as base64 PNG (null without one). */
/** The latest Annotation's screenshot as base64 PNG (null without one), and the latest Stroke's ink. */
const latestShot = (ext: ExtPage, sessionId: string) =>
  ext.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
    });
    const rows = await new Promise<
      { type: string; t: number; seq: number; screenshot_id?: string | null; color?: string }[]
    >((res) => {
      const r = idb.transaction('events').objectStore('events').index('session_id').getAll(id);
      r.onsuccess = () => res(r.result as { type: string; t: number; seq: number }[]);
    });
    rows.sort((a, b) => a.t - b.t || a.seq - b.seq);
    const ink = rows.filter((e) => e.type === 'stroke').at(-1)?.color ?? '#e03131';
    const ann = rows.filter((e) => e.type === 'annotation').at(-1);
    if (!ann?.screenshot_id) return { png: null, ink };
    const row = await new Promise<{ blob: Blob } | undefined>((res) => {
      const r = idb.transaction('blobs').objectStore('blobs').get(ann.screenshot_id!);
      r.onsuccess = () => res(r.result as { blob: Blob } | undefined);
    });
    if (!row) return { png: null, ink };
    const bytes = new Uint8Array(await row.blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { png: btoa(bin), ink };
  }, sessionId);

/**
 * Draws a Stroke over whatever covers the page (Draw is on). With the pointer still down, what the page hit-tests
 * under the Stroke and the ink pixels on screen there; then, once its Annotation is recorded, the ink pixels in its
 * screenshot.
 */
async function inkOver(page: Page, ext: ExtPage, sessionId: string) {
  const vp = page.viewportSize()!;
  const pts = [
    [0.3, 0.4],
    [0.4, 0.45],
    [0.5, 0.4],
    [0.6, 0.45],
  ].map(([x, y]) => [vp.width * x!, vp.height * y!] as [number, number]);
  const anns = await eventCount(ext, sessionId, 'annotation');
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
  await expect.poll(() => eventCount(ext, sessionId, 'annotation'), { timeout: 15_000 }).toBe(anns + 1);
  const { png, ink } = await latestShot(ext, sessionId);
  let onScreen = 0;
  for (const screen of screens) onScreen = Math.max(onScreen, await inkPixels(page, screen, ink));
  return { top, ink, onScreen, inShot: png ? await inkPixels(page, png, ink) : 0 };
}

async function setUp(
  context: BrowserContext,
  extPage: (part: string) => Promise<ExtPage>,
  primaryOrigin: string,
): Promise<{ onboarding: ExtPage; page: Page }> {
  const onboarding = await extPage('/onboarding.html');
  const script = JSON.parse(readFileSync(join(ROOT, 'fixtures/transcripts/pricing-cta.json'), 'utf8'));
  await onboarding.evaluate(
    (script) => chrome.storage.local.set({ devOverrides: { transcription: 'scripted', script } }),
    script,
  );
  await onboarding.click('allow-mic');
  await onboarding.waitFor(() => !!document.querySelector('[data-testid="mic-status"]'), undefined, {
    timeout: 20_000,
    what: 'the mic grant',
  });
  const page = await context.newPage();
  await page.goto(`${primaryOrigin}/overlap.html`);
  return { onboarding, page };
}

/** What the toolbar icon does (RDP cannot click it): add the tab to the toolbar's tabs. */
const showToolbar = (onboarding: ExtPage) =>
  onboarding.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://*/overlap.html' });
    await chrome.storage.session.set({ toolbarTabs: [tab!.id] });
  });

test('Firefox: the toolbar stays topmost and clickable over a max-z element, a modal dialog, a popover and fullscreen', async ({
  context,
  extPage,
  openExtensionWindow,
  site,
}) => {
  test.setTimeout(120_000);
  const { onboarding, page } = await setUp(context, extPage, site.primaryOrigin);
  const panel = await openExtensionWindow('sidepanel.html');
  await panel.click('start');
  await panel.waitForText('status', /^Recording$/);
  const sessionId = await panel.waitFor(
    async () =>
      ((await chrome.storage.session.get('activeSession')).activeSession as { id: string } | undefined)?.id ?? null,
    undefined,
    { what: 'an active Session' },
  );
  await page.bringToFront();
  await showToolbar(onboarding);
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'recording', { timeout: 15_000 });
  await expect.poll(() => hitAt(page, 'draw')).toBe('ours');
  expect(await hostParent(page)).toBe('html');

  // (a)
  await page.evaluate(() => {
    const cover = Object.assign(document.createElement('div'), { id: 'cover', className: 'cover' });
    document.documentElement.append(cover);
  });
  await expect.poll(() => hitAt(page, 'draw')).toBe('ours');
  await toggleDraw(page);
  const overCover = await inkOver(page, onboarding, sessionId);
  expect(overCover.top).toBe('ours');
  expect(overCover.onScreen).toBeGreaterThan(200);
  expect(overCover.inShot).toBeGreaterThan(200);
  await toggleDraw(page);
  await page.evaluate(() => document.getElementById('cover')!.remove());

  // (b)
  await page.evaluate(() => (document.getElementById('modal') as HTMLDialogElement).showModal());
  await expect.poll(() => hitAt(page, 'draw')).toBe('ours');
  expect(await hostParent(page)).toBe('dialog');
  await toggleDraw(page);
  await toggleDraw(page);
  await page.evaluate(() => (document.getElementById('modal') as HTMLDialogElement).close());
  await expect.poll(() => hostParent(page)).toBe('html');
  expect(await hitAt(page, 'draw')).toBe('ours');

  // (c)
  await page.evaluate(() => document.getElementById('pop')!.showPopover());
  await expect.poll(() => hitAt(page, 'snap')).toBe('ours');
  const shots = await eventCount(onboarding, sessionId, 'screenshot');
  await page.getByTestId('toolbar-snap').click();
  await expect.poll(() => eventCount(onboarding, sessionId, 'screenshot'), { timeout: 15_000 }).toBe(shots + 1);
  await toggleDraw(page);
  const overPopover = await inkOver(page, onboarding, sessionId);
  expect(overPopover.top).toBe('ours');
  expect(overPopover.onScreen).toBeGreaterThan(200);
  expect(overPopover.inShot).toBeGreaterThan(200);
  await toggleDraw(page);
  await page.evaluate(() => document.getElementById('pop')!.hidePopover());

  // (d)
  await page.locator('#go-fullscreen').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null)).toBe('stage');
  await expect.poll(() => hitAt(page, 'draw')).toBe('ours');
  expect(await hostParent(page)).toBe('div');
  await toggleDraw(page);
  const overFullscreen = await inkOver(page, onboarding, sessionId);
  expect(overFullscreen.top).toBe('ours');
  expect(overFullscreen.onScreen).toBeGreaterThan(200);
  expect(overFullscreen.inShot).toBeGreaterThan(200);
  await toggleDraw(page);
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => hostParent(page)).toBe('html');

  await panel.click('stop');
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
});

test('Firefox: while the Start frame records, a modal dialog does not move the host and the video survives it', async ({
  context,
  extPage,
  site,
}) => {
  test.setTimeout(120_000);
  const { onboarding, page } = await setUp(context, extPage, site.primaryOrigin);
  await showToolbar(onboarding);
  const toolbar = page.getByTestId('toolbar');
  const frame = page.getByTestId('toolbar-start-frame');
  await expect(frame).toBeVisible();
  await page.waitForTimeout(1000);
  const box = (await frame.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(toolbar).toHaveAttribute('data-state', 'recording', { timeout: 15_000 });
  const session = await onboarding.evaluate(
    async () =>
      (await chrome.storage.session.get('activeSession')).activeSession as { id: string; video: { state: string } },
  );
  expect(session.video.state).toBe('recording');

  await page.evaluate(() => (document.getElementById('modal') as HTMLDialogElement).showModal());
  await page.waitForTimeout(500);
  expect(await hostParent(page)).toBe('html');
  await page.evaluate(() => (document.getElementById('modal') as HTMLDialogElement).close());
  await expect.poll(() => hitAt(page, 'draw')).toBe('ours');
  await toggleDraw(page);
  await toggleDraw(page);

  await page.getByTestId('toolbar-stop').click();
  await expect(toolbar).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
  const video = await onboarding.waitFor(
    async (id) => {
      const idb = await new Promise<IDBDatabase>((res) => {
        const r = indexedDB.open('inkup');
        r.onsuccess = () => res(r.result);
      });
      const row = await new Promise<{ video: { chunk_count: number } | null } | undefined>((res) => {
        const r = idb.transaction('sessions').objectStore('sessions').get(id);
        r.onsuccess = () => res(r.result as { video: { chunk_count: number } | null } | undefined);
      });
      return row?.video && row.video.chunk_count > 0 ? row.video : null;
    },
    session.id,
    { timeout: 30_000, what: 'the frame video' },
  );
  expect(video.chunk_count).toBeGreaterThan(0);
});
