// E6 proof: the toolbar's viewport control resizes the page for the review, through the frame host: the tab reloads
// into our viewport page, which holds the page in a frame of the chosen size. On the responsive fixture page (its nav
// collapses into a Menu button under 600 px), the 375×812 preset makes matchMedia('(max-width: 600px)') true in the
// framed page and shows the collapsed nav. The framed page keeps the overlay and the toolbar, still recording.
// Drawing there gives an Annotation seen at 375 px wide whose screenshot is exactly the frame; a freeform drag of the
// frame's right handle to 900 px logs a viewport_change of 900; Reset on the toolbar gives the page the tab again.
// Process names the size in the Change Item's agent_prompt and review.md names it too. A page that refuses framing
// says why instead of offering sizes.
//
// Chrome's debugger could resize the page in place but was turned down (ADR 0023). Runs standalone and
// paired with the real host, and in Firefox (tests/e2e-firefox/viewport.spec.ts). The window is made tall enough
// for 375×812 at 1:1.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Frame, Page, Worker } from '@playwright/test';
import type { TimelineEvent } from '../../packages/core/src/timeline.ts';
import { messageReply, scriptOf, startAnthropicStub } from '../support/anthropic-stub';
import { expect, grantMic, test, useScriptedTranscript } from './fixtures';
import { circle } from './helpers/draw';
import { HostProcess, pairThroughOptions, tempDataDir } from './helpers/host';
import { activeSessionId, ofType, screenshotPixel, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'review-two-notes.wav', extraArgs: ['--screen-info={0,0 1920x1200}'] });

const PHONE = { width: 375, height: 812 };

/** The toolbar icon, clicked on the tab showing `path` (the real listener; automation cannot click the icon). */
async function clickToolbarIcon(sw: Worker, path: string) {
  await sw.evaluate(async (p) => {
    const [tab] = await chrome.tabs.query({ url: `*://*${p}` });
    (chrome.action.onClicked as unknown as { dispatch(tab: chrome.tabs.Tab): void }).dispatch(tab!);
  }, path);
}

type Where = Page | Frame;
const layout = (where: Where) =>
  where.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    narrow: matchMedia('(max-width: 600px)').matches,
    toggle: getComputedStyle(document.querySelector('.nav-toggle')!).display !== 'none',
    nav: getComputedStyle(document.querySelector('header nav')!).display !== 'none',
  }));

async function pickPreset(where: Where, id: string) {
  await where.getByTestId('toolbar-viewport').click();
  await expect(where.getByTestId('viewport-menu')).toBeVisible();
  await where.getByTestId(`viewport-preset-${id}`).click();
}

/** Sets up the scripted speech (and the Process stub's key after Start), opens the page and shows the toolbar. */
async function openResponsive(context: BrowserContext, sw: Worker, site: { primaryOrigin: string }) {
  const page = await context.newPage();
  await page.goto(`${site.primaryOrigin}/responsive.html`);
  await page.bringToFront();
  // A window tall enough for 375×812 at 1:1 (scaling a larger size down is unit-tested geometry).
  const tab = await sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: '*://*/responsive.html' });
    await chrome.windows.update(t!.windowId, { width: 1440, height: 1100 });
    await new Promise((r) => setTimeout(r, 300));
    return chrome.tabs.get(t!.id!);
  });
  expect(tab.height).toBeGreaterThanOrEqual(PHONE.height);
  // Playwright emulates its own 1280×720 viewport in each page; make it the tab's real size, as it is for a person.
  await page.setViewportSize({ width: tab.width!, height: tab.height! });
  await clickToolbarIcon(sw, '/responsive.html');
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'idle');
  expect(await layout(page)).toMatchObject({ narrow: false, toggle: false, nav: true });
  return page;
}

/** At 375×812: the real viewport, so media queries follow. */
async function expectPhone(where: Where) {
  await expect
    .poll(() => layout(where))
    .toMatchObject({ width: 375, height: 812, narrow: true, toggle: true, nav: false });
  await expect(where.getByTestId('toolbar-viewport')).toHaveText('375×812');
}

