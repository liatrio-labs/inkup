// E9 proof: nothing drawn stays on the page for good, and Clear all empties it at once.
//
// Max lifetime: with the Annotation screenshot stubbed to never answer (devOverrides.hangAnnotationShots) and a short
// overlay cap (devOverrides.maxOverlayMs), a Stroke still leaves: the canvas has no ink pixels and keeps no Strokes, and
// the Annotation is recorded all the same, with screenshot_id null.
//
// Clear all: a Stroke drawn and cleared at once closes its Annotation with reason `cleared` and no screenshot. Then with
// ink on screen, an Object Select pick made and its comment box open, one click on Clear all leaves no ink, no outline
// and no box, and logs `overlay_cleared` with what it removed. The dropped pick is not recorded. The cleared
// Annotation is kept, and the review page names Clear all as what closed it.
import type { Page, Worker } from '@playwright/test';
import { ALLOW_TAB_CAPTURE, expect, grantMic, test } from './fixtures';
import { stroke } from './helpers/draw';
import { activeSessionId, ofType, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'review-two-notes.wav', extraArgs: [ALLOW_TAB_CAPTURE] });

/** The overlay canvas: Strokes it keeps, those drawn, and how many of its pixels have ink. */
const canvasState = (page: Page) =>
  page.evaluate(() => {
    const c = document
      .querySelector('var-review-overlay')!
      .shadowRoot!.querySelector<HTMLCanvasElement>('[data-testid="overlay-canvas"]')!;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) ink++;
    return { kept: Number(c.dataset.strokes ?? 0), visible: Number(c.dataset.visible ?? 0), ink };
  });

async function overrides(sw: Worker, extra: Record<string, unknown>) {
  await sw.evaluate(async (extra) => {
    const { devOverrides } = await chrome.storage.local.get('devOverrides');
    await chrome.storage.local.set({ devOverrides: { ...(devOverrides ?? {}), ...extra } });
  }, extra);
}

async function start(page: Page, sw: Worker, origin: string): Promise<string> {
  await page.goto(`${origin}/pricing.html`);
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://*/pricing.html' });
    (chrome.action.onClicked as unknown as { dispatch(tab: chrome.tabs.Tab): void }).dispatch(tab!);
  });
  await page.getByTestId('toolbar-start').click();
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'recording');
  return (await activeSessionId(sw))!;
}

async function setDraw(page: Page, on: boolean) {
  const draw = page.getByTestId('toolbar-draw');
  // One click: a state push landing mid-click no longer swaps the button out from under it (F1).
  if ((await draw.getAttribute('aria-pressed')) !== String(on)) await draw.click();
  await expect(draw).toHaveAttribute('aria-pressed', String(on));
}

const zigzag = (page: Page) => {
  const vp = page.viewportSize()!;
  return stroke(page, [
    [vp.width * 0.2, vp.height * 0.3],
    [vp.width * 0.3, vp.height * 0.35],
    [vp.width * 0.4, vp.height * 0.3],
    [vp.width * 0.5, vp.height * 0.35],
  ]);
};

