// E1 proof: the page's floating toolbar is a complete control surface with no panel open. The toolbar icon shows it;
// Start records the tab (its video through Chrome's tabCapture in the media context, allowed here by
// ALLOW_TAB_CAPTURE in place of the icon click); draw, speech from the fixture WAV (with the scripted transcript), Stop
// opens the review page with the Annotation and the transcript. The toolbar is never in a screenshot while the ink is,
// closing a panel does not stop a toolbar Session, and a dragged toolbar keeps its place across a reload. Runs
// standalone and paired with the real host.
import type { BrowserContext, Page, Worker } from '@playwright/test';
import type { TimelineEvent } from '../../packages/core/src/timeline.ts';
import { ALLOW_TAB_CAPTURE, expect, grantMic, test, useScriptedTranscript } from './fixtures';
import { circle } from './helpers/draw';
import { HostProcess, pairThroughOptions, tempDataDir } from './helpers/host';
import { storeRows } from './helpers/seed';
import { activeSessionId, ofType, screenshotPixel, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'review-two-notes.wav', extraArgs: [ALLOW_TAB_CAPTURE] });

/** The toolbar icon, clicked on the tab showing `path` (the real listener; automation cannot click the icon). */
async function clickToolbarIcon(sw: Worker, path: string) {
  await sw.evaluate(async (p) => {
    const [tab] = await chrome.tabs.query({ url: `*://*${p}` });
    (chrome.action.onClicked as unknown as { dispatch(tab: chrome.tabs.Tab): void }).dispatch(tab!);
  }, path);
}

/** Annotations logged so far, read by the service worker (no extension page needed). */
function annotationCount(sw: Worker, sessionId: string): Promise<number> {
  return sw.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const rows = await new Promise<{ type: string }[]>((res, rej) => {
      const r = idb.transaction('events').objectStore('events').index('session_id').getAll(id);
      r.onsuccess = () => res(r.result as { type: string }[]);
      r.onerror = () => rej(r.error);
    });
    idb.close();
    return rows.filter((e) => e.type === 'annotation').length;
  }, sessionId);
}

const isToolbarInk = ([r, g, b]: [number, number, number]) => r < 60 && g < 60 && b < 60;
const isRed = ([r, g, b]: [number, number, number]) => r > 150 && g < 110 && b < 110;

