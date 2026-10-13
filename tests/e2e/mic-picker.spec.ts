// The toolbar's microphone picker, with Chromium's fake audio inputs (every one plays the fixture WAV).
// (a) Before Start, without the microphone grant: the picker says it is not allowed yet and offers setup.
// (b) Before Start, granted: opening the menu lists the media context's inputs (the offscreen document opened just to
//     list them, then closed again); the remembered input is what the next Start opens.
// (c) Mid-Session: a pick switches the input live. The Session goes on (no restart), Mute still works, and Stop leaves
//     one audio file covering the whole Session.
// (d) A remembered input that is gone: Start falls back to the system default, shown checked; the Session has voice.
import type { Page, Worker } from '@playwright/test';
import { expect, grantMic, test } from './fixtures';
import { activeSessionId, ofType, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'review-two-notes.wav' });

async function showToolbar(sw: Worker, page: Page) {
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://*/pricing.html' });
    (chrome.action.onClicked as unknown as { dispatch(tab: chrome.tabs.Tab): void }).dispatch(tab!);
  });
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'idle');
}

const offscreenOpen = (sw: Worker) =>
  sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as never] })).length);

const remembered = (sw: Worker) =>
  sw.evaluate(async () => ((await chrome.storage.local.get('micDevice')).micDevice as string | null) ?? null);

type Mic = { devices: { id: string; label: string }[]; selected: string | null; live: boolean } | null;
const sessionMic = (sw: Worker) =>
  sw.evaluate(
    async () =>
      ((await chrome.storage.session.get('activeSession')).activeSession as { mic?: Mic } | null)?.mic ?? null,
  );

/** The Session's stored audio: the one finished file, and any chunks left over. */
function audioRows(sw: Worker, sessionId: string) {
  return sw.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const blobs = await new Promise<{ kind: string; size: number }[]>((res, rej) => {
      const r = idb.transaction('blobs').objectStore('blobs').index('session_id').getAll(id);
      r.onsuccess = () => res(r.result as { kind: string; size: number }[]);
      r.onerror = () => rej(r.error);
    });
    const session = await new Promise<{ audio: { duration_ms: number } | null; duration_ms: number | null }>(
      (res, rej) => {
        const r = idb.transaction('sessions').objectStore('sessions').get(id);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      },
    );
    idb.close();
    return {
      audio: blobs.filter((b) => b.kind === 'audio'),
      chunks: blobs.filter((b) => b.kind === 'audio_chunk').length,
      audioMs: session.audio?.duration_ms ?? null,
      sessionMs: session.duration_ms,
    };
  }, sessionId);
}