test('a Stroke whose screenshot never answers leaves at the cap, and its Annotation is recorded with screenshot_id null', async ({
  context,
  serviceWorker: sw,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  await overrides(sw, { maxOverlayMs: 2_500, hangAnnotationShots: true });
  await grantMic(openExtensionPage);
  const page = await context.newPage();
  const sessionId = await start(page, sw, site.primaryOrigin);
  const ext = await openExtensionPage('sessions.html');
  await page.bringToFront();
  await setDraw(page, true);
  await zigzag(page);
  // Held on screen while the screenshot is (never) taken.
  expect((await canvasState(page)).ink).toBeGreaterThan(100);
  // The cap (2.5 s after the pointer-up), then the sweeper (1 s) and the fade: the canvas is blank and keeps nothing.
  await expect.poll(() => canvasState(page), { timeout: 15_000 }).toEqual({ kept: 0, visible: 0, ink: 0 });
  // The close waited SHOT_TIMEOUT_MS for the screenshot, then recorded the Annotation without it.
  await expect
    .poll(async () => ofType(await sessionEvents(ext, sessionId), 'annotation').length, { timeout: 20_000 })
    .toBe(1);
  const events = await sessionEvents(ext, sessionId);
  const [ann] = ofType(events, 'annotation');
  expect(ann).toMatchObject({ screenshot_id: null, stroke_ids: [ofType(events, 'stroke')[0]!.stroke_id] });

  await page.getByTestId('toolbar-stop').click();
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
});

test('Clear all closes the open Annotation as cleared, and removes ink, a pick and its comment box at once', async ({
  context,
  serviceWorker: sw,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  // Strokes stay 5 s after the pointer-up (the longest fade), long enough to make a pick while they show.
  await sw.evaluate(() => chrome.storage.local.set({ captureSettings: { fadeMs: 5000 } }));
  await grantMic(openExtensionPage);
  const page = await context.newPage();
  const sessionId = await start(page, sw, site.primaryOrigin);
  const ext = await openExtensionPage('sessions.html');
  await page.bringToFront();
  const clear = page.getByTestId('toolbar-clear');
  await expect(clear).toHaveAttribute('aria-label', 'Clear all');

  // 1. A Stroke cleared while its Annotation is still open.
  await setDraw(page, true);
  await zigzag(page);
  await clear.click();
  await expect.poll(() => canvasState(page)).toMatchObject({ visible: 0, ink: 0 });
  await expect
    .poll(async () => ofType(await sessionEvents(ext, sessionId), 'annotation').length, { timeout: 15_000 })
    .toBe(1);
  let events = await sessionEvents(ext, sessionId);
  expect(ofType(events, 'annotation')[0]).toMatchObject({ close_reason: 'cleared', screenshot_id: null });
  expect(ofType(events, 'stroke')).toHaveLength(1);
  await expect
    .poll(async () => ofType(await sessionEvents(ext, sessionId), 'overlay_cleared'))
    .toEqual([
      expect.objectContaining({ strokes: 1, picks: 0, comments: 0, url: expect.stringContaining('/pricing.html') }),
    ]);

  // 2. Ink on screen, then an Object Select pick with its comment box open.
  await zigzag(page);
  await page.getByTestId('toolbar-object-select').click();
  await expect(page.getByTestId('toolbar-object-select')).toHaveAttribute('aria-pressed', 'true');
  const cta = (await page.locator('button.cta').boundingBox())!;
  await page.mouse.move(cta.x + 10, cta.y + 10);
  await page.mouse.move(cta.x + cta.width / 2, cta.y + cta.height / 2, { steps: 3 });
  await expect(page.getByTestId('object-select-highlight')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('object-select-box')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('object-select-input').fill('never sent');
  const before = await canvasState(page);
  expect(before.visible).toBe(1);
  expect(before.ink).toBeGreaterThan(100);

  await clear.click();
  await expect.poll(() => canvasState(page)).toMatchObject({ visible: 0, ink: 0 });
  await expect(page.getByTestId('object-select-box')).toBeHidden();
  await expect(page.getByTestId('object-select-highlight')).toBeHidden();
  await expect.poll(async () => ofType(await sessionEvents(ext, sessionId), 'overlay_cleared').length).toBe(2);
  events = await sessionEvents(ext, sessionId);
  expect(ofType(events, 'overlay_cleared')[1]).toMatchObject({ strokes: 1, picks: 1, comments: 0 });
  // The dropped pick is not recorded; the Stroke's Annotation (closed by the pick) is.
  expect(
    ofType(events, 'annotation').filter((a) => a.close_reason === 'object_select' && a.stroke_ids.length === 0),
  ).toHaveLength(0);
  expect(ofType(events, 'stroke')).toHaveLength(2);

  await page.getByTestId('toolbar-stop').click();
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
  // The cleared Annotation is kept (Clear all is for stuck ink; Cancel is the discard), and the review page says so.
  const review = await openExtensionPage(`review.html?session=${encodeURIComponent(sessionId)}`);
  await expect(review.getByTestId('annotation-cleared')).toHaveText('closed by Clear all (no screenshot)', {
    timeout: 15_000,
  });
});