async function recordFromToolbar(
  context: BrowserContext,
  sw: Worker,
  site: { primaryOrigin: string },
  onHost?: { host: HostProcess; token: string },
) {
  // No panel anywhere: only the pages the test opens and the onboarding tab from install.
  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  expect(context.pages().some((p) => p.url().includes('sidepanel.html'))).toBe(false);

  await clickToolbarIcon(sw, '/pricing.html');
  const toolbar = pricing.getByTestId('toolbar');
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveAttribute('data-state', 'idle');
  // The host dot appears only while paired.
  await expect(pricing.getByTestId('toolbar-host')).toHaveCount(onHost ? 1 : 0);
  if (onHost) await expect(pricing.getByTestId('toolbar-host')).toHaveAttribute('data-state', 'connected');

  await pricing.getByTestId('toolbar-start').click();
  await expect(toolbar).toHaveAttribute('data-state', 'recording');
  await expect(pricing.getByTestId('toolbar-timer')).toHaveText(/^00:0\d$/);
  const sessionId = (await activeSessionId(sw))!;
  // Video without a picker: tabCapture, recorded by the media context.
  const video = await sw.evaluate(
    async () =>
      (
        (await chrome.storage.session.get('activeSession')).activeSession as {
          video: { state: string; recorder?: string };
        }
      ).video,
  );
  expect(video).toMatchObject({ state: 'recording', recorder: 'media_context' });

  await pricing.getByTestId('toolbar-draw').click();
  await expect(pricing.getByTestId('toolbar-draw')).toHaveAttribute('aria-pressed', 'true');
  const cta = (await pricing.locator('button.cta').boundingBox())!;
  await circle(pricing, cta);
  await expect.poll(() => annotationCount(sw, sessionId), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  // The scripted caption reaches the toast strip.
  await expect(pricing.getByTestId('toolbar-toast')).toHaveText('this button should go in the header', {
    timeout: 15_000,
  });
  const bar = (await toolbar.boundingBox())!;
  return { pricing, sessionId, cta, bar };
}

async function stopFromToolbar(context: BrowserContext, pricing: Page) {
  const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await pricing.getByTestId('toolbar-stop').click();
  const review = await reviewPromise;
  await expect(pricing.getByTestId('toolbar')).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
  return review;
}

/** The Annotation's screenshot shows the ink but not the toolbar. */
async function expectCleanShot(
  review: Page,
  events: TimelineEvent[],
  cta: { x: number; y: number; width: number; height: number },
  bar: { x: number; y: number; width: number; height: number },
) {
  const annotation = ofType(events, 'annotation')[0]!;
  const shot = ofType(events, 'screenshot').find((s) => s.screenshot_id === annotation.screenshot_id)!;
  expect(shot, 'the Annotation has its own screenshot').toBeTruthy();
  const dpr = shot.dpr;
  // Several points across the toolbar's rect: none is the toolbar's dark background.
  for (const [fx, fy] of [
    [0.5, 0.5],
    [0.2, 0.5],
    [0.8, 0.5],
    [0.5, 0.2],
  ] as const) {
    const px = (await screenshotPixel(
      review,
      shot.screenshot_id,
      (bar.x + bar.width * fx) * dpr,
      (bar.y + bar.height * fy) * dpr,
    ))!;
    expect(isToolbarInk(px), `pixel ${px} at the toolbar's place (${fx}, ${fy})`).toBe(false);
  }
  // The ink stays: the circle's rightmost point, drawn 8% outside the button, is red.
  const cy = cta.y + cta.height / 2;
  const cx = cta.x + cta.width / 2 + (cta.width / 2) * 1.08;
  let red = false;
  for (let d = -4; d <= 4 && !red; d++)
    red = isRed((await screenshotPixel(review, shot.screenshot_id, (cx + d) * dpr, cy * dpr))!);
  expect(red, 'the Stroke is in the screenshot').toBe(true);
}

async function dragAndReload(sw: Worker, pricing: Page) {
  const grip = (await pricing.getByTestId('toolbar-grip').boundingBox())!;
  const before = (await pricing.getByTestId('toolbar').boundingBox())!;
  await pricing.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await pricing.mouse.down();
  await pricing.mouse.move(grip.x - 300, grip.y - 250, { steps: 8 });
  await pricing.mouse.up();
  const moved = (await pricing.getByTestId('toolbar').boundingBox())!;
  expect(Math.round(before.x - moved.x)).toBeGreaterThan(250);
  expect(Math.round(before.y - moved.y)).toBeGreaterThan(200);
  // Saved when the drag ended; a reload mounts it where it was left.
  await expect
    .poll(() => sw.evaluate(async () => (await chrome.storage.local.get('toolbarPosition')).toolbarPosition as unknown))
    .toMatchObject({ x: Math.round(moved.x), y: Math.round(moved.y), collapsed: false });
  await pricing.reload();
  await expect(pricing.getByTestId('toolbar')).toBeVisible();
  const after = (await pricing.getByTestId('toolbar').boundingBox())!;
  expect(Math.abs(after.x - moved.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.y - moved.y)).toBeLessThanOrEqual(1);
}

test('standalone: Start from the toolbar with no panel open, draw, talk, Stop; the toolbar is not in the screenshot and stays where it was dragged', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  await useScriptedTranscript(serviceWorker, 'pricing-cta.json', 2000);
  await grantMic(openExtensionPage);
  const { pricing, sessionId, cta, bar } = await recordFromToolbar(context, serviceWorker, site);

  // A panel opened and closed during a toolbar Session does not stop it (ADR 0004).
  const panel = await openExtensionPage('sidepanel.html');
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  await panel.close();
  await pricing.waitForTimeout(500);
  expect(await activeSessionId(serviceWorker)).toBe(sessionId);
  await pricing.bringToFront();

  const review = await stopFromToolbar(context, pricing);
  await expect(review.getByTestId('annotation').first()).toBeVisible();
  await expect(
    review.getByTestId('segment-text').filter({ hasText: 'this button should go in the header' }),
  ).toHaveCount(1);
  const events = await sessionEvents(review, sessionId);
  expect(ofType(events, 'session_end')[0]!.reason).toBe('stop');
  const [row] = (await storeRows<{ id: string; video: { blob_id: string } | null }>(review, 'sessions')).filter(
    (s) => s.id === sessionId,
  );
  expect(row!.video, 'the tab video was recorded').not.toBeNull();
  await expectCleanShot(review, events, cta, bar);
  // Never paired: nothing for a host.
  expect(await storeRows(review, 'outbox')).toEqual([]);

  await pricing.bringToFront();
  await dragAndReload(serviceWorker, pricing);
});

