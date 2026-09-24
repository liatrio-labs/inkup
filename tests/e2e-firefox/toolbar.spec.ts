// E1 in Firefox: the page's floating toolbar starts a Session with no sidebar open. Firefox has no tabCapture, so the
// toolbar's Start is an extension frame whose click opens the screen picker and records the video
// (docs/spikes/toolbar-start.md); the fake-media prefs grant the picker here. Draw, the scripted speech, Stop from the
// toolbar: the review page opens with the Annotation, whose screenshot shows the ink and not the toolbar.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TimelineEvent } from '../../packages/core/src/timeline.ts';
import { circle } from '../e2e/helpers/draw';
import { type ExtPage, expect, ROOT, test } from './fixtures';

function sessionEvents(page: ExtPage, sessionId: string): Promise<TimelineEvent[]> {
  return page.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return new Promise<TimelineEvent[]>((res, rej) => {
      const r = idb.transaction('events').objectStore('events').index('session_id').getAll(id);
      r.onsuccess = () => res(r.result as TimelineEvent[]);
      r.onerror = () => rej(r.error);
    });
  }, sessionId);
}

/** RGB of one pixel of a stored screenshot. */
function pixel(page: ExtPage, id: string, x: number, y: number): Promise<[number, number, number]> {
  return page.evaluate(
    async ({ id, x, y }) => {
      const idb = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('inkup');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const row = await new Promise<{ blob: Blob }>((res, rej) => {
        const r = idb.transaction('blobs').objectStore('blobs').get(id);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const bmp = await createImageBitmap(row.blob);
      const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return [d[0]!, d[1]!, d[2]!] as [number, number, number];
    },
    { id, x, y },
  );
}

test('Firefox: Start from the toolbar frame with no sidebar, draw, Stop; video from the frame, no toolbar in the screenshot', async ({
  context,
  extPage,
  site,
}) => {
  test.setTimeout(120_000);
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

  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  // What the toolbar icon does (RDP cannot click it): add the tab to the toolbar's tabs; the background pushes it.
  await onboarding.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://*/pricing.html' });
    await chrome.storage.session.set({ toolbarTabs: [tab!.id] });
  });
  const toolbar = pricing.getByTestId('toolbar');
  await expect(toolbar).toHaveAttribute('data-state', 'idle');
  const frame = pricing.getByTestId('toolbar-start-frame');
  await expect(frame).toBeVisible();
  // A real click inside the extension frame: the user activation the picker needs.
  await pricing.waitForTimeout(1000);
  const box = (await frame.boundingBox())!;
  await pricing.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(toolbar).toHaveAttribute('data-state', 'recording', { timeout: 15_000 });
  const session = await onboarding.evaluate(
    async () =>
      (await chrome.storage.session.get('activeSession')).activeSession as { id: string; video: { state: string } },
  );
  expect(session.video.state).toBe('recording');

  await pricing.getByTestId('toolbar-draw').click();
  await expect(pricing.getByTestId('toolbar-draw')).toHaveAttribute('aria-pressed', 'true');
  const cta = (await pricing.locator('button.cta').boundingBox())!;
  await circle(pricing, cta);
  await onboarding.waitFor(
    async (id) => {
      const idb = await new Promise<IDBDatabase>((res) => {
        const r = indexedDB.open('inkup');
        r.onsuccess = () => res(r.result);
      });
      const rows = await new Promise<{ type: string }[]>((res) => {
        const r = idb.transaction('events').objectStore('events').index('session_id').getAll(id);
        r.onsuccess = () => res(r.result as { type: string }[]);
      });
      return rows.some((e) => e.type === 'annotation');
    },
    session.id,
    { what: 'an Annotation' },
  );
  const bar = (await toolbar.boundingBox())!;

  await pricing.getByTestId('toolbar-stop').click();
  const review = await extPage('/review.html', 30_000);
  await review.waitFor(() => !!document.querySelector('[data-testid="annotation"]'), undefined, {
    what: 'the Annotation on the review page',
  });

  const events = await sessionEvents(review, session.id);
  const annotation = events.find((e): e is Extract<TimelineEvent, { type: 'annotation' }> => e.type === 'annotation')!;
  const shot = events.find(
    (e): e is Extract<TimelineEvent, { type: 'screenshot' }> =>
      e.type === 'screenshot' && e.screenshot_id === annotation.screenshot_id,
  )!;
  expect(shot).toBeTruthy();
  const [r, g, b] = await pixel(
    review,
    shot.screenshot_id,
    (bar.x + bar.width / 2) * shot.dpr,
    (bar.y + bar.height / 2) * shot.dpr,
  );
  expect(r < 60 && g < 60 && b < 60, `pixel ${[r, g, b]} at the toolbar's place`).toBe(false);
  // The frame recorded the picked surface.
  const row = await review.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
    });
    return new Promise<{ video: { chunk_count: number } | null; video_off_reason?: string }>((res) => {
      const r = idb.transaction('sessions').objectStore('sessions').get(id);
      r.onsuccess = () => res(r.result);
    });
  }, session.id);
  expect(
    row.video?.chunk_count ?? 0,
    `video ${JSON.stringify(row.video)}, off: ${row.video_off_reason}`,
  ).toBeGreaterThan(0);
});
