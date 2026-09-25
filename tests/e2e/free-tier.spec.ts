// P0-15 privacy: with the default settings the free tier never uses Chrome's server speech recognizer.
// Headless Chromium has no on-device speech pack (available() → 'downloadable'), which is exactly the case
// under test. The adapter-level proof that no recognizer is constructed is in
// tests/unit/adapters/transcription.test.ts; this checks the product behavior end to end.
import type { Page } from '@playwright/test';
import { expect, grantMic, test } from './fixtures';

/** A stored row, read loosely: the fields these checks use, and whatever else it has. */
type Row = { type?: string; audio?: { duration_ms: number }; [k: string]: unknown };

/** All rows of one IndexedDB store, read from an extension page. */
function readStore(page: Page, store: 'events' | 'sessions') {
  return page.evaluate(async (name) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return new Promise<Row[]>((res, rej) => {
      const r = idb.transaction(name).objectStore(name).getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }, store);
}

test('without on-device speech and without the opt-in, a Session records with captions off and logs the fallback', async ({
  context,
  site,
  openExtensionPage,
}) => {
  await grantMic(openExtensionPage);
  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  const panel = await openExtensionPage('sidepanel.html');
  // Before Start the panel offers the language pack.
  await expect(panel.getByTestId('speech-pack-offer')).toContainText('On-device captions are not installed');

  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  await expect(panel.getByTestId('captions-off')).toContainText('Live captions are off');
  await expect(panel.getByTestId('server-speech')).toHaveCount(0);
  await panel.waitForTimeout(1500);

  const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await panel.getByTestId('stop').click();
  const review = await reviewPromise;
  await expect(review.getByTestId('session-name')).toBeVisible();

  const [session] = await readStore(review, 'sessions');
  expect(session!.transcription).toEqual({ engine: 'webspeech', local: true, timestamp_quality: 'approximate' });
  expect(session!.audio!.duration_ms).toBeGreaterThan(1000);
  const events = await readStore(review, 'events');
  expect(events.filter((e) => e.type === 'transcription_fallback')).toEqual([
    expect.objectContaining({ from: 'webspeech-on-device', to: 'none', reason: 'on_device_unavailable' }),
  ]);
  expect(events.some((e) => e.type === 'transcript_segment')).toBe(false);
});

test('the server speech opt-in is off by default and says audio goes to Google', async ({ openExtensionPage }) => {
  const onboarding = await openExtensionPage('onboarding.html');
  const box = onboarding.getByTestId('allow-server-speech');
  await expect(box).not.toBeChecked();
  await expect(
    onboarding.getByText('Allow Chrome server speech recognition when on-device is unavailable'),
  ).toBeVisible();
  await expect(onboarding.getByText('your audio goes to Google')).toBeVisible();
  await box.click();
  await expect(box).toBeChecked();
  await expect
    .poll(() => onboarding.evaluate(() => chrome.storage.local.get('allowServerSpeech')))
    .toEqual({ allowServerSpeech: true });
});