test('paired: the same toolbar Session streams to the host, with the host dot on the toolbar', async ({
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
    const { pricing, sessionId, cta, bar } = await recordFromToolbar(context, serviceWorker, site, { host, token });
    // Streamed live: the host has the Annotation before Stop.
    await expect
      .poll(
        async () =>
          (await host.get<TimelineEvent[]>(`/api/sessions/${sessionId}/events`, token)).filter(
            (e) => e.type === 'annotation',
          ).length,
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(1);
    const review = await stopFromToolbar(context, pricing);
    await expect(review.getByTestId('annotation').first()).toBeVisible();
    await expect(
      review.getByTestId('segment-text').filter({ hasText: 'this button should go in the header' }),
    ).toHaveCount(1);
    const events = await sessionEvents(review, sessionId);
    await expectCleanShot(review, events, cta, bar);

    await expect.poll(async () => (await storeRows(review, 'outbox')).length, { timeout: 30_000 }).toBe(0);
    const remote = await host.get<TimelineEvent[]>(`/api/sessions/${sessionId}/events`, token);
    expect(remote.map((e) => e.id).sort()).toEqual(events.map((e) => e.id).sort());
    const shot = ofType(events, 'screenshot')[0]!;
    expect((await host.blob(shot.screenshot_id, token)).status).toBe(200);

    await pricing.bringToFront();
    await dragAndReload(serviceWorker, pricing);
  } finally {
    await host.kill();
    data.remove();
  }
});

test.describe('without the tab invoked', () => {
  // No ALLOW_TAB_CAPTURE: as when the tab navigated after the icon click. Chrome refuses tabCapture.
  test.use({ extraArgs: [] });

  test('Start from the toolbar still records, without video, and the toolbar says so', async ({
    context,
    serviceWorker,
    site,
    openExtensionPage,
  }) => {
    await useScriptedTranscript(serviceWorker, 'pricing-cta.json');
    await grantMic(openExtensionPage);
    const pricing = await context.newPage();
    await pricing.goto(`${site.primaryOrigin}/pricing.html`);
    await clickToolbarIcon(serviceWorker, '/pricing.html');
    await pricing.getByTestId('toolbar-start').click();
    await expect(pricing.getByTestId('toolbar')).toHaveAttribute('data-state', 'recording');
    await expect(pricing.getByTestId('toolbar-no-video')).toHaveText('No video');
    const video = await serviceWorker.evaluate(
      async () => ((await chrome.storage.session.get('activeSession')).activeSession as { video: unknown }).video,
    );
    expect(video).toEqual({ state: 'off', reason: 'unavailable' });
    await stopFromToolbar(context, pricing);
  });
});
