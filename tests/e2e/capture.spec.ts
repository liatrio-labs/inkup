// Slice 1 proof (docs/PLAN.md): a real Session on the fixture site through the real service worker, offscreen
// document, content script, Dexie and captureVisibleTab, with the scripted transcript adapter standing in for
// Web Speech (headless Chromium has no on-device speech pack). The fake mic plays a fixture WAV, so the audio
// recorder records real audio.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { type SessionDocument, SessionDocumentSchema } from '../../packages/core/src/session-document.ts';
import type { EventOf } from '../../packages/core/src/timeline.ts';
import { expect, grantMic, test, useScriptedTranscript } from './fixtures';
import { circle } from './helpers/draw';

test.use({ fakeAudio: 'review-two-notes.wav' });

/** Reads a blob row straight from the extension's IndexedDB in an extension page. */
function inspectBlob(page: Page, id: string) {
  return page.evaluate(async (blobId) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const row = await new Promise<{ kind: string; blob: Blob } | undefined>((res, rej) => {
      const r = idb.transaction('blobs').objectStore('blobs').get(blobId);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!row) return null;
    const head = Array.from(new Uint8Array(await row.blob.slice(0, 8).arrayBuffer()));
    let mediaDuration: number | null = null;
    if (row.kind === 'audio') {
      const audio = new Audio(URL.createObjectURL(row.blob));
      mediaDuration = await new Promise<number>((res) => {
        audio.onloadedmetadata = () => res(audio.duration);
        audio.onerror = () => res(Number.NaN);
      });
    }
    return { kind: row.kind, size: row.blob.size, type: row.blob.type, head, mediaDuration };
  }, id);
}