async function drawOnCta(where: Where, page: Page, sw: Worker, sessionId: string) {
  await where.getByTestId('toolbar-draw').click();
  await expect(where.getByTestId('toolbar-draw')).toHaveAttribute('aria-pressed', 'true');
  const cta = (await where.locator('button.cta').boundingBox())!;
  await circle(page, cta);
  await expect
    .poll(async () => ofType(await swEvents(sw, sessionId), 'annotation').length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  await where.getByTestId('toolbar-draw').click();
  await expect(where.getByTestId('toolbar-draw')).toHaveAttribute('aria-pressed', 'false');
}

async function swEvents(sw: Worker, sessionId: string): Promise<TimelineEvent[]> {
  return sw.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const rows = await new Promise<TimelineEvent[]>((res, rej) => {
      const r = idb.transaction('events').objectStore('events').index('session_id').getAll(id);
      r.onsuccess = () => res(r.result as TimelineEvent[]);
      r.onerror = () => rej(r.error);
    });
    idb.close();
    return rows;
  }, sessionId);
}

/** Drags the frame host's right handle so the frame's width becomes `width`; the readout follows the drag. */
async function dragFrameHandleTo(page: Page, from: number, width: number) {
  const handle = (await page.getByTestId('viewport-handle-right').boundingBox())!;
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + (width - from) / 2, y, { steps: 4 });
  await page.mouse.move(x + (width - from), y, { steps: 4 });
  await expect(page.getByTestId('viewport-readout')).toHaveText(`${width}×812`);
  await page.mouse.up();
}

/** The screenshot blob's size in px, read in an extension page. */
async function imageSize(extPage: Page, screenshotId: string) {
  return extPage.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
    });
    const row = await new Promise<{ blob: Blob }>((res) => {
      const r = idb.transaction('blobs').objectStore('blobs').get(id);
      r.onsuccess = () => res(r.result);
    });
    const bmp = await createImageBitmap(row.blob);
    return { width: bmp.width, height: bmp.height };
  }, screenshotId);
}

/** The Annotation drawn at 375×812 and its screenshot: exactly that viewport. */
async function expectPhoneAnnotation(review: Page, events: TimelineEvent[]) {
  const annotation = ofType(events, 'annotation')[0]!;
  expect(annotation.viewport).toEqual(PHONE);
  const shot = ofType(events, 'screenshot').find((s) => s.screenshot_id === annotation.screenshot_id)!;
  expect(shot, 'the Annotation has its screenshot').toBeTruthy();
  expect(shot.viewport).toEqual(PHONE);
  const img = await imageSize(review, shot.screenshot_id);
  expect(img).toEqual({ width: Math.round(PHONE.width * shot.dpr), height: Math.round(PHONE.height * shot.dpr) });
  // Its corners are the page (the white header, the #fafafa body), not the frame host's backdrop or the tab beyond.
  const isPage = ([r, g, b]: [number, number, number]) => r >= 240 && g >= 240 && b >= 240;
  for (const [x, y] of [
    [3, 3],
    [img.width - 4, 3],
    [3, img.height - 4],
    [img.width - 4, img.height - 4],
  ] as const) {
    const px = (await screenshotPixel(review, shot.screenshot_id, x, y))!;
    expect(isPage(px), `pixel ${px} at ${x},${y}`).toBe(true);
  }
  return annotation;
}

const framed = (page: Page) => page.frame({ name: 'var-viewport-frame' });

