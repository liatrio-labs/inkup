// Firefox suspends an event page after an idle timeout (30 s) without extension events, and the media context
// lives in the background page. This Session outlives a shortened timeout: audio keeps being written.
import { test } from './fixtures';

test.use({ idleTimeoutMs: 12_000 });

test('Firefox: the media context outlives the event-page idle timeout during a Session', async ({
  context,
  extPage,
  openExtensionWindow,
  site,
}) => {
  test.setTimeout(90_000);
  const onboarding = await extPage('/onboarding.html');
  // One-second audio chunks, so the recording's progress shows in IndexedDB.
  await onboarding.evaluate(() => chrome.storage.local.set({ devOverrides: { audioChunkMs: 1000 } }));
  await onboarding.click('allow-mic');
  await onboarding.waitFor(() => !!document.querySelector('[data-testid="mic-status"]'), undefined, {
    timeout: 20_000,
    what: 'the mic grant',
  });
  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  const panel = await openExtensionWindow('sidepanel.html');
  await panel.click('start');
  await panel.waitForText('status', /^Recording$/);

  // Twice the timeout: without a keepalive the audio stops at about 12 s.
  await onboarding.waitFor(
    async () => {
      const idb = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('inkup');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const chunks = await new Promise<{ kind: string; t: number }[]>((res, rej) => {
        const r = idb.transaction('blobs').objectStore('blobs').getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return Math.max(0, ...chunks.filter((c) => c.kind === 'audio_chunk').map((c) => c.t)) > 24_000;
    },
    undefined,
    { timeout: 45_000, what: 'audio chunks past 24 s' },
  );
  await panel.waitForText('status', /^Recording$/);
});
