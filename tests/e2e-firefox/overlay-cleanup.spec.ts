// E9 proof in Firefox (tests/e2e/overlay-cleanup.spec.ts has the Chrome one): nothing drawn stays on the page for
// good, and Clear all empties it at once.
//
// Max lifetime: with the Annotation screenshot stubbed to never answer (devOverrides.hangAnnotationShots) and a short
// overlay cap (devOverrides.maxOverlayMs), a Stroke still leaves: the canvas has no ink pixels and keeps no Strokes, and
// the Annotation is recorded all the same, with screenshot_id null.
//
// Clear all: a Stroke drawn and cleared at once closes its Annotation with reason `cleared` and no screenshot. Then with
// ink on screen, an Object Select pick made and its comment box open, one click on Clear all leaves no ink, no outline
// and no box, and logs `overlay_cleared` with what it removed. The dropped pick is not recorded.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { stroke } from '../e2e/helpers/draw';
import { type ExtPage, expect, ROOT, test } from './fixtures';

type Ev = { type: string; stroke_ids: string[]; [k: string]: unknown };

function events(ext: ExtPage, sessionId: string): Promise<Ev[]> {
  return ext.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return new Promise<(Ev & { t: number; seq: number })[]>((res, rej) => {
      const r = idb.transaction('events').objectStore('events').index('session_id').getAll(id);
      r.onsuccess = () =>
        res((r.result as (Ev & { t: number; seq: number })[]).sort((a, b) => a.t - b.t || a.seq - b.seq));
      r.onerror = () => rej(r.error);
    });
  }, sessionId);
}
const ofType = (evs: Ev[], type: string) => evs.filter((e) => e.type === type);

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

/** Mic granted, `extra` dev overrides set, then a Session started from the toolbar's Start frame on the pricing page. */
async function start(
  context: BrowserContext,
  extPage: (part: string) => Promise<ExtPage>,
  origin: string,
  extra: Record<string, unknown>,
) {
  const onboarding = await extPage('/onboarding.html');
  const script = JSON.parse(readFileSync(join(ROOT, 'fixtures/transcripts/pricing-cta.json'), 'utf8'));
  await onboarding.evaluate((o) => chrome.storage.local.set(o), {
    devOverrides: { transcription: 'scripted', script, ...extra },
    captureSettings: { fadeMs: 5000 },
  });
  await onboarding.click('allow-mic');
  await onboarding.waitFor(() => !!document.querySelector('[data-testid="mic-status"]'), undefined, {
    timeout: 20_000,
    what: 'the mic grant',
  });
  const page = await context.newPage();
  await page.goto(`${origin}/pricing.html`);
  await onboarding.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://*/pricing.html' });
    await chrome.storage.session.set({ toolbarTabs: [tab!.id] });
  });
  const frame = page.getByTestId('toolbar-start-frame');
  await expect(frame).toBeVisible();
  await page.waitForTimeout(1000);
  const box = (await frame.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'recording', { timeout: 15_000 });
  const session = await onboarding.evaluate(
    async () => (await chrome.storage.session.get('activeSession')).activeSession as { id: string },
  );
  return { onboarding, page, sessionId: session.id };
}

async function setDraw(page: Page, on: boolean) {
  const draw = page.getByTestId('toolbar-draw');
  await expect(async () => {
    if ((await draw.getAttribute('aria-pressed')) !== String(on)) await draw.click();
    await expect(draw).toHaveAttribute('aria-pressed', String(on), { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
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

test('Firefox: a Stroke whose screenshot never answers leaves at the cap, and its Annotation is recorded with screenshot_id null', async ({
  context,
  extPage,
  site,
}) => {
  test.setTimeout(120_000);
  const {
    onboarding: ext,
    page,
    sessionId,
  } = await start(context, extPage, site.primaryOrigin, { maxOverlayMs: 2_500, hangAnnotationShots: true });
  await setDraw(page, true);
  await zigzag(page);
  // Held on screen while the screenshot is (never) taken.
  expect((await canvasState(page)).ink).toBeGreaterThan(100);
  // The cap (2.5 s after the pointer-up), then the sweeper (1 s) and the fade: the canvas is blank and keeps nothing.
  await expect.poll(() => canvasState(page), { timeout: 15_000 }).toEqual({ kept: 0, visible: 0, ink: 0 });
  // The close waited SHOT_TIMEOUT_MS for the screenshot, then recorded the Annotation without it.
  await expect.poll(async () => ofType(await events(ext, sessionId), 'annotation').length, { timeout: 20_000 }).toBe(1);
  const evs = await events(ext, sessionId);
  const [ann] = ofType(evs, 'annotation');
  expect(ann).toMatchObject({ screenshot_id: null, stroke_ids: [ofType(evs, 'stroke')[0]!.stroke_id] });

  await page.getByTestId('toolbar-stop').click();
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
});

test('Firefox: Clear all closes the open Annotation as cleared, and removes ink, a pick and its comment box at once', async ({
  context,
  extPage,
  site,
}) => {
  test.setTimeout(120_000);
  // Strokes stay 5 s after the pointer-up (the longest fade, set in start), long enough to make a pick while they show.
  const { onboarding: ext, page, sessionId } = await start(context, extPage, site.primaryOrigin, {});
  const clear = page.getByTestId('toolbar-clear');
  await expect(clear).toHaveAttribute('aria-label', 'Clear all');

  // 1. A Stroke cleared while its Annotation is still open.
  await setDraw(page, true);
  await zigzag(page);
  await clear.click();
  await expect.poll(() => canvasState(page)).toMatchObject({ visible: 0, ink: 0 });
  await expect.poll(async () => ofType(await events(ext, sessionId), 'annotation').length, { timeout: 15_000 }).toBe(1);
  let evs = await events(ext, sessionId);
  expect(ofType(evs, 'annotation')[0]).toMatchObject({ close_reason: 'cleared', screenshot_id: null });
  expect(ofType(evs, 'stroke')).toHaveLength(1);
  await expect
    .poll(async () => ofType(await events(ext, sessionId), 'overlay_cleared'))
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
  await expect.poll(async () => ofType(await events(ext, sessionId), 'overlay_cleared').length).toBe(2);
  evs = await events(ext, sessionId);
  expect(ofType(evs, 'overlay_cleared')[1]).toMatchObject({ strokes: 1, picks: 1, comments: 0 });
  // The dropped pick is not recorded; the Stroke's Annotation (closed by the pick) is.
  expect(
    ofType(evs, 'annotation').filter((a) => a.close_reason === 'object_select' && a.stroke_ids.length === 0),
  ).toHaveLength(0);
  expect(ofType(evs, 'stroke')).toHaveLength(2);

  await page.getByTestId('toolbar-stop').click();
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
});