/** Start, 375 preset (the tab reloads into the frame host), draw in the frame, drag it to 900, Reset: the Session. */
async function recordResized(
  context: BrowserContext,
  sw: Worker,
  site: { primaryOrigin: string },
  beforeStart?: () => Promise<void>,
) {
  const page = await openResponsive(context, sw, site);
  await page.getByTestId('toolbar-start').click();
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'recording');
  const sessionId = (await activeSessionId(sw))!;
  await beforeStart?.();

  await pickPreset(page, '375x812');
  await expect(page).toHaveURL(/\/viewport\.html\?u=/);
  await expect(page.getByTestId('viewport-readout')).toHaveText('375×812');
  await expect.poll(() => !!framed(page)).toBe(true);
  const frame = () => framed(page)!;
  // The framed page gets the overlay and the toolbar, still recording.
  await expect(frame().getByTestId('toolbar')).toHaveAttribute('data-state', 'recording', { timeout: 15_000 });
  await expectPhone(frame());
  await drawOnCta(frame(), page, sw, sessionId);

  // Freeform: the frame host's handle, next to the frame.
  await dragFrameHandleTo(page, 375, 900);
  await expect.poll(() => layout(frame())).toMatchObject({ width: 900, narrow: false, toggle: false });
  await expect(frame().getByTestId('toolbar-viewport')).toHaveText('900×812');

  // Reset from the toolbar in the frame: the tab gets the page back, still recording.
  await frame().getByTestId('toolbar-viewport').click();
  await frame().getByTestId('viewport-reset').click();
  await expect(page).toHaveURL(/\/responsive\.html$/);
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'recording', { timeout: 15_000 });
  await expect(page.getByTestId('toolbar-viewport')).toHaveText('Viewport');
  await expect.poll(async () => (await layout(page)).width).toBeGreaterThan(900);

  const changes = ofType(await swEvents(sw, sessionId), 'viewport_change');
  expect(changes.map((c) => [c.width, c.height, c.mechanism])).toEqual([
    [375, 812, 'frame_host'],
    [900, 812, 'frame_host'],
    [changes[2]!.width, changes[2]!.height, 'none'],
  ]);
  expect(changes.slice(0, 2).every((c) => c.scale === 1)).toBe(true);
  return { page, sessionId };
}

async function stopFromToolbar(context: BrowserContext, page: Page) {
  const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await page.getByTestId('toolbar-stop').click();
  const review = await reviewPromise;
  await expect(review.getByTestId('annotation').first()).toBeVisible({ timeout: 30_000 });
  return review;
}

async function exportReviewMd(review: Page, sw: Worker): Promise<string> {
  await review.evaluate(() => delete document.body.dataset.exportDownloadId);
  await review.getByTestId('export-zip').click();
  await expect(review.getByTestId('export-done')).toBeVisible({ timeout: 30_000 });
  const id = Number(await review.evaluate(() => document.body.dataset.exportDownloadId));
  const item = await sw.evaluate(async (i) => (await chrome.downloads.search({ id: i }))[0]!, id);
  const dir = mkdtempSync(join(tmpdir(), 'var-viewport-'));
  execFileSync('unzip', ['-q', item.filename, 'review.md', '-d', dir]);
  return readFileSync(join(dir, 'review.md'), 'utf8');
}

test('standalone: the 375 preset reloads the page into a 375 frame; the Annotation, its screenshot, the Change Item and review.md say 375; freeform to 900; Reset', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(150_000);
  // One Change Item from the Annotation; its agent_prompt says nothing of the size, so the post-pass must.
  const stub = await startAnthropicStub({
    onMessage: (req) => {
      const shot = /screenshot (s\d+)/.exec(scriptOf(req))?.[1] ?? 's1';
      const item = {
        id: 'item_0001',
        title: 'Keep the CTA visible on phones',
        category: 'layout',
        intent: 'The Get started button should stay prominent.',
        locations: [
          {
            role: 'subject',
            selector: 'button.cta',
            element: "button 'Get started'",
            url: '/responsive.html',
            screenshot: shot,
            annotation: 1,
          },
        ],
        evidence: { video: null, screenshots: [shot] },
        transcript: 'this button should go in the header',
        confidence: 0.9,
        agent_prompt: `On /responsive.html keep button.cta prominent. See screenshots/${shot}.png.`,
        pinned: false,
      };
      return messageReply(req.body.model, JSON.stringify({ items: [item] }));
    },
  });
  try {
    await useScriptedTranscript(serviceWorker, 'pricing-cta.json', 2000);
    await grantMic(openExtensionPage);
    const { page, sessionId } = await recordResized(context, serviceWorker, site, () =>
      serviceWorker.evaluate(async (base) => {
        const { devOverrides } = await chrome.storage.local.get('devOverrides');
        await chrome.storage.local.set({
          anthropicKey: 'sk-ant-e2e-viewport',
          devOverrides: { ...(devOverrides ?? {}), anthropicBaseUrl: base },
        });
      }, stub.baseURL),
    );
    // The size is remembered for this origin.
    const sizes = await serviceWorker.evaluate(
      async () => (await chrome.storage.local.get('viewportSizes')).viewportSizes as Record<string, unknown>,
    );
    expect(Object.values(sizes)).toEqual([{ width: 900, height: 812 }]);

    const review = await stopFromToolbar(context, page);
    const events = await sessionEvents(review, sessionId);
    const annotation = await expectPhoneAnnotation(review, events);
    // Strokes are in the resized viewport's coordinates: inside its 375 px width.
    const strokes = ofType(events, 'stroke').filter((s) => annotation.stroke_ids.includes(s.stroke_id));
    expect(strokes.flatMap((s) => s.points).every((p) => p.x >= 0 && p.x <= 375)).toBe(true);
    // The Session stays on the page under review: no navigation to our own page is logged.
    expect(ofType(events, 'navigation').every((n) => n.url.includes('/responsive.html'))).toBe(true);

    await review.getByTestId('process-button').click();
    await review.getByTestId('process-confirm').click();
    await expect(review.getByTestId('change-item')).toHaveCount(1, { timeout: 20_000 });
    const md = await exportReviewMd(review, serviceWorker);
    expect(md).toMatch(
      /^Viewport: resized for the review: 375×812 from \d\d:\d\d, 900×812 from \d\d:\d\d, the tab's own size from \d\d:\d\d\./m,
    );
    expect(md).toContain(
      "button 'Get started' `button.cta` on /responsive.html at 375 px wide (375×812) (Annotation #1)",
    );
    expect(md).toMatch(/keep button\.cta prominent[\s\S]*at 375 px wide \(375×812\); check it at that size\./);
  } finally {
    await stub.close();
  }
});