test('before setup, the picker says the microphone is not allowed yet', async ({
  context,
  serviceWorker: sw,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.primaryOrigin}/pricing.html`);
  await showToolbar(sw, page);
  const picker = page.getByTestId('toolbar-mic-picker');
  await expect(picker).toBeVisible();
  await expect(picker).toHaveAttribute('data-granted', 'false');
  await picker.click();
  await expect(page.getByTestId('mic-not-granted')).toContainText('not allowed yet');
  await expect(page.getByRole('menuitem', { name: 'Finish setup' })).toBeVisible();
  await expect(page.getByRole('menuitemradio')).toHaveCount(0);
});

test('the input remembered before Start records, and a pick mid-Session switches it live', async ({
  context,
  serviceWorker: sw,
  site,
  openExtensionPage,
}) => {
  await grantMic(openExtensionPage);
  const page = await context.newPage();
  await page.goto(`${site.primaryOrigin}/pricing.html`);
  await showToolbar(sw, page);

  // (b) Before Start: the media context's inputs, listed when the menu opens. Chromium's fake devices keep their
  // deviceIds and labels hidden from every page here (the grant is not kept without --use-fake-ui-for-media-stream,
  // which crashes this Chromium), so the list is "System default" alone, never unnamed entries.
  const picker = page.getByTestId('toolbar-mic-picker');
  await expect(picker).toHaveAttribute('data-granted', 'true');
  await picker.click();
  const systemDefault = page.getByRole('menuitemradio', { name: 'System default' });
  await expect(systemDefault).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('mic-listing')).toHaveCount(0);
  const labels = await page.getByTestId('mic-device').allTextContents();
  console.log(`fake audio inputs listed: ${JSON.stringify(labels)}`);
  expect(labels.every((l) => l.trim().length > 0)).toBe(true);
  await page.getByTestId('toolbar').screenshot({ path: test.info().outputPath('toolbar-idle.png') });
  await page.screenshot({ path: test.info().outputPath('mic-menu-idle.png') });
  // Listing opened the offscreen document only for the list.
  await expect.poll(() => offscreenOpen(sw)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('mic-menu')).toBeHidden();

  // A remembered input by deviceId ("default" is the one id Chromium's fake device answers to here): Start opens it
  // with `deviceId: { exact }`, and the media context reports it in use.
  await sw.evaluate(() => chrome.storage.local.set({ micDevice: 'default' }));
  await page.getByTestId('toolbar-start').click();
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'recording');
  const sessionId = (await activeSessionId(sw))!;
  await expect.poll(async () => (await sessionMic(sw))?.selected, { timeout: 15_000 }).toBe('default');
  expect((await sessionMic(sw))!.live).toBe(true);
  await expect(page.getByTestId('toolbar-mute')).toBeVisible();
  await page.waitForTimeout(1500);

  // (c) Mid-Session: System default. The graph's source swaps to a newly opened device; nothing restarts.
  await picker.click();
  await page.getByTestId('toolbar').screenshot({ path: test.info().outputPath('toolbar-recording.png') });
  await page.screenshot({ path: test.info().outputPath('mic-menu-recording.png') });
  await systemDefault.click();
  await expect.poll(async () => (await sessionMic(sw))?.selected).toBeNull();
  await expect.poll(() => remembered(sw)).toBeNull();
  // The same Session, still recording: Mute still works on the switched input.
  expect(await activeSessionId(sw)).toBe(sessionId);
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'recording');
  await page.getByTestId('toolbar-mute').click();
  await expect(page.getByTestId('toolbar-mute')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('toolbar-mute').click();
  await expect(page.getByTestId('toolbar-mute')).toHaveAttribute('aria-pressed', 'false');
  await page.waitForTimeout(1500);

  const review = context.waitForEvent('page', { predicate: (p) => p.url().includes('review.html') });
  await page.getByTestId('toolbar-stop').click();
  await review;
  // One audio file for the whole Session: the switch did not split or restart it.
  await expect.poll(async () => (await audioRows(sw, sessionId)).audio.length, { timeout: 30_000 }).toBe(1);
  const rows = await audioRows(sw, sessionId);
  console.log(`audio after the switch: ${JSON.stringify(rows)}`);
  expect(rows.chunks).toBe(0);
  expect(rows.audio[0]!.size).toBeGreaterThan(1000);
  expect(rows.audioMs).not.toBeNull();
  expect(rows.sessionMs).not.toBeNull();
  expect(Math.abs(rows.audioMs! - rows.sessionMs!)).toBeLessThan(3000);
  const ext = await openExtensionPage('sessions.html');
  const events = await sessionEvents(ext, sessionId);
  expect(ofType(events, 'mic_muted')).toHaveLength(1);
  expect(ofType(events, 'mic_unmuted')).toHaveLength(1);
});

test('a remembered input that is gone gives the system default, never a failed Session', async ({
  context,
  serviceWorker: sw,
  site,
  openExtensionPage,
}) => {
  await grantMic(openExtensionPage);
  await sw.evaluate(() => chrome.storage.local.set({ micDevice: 'unplugged-long-ago' }));
  const page = await context.newPage();
  await page.goto(`${site.primaryOrigin}/pricing.html`);
  await showToolbar(sw, page);
  await page.getByTestId('toolbar-start').click();
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'recording');
  await expect.poll(async () => (await sessionMic(sw)) !== null, { timeout: 15_000 }).toBe(true);
  expect((await sessionMic(sw))!.selected).toBeNull();
  await expect(page.getByTestId('toolbar-mute')).toBeVisible();
  await expect(page.getByTestId('toolbar-no-mic')).toHaveCount(0);
  await page.getByTestId('toolbar-mic-picker').click();
  await expect(page.getByRole('menuitemradio', { name: 'System default' })).toHaveAttribute('aria-checked', 'true');
});