test('capture spine: draw around the CTA while speaking, Stop, download a valid session.json', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(90_000);
  await useScriptedTranscript(serviceWorker, 'pricing-cta.json', 2000);
  await grantMic(openExtensionPage);

  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  const panel = await openExtensionPage('sidepanel.html');

  // Start: bound to the pricing tab.
  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  await expect(panel.getByTestId('recording-tab')).toContainText('Pricing Fixture');
  await expect(panel.getByTestId('timer')).toHaveText(/^\d\d:\d\d$/);

  // Draw mode from the panel toggles the canvas in the page's shadow root.
  await panel.getByTestId('draw-toggle').click();
  await expect(panel.getByTestId('draw-toggle')).toHaveAttribute('aria-pressed', 'true');
  const canvas = pricing.locator('var-review-overlay canvas');
  await expect(canvas).toHaveCSS('pointer-events', 'auto');
  // Nothing but the overlay host was added to the page.
  expect(await pricing.evaluate(() => document.querySelectorAll('var-review-overlay').length)).toBe(1);

  await pricing.bringToFront();
  const cta = await pricing.locator('button.cta').boundingBox();
  await circle(pricing, cta!);

  // The Annotation closes after the 1.5 s gap; the panel counts it and shows the scripted caption.
  await expect(panel.getByTestId('annotation-count')).toHaveText('1', { timeout: 10_000 });
  await expect(panel.getByTestId('captions')).toContainText('this button should go in the header', { timeout: 10_000 });
  // Strokes fade after the screenshot: the canvas is transparent again within fade (2 s) + margin.
  await expect
    .poll(
      () =>
        canvas.evaluate((c: HTMLCanvasElement) => {
          const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          for (let i = 3; i < px.length; i += 4) if (px[i]! > 0) return 'ink';
          return 'clear';
        }),
      { timeout: 6_000 },
    )
    .toBe('clear');
  // Let a few 2 s audio chunks land.
  await panel.waitForTimeout(2500);

  const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await panel.getByTestId('stop').click();
  const review = await reviewPromise;
  await expect(panel.getByTestId('status')).toHaveText('Ready');
  // The overlay is gone from the page after Stop.
  await expect(pricing.locator('var-review-overlay')).toHaveCount(0);

  await expect(review.getByTestId('annotation')).toHaveCount(1);
  await expect(review.getByTestId('annotation-screenshot')).toBeVisible();
  // The Annotation list draws that Annotation's Strokes over its screenshot.
  await expect(
    review.getByTestId('annotation-screenshot').getByTestId('stroke-overlay').locator('path').first(),
  ).toBeAttached();
  await review.getByTestId('download-session').click();
  await expect(review.getByRole('status')).toContainText('Downloading session.json');
  const downloadId = Number(await review.evaluate(() => document.body.dataset.downloadId));
  const file = await expect
    .poll(async () => serviceWorker.evaluate(async (id) => (await chrome.downloads.search({ id }))[0], downloadId), {
      timeout: 10_000,
    })
    .toMatchObject({ state: 'complete' })
    .then(() => serviceWorker.evaluate(async (id) => (await chrome.downloads.search({ id }))[0]!.filename, downloadId));

  await test.info().attach('session.json', { path: file, contentType: 'application/json' });
  const shotSrc = await review.getByTestId('annotation-screenshot').locator('img').getAttribute('src');
  const shotB64 = await review.evaluate(async (src) => {
    const bytes = new Uint8Array(await (await fetch(src!)).arrayBuffer());
    let bin = '';
    bytes.forEach((b) => {
      bin += String.fromCharCode(b);
    });
    return btoa(bin);
  }, shotSrc);
  await test
    .info()
    .attach('annotation-screenshot.png', { body: Buffer.from(shotB64, 'base64'), contentType: 'image/png' });
  // CAPTURE_DUMP=<dir> keeps the artifacts of a passing run for inspection.
  if (process.env.CAPTURE_DUMP) {
    mkdirSync(process.env.CAPTURE_DUMP, { recursive: true });
    copyFileSync(file, join(process.env.CAPTURE_DUMP, 'session.json'));
    writeFileSync(join(process.env.CAPTURE_DUMP, 'annotation-screenshot.png'), Buffer.from(shotB64, 'base64'));
  }

  // 1. session.json validates against the schema.
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const doc: SessionDocument = SessionDocumentSchema.parse(raw);
  expect(doc.events[0]!.type).toBe('session_start');
  expect(doc.events.at(-1)!.type).toBe('session_end');

  // 2. One Annotation whose geometric pick resolves to button.cta on the page.
  const annotations = doc.events.filter((e): e is EventOf<'annotation'> => e.type === 'annotation');
  expect(annotations).toHaveLength(1);
  const ann = annotations[0]!;
  expect(ann.resolution).toBe('element');
  const pick = ann.candidates[ann.pick!]!;
  expect(pick).toMatchObject({ relation: 'pick', tag: 'button', role: 'button', name: 'Get started' });
  expect(pick.selector).toBe('button.cta');
  expect(
    await pricing.evaluate(
      (sel) => document.querySelector(sel) === document.querySelector('button.cta'),
      pick.selector,
    ),
  ).toBe(true);
  expect(ann.candidates.filter((c) => c.relation === 'ancestor').map((c) => c.tag)).toEqual(
    expect.arrayContaining(['div', 'section']),
  );
  const strokes = doc.events.filter((e): e is EventOf<'stroke'> => e.type === 'stroke');
  expect(ann.stroke_ids).toEqual(strokes.map((s) => s.stroke_id));
  await expect(
    review.getByTestId('annotation-screenshot').getByTestId('stroke-overlay').locator('[data-stroke-id]'),
  ).toHaveCount(strokes.length);
  expect(strokes[0]!.points.length).toBeGreaterThan(20);
  expect(strokes[0]).toMatchObject({
    url: `${site.primaryOrigin}/pricing.html`,
    dpr: expect.any(Number),
    viewport: { width: expect.any(Number) },
  });

  // 3. A screenshot blob referenced by that Annotation, stored as a PNG.
  expect(ann.screenshot_id).toBeTruthy();
  const shot = doc.events.find(
    (e): e is EventOf<'screenshot'> => e.type === 'screenshot' && e.screenshot_id === ann.screenshot_id,
  )!;
  expect(shot).toMatchObject({
    trigger: 'annotation',
    annotation_id: ann.annotation_id,
    path: `screenshots/${ann.screenshot_id}.png`,
  });
  expect(doc.blobs.find((b) => b.id === ann.screenshot_id)).toMatchObject({ kind: 'screenshot', mime: 'image/png' });
  const png = await inspectBlob(review, ann.screenshot_id!);
  expect(png?.head.slice(0, 4)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(png!.size).toBeGreaterThan(1000);

  // 4. Audio recorded in chunks, finalized into one seekable WebM with a duration.
  const audio = doc.media.audio!;
  expect(audio.chunk_count).toBeGreaterThanOrEqual(2);
  expect(audio.duration_ms).toBeGreaterThan(3000);
  const webm = await inspectBlob(review, audio.blob_id);
  expect(webm?.head.slice(0, 4)).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  expect(webm!.mediaDuration).toBeGreaterThan(3);
  expect(Number.isFinite(webm!.mediaDuration)).toBe(true);

  // 5. The spoken sentence is a transcript_segment within 2 s of the Annotation.
  const seg = doc.events.find(
    (e): e is EventOf<'transcript_segment'> =>
      e.type === 'transcript_segment' && e.text === 'this button should go in the header',
  );
  expect(seg).toMatchObject({ engine: 'scripted', timestamp_quality: 'approximate' });
  const gap = Math.max(0, seg!.t - ann.t_end, ann.t - seg!.t_end);
  expect(gap).toBeLessThanOrEqual(2000);

  // The screenshot shows the Strokes: it was taken while they were held on screen (red ink pixels present).
  const inkPixels = await review.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, img.width, img.height).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i]! > 180 && px[i + 1]! < 90 && px[i + 2]! < 90) n++;
    return n;
  }, shotB64);
  expect(inkPixels).toBeGreaterThan(200);
});