test('paired: the resized Session reaches the host, viewport_change and all', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(150_000);
  const data = tempDataDir();
  const host = await HostProcess.start(data.dir);
  try {
    const { options, token } = await pairThroughOptions(serviceWorker, openExtensionPage, host);
    await options.close();
    await useScriptedTranscript(serviceWorker, 'pricing-cta.json', 2000);
    await grantMic(openExtensionPage);
    const { page, sessionId } = await recordResized(context, serviceWorker, site);
    // Streamed live: the host has the sizes before Stop.
    await expect
      .poll(
        async () =>
          (await host.get<TimelineEvent[]>(`/api/sessions/${sessionId}/events`, token)).filter(
            (e) => e.type === 'viewport_change',
          ).length,
        { timeout: 15_000 },
      )
      .toBe(3);
    const review = await stopFromToolbar(context, page);
    const events = await sessionEvents(review, sessionId);
    const annotation = await expectPhoneAnnotation(review, events);
    await expect
      .poll(async () => (await host.get<TimelineEvent[]>(`/api/sessions/${sessionId}/events`, token)).length, {
        timeout: 30_000,
      })
      .toBe(events.length);
    const remote = await host.get<TimelineEvent[]>(`/api/sessions/${sessionId}/events`, token);
    expect(
      ofType(remote, 'viewport_change')
        .map((c) => c.width)
        .slice(0, 2),
    ).toEqual([375, 900]);
    expect(ofType(remote, 'annotation')[0]!.viewport).toEqual(PHONE);
    expect((await host.blob(annotation.screenshot_id!, token)).status).toBe(200);
  } finally {
    await host.kill();
    data.remove();
  }
});

test('a page that refuses framing gets the control with the reason, and no sizes', async ({
  context,
  serviceWorker,
  site,
}) => {
  // A page that loads while the extension installs gets the content script twice (the manifest's, and the
  // install-time injection into open tabs) and two toolbars: a known race outside E6, reported. The other tests open
  // their page after granting the mic; this one lets the install finish first.
  await serviceWorker.evaluate(() => new Promise((r) => setTimeout(r, 2000)));
  const page = await context.newPage();
  await page.goto(`${site.primaryOrigin}/no-frame.html`);
  await page.bringToFront();
  await clickToolbarIcon(serviceWorker, '/no-frame.html');
  const button = page.getByTestId('toolbar-viewport');
  await expect(button).toHaveAttribute('data-blocked', 'true');
  await button.click();
  await expect(page.getByTestId('viewport-blocked')).toContainText('X-Frame-Options: DENY');
  await expect(page.getByTestId('viewport-preset-375x812')).toHaveCount(0);
  // The same toolbar on a page that allows framing offers the sizes.
  await page.goto(`${site.primaryOrigin}/responsive.html`);
  await expect(page.getByTestId('toolbar-viewport')).toHaveAttribute('data-blocked', 'false');
});
