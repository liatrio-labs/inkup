// F1 check (b) in Firefox: the toolbar's Start frame records the video and hears the Session over the panel Port (it has
// no storage.session). Pause pauses its recorder (no video chunks while paused) and Resume resumes it. A Session that
// ends without asking the frame (Cancel, or the Session simply gone) still ends its recording: the last chunks are
// written, the capture is stopped, and the frame tells the toolbar it no longer records (`data-recording`).
import type { Locator, Page } from '@playwright/test';
import { type ExtPage, expect, test } from './fixtures';

/** Video chunks written for the Session so far. */
const chunks = (ext: ExtPage, sessionId: string) =>
  ext.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
    });
    const rows = await new Promise<{ kind: string }[]>((res) => {
      const r = idb.transaction('blobs').objectStore('blobs').index('session_id').getAll(id);
      r.onsuccess = () => res(r.result as { kind: string }[]);
    });
    idb.close();
    return rows.filter((b) => b.kind === 'video_chunk').length;
  }, sessionId);

const activeSession = (ext: ExtPage) =>
  ext.evaluate(
    async () =>
      (await chrome.storage.session.get('activeSession')).activeSession as {
        id: string;
        paused: unknown;
        video: { state: string };
      } | null,
  );

async function startFromFrame(pricing: Page, frame: Locator, toolbar: Locator, ext: ExtPage) {
  await expect(toolbar).toHaveAttribute('data-state', 'idle');
  await expect(frame).toHaveAttribute('data-ready', 'true');
  const box = (await frame.boundingBox())!;
  await pricing.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(toolbar).toHaveAttribute('data-state', 'recording', { timeout: 15_000 });
  const s = (await activeSession(ext))!;
  expect(s.video.state).toBe('recording');
  await expect(frame).toHaveAttribute('data-recording', 'true');
  // The recorder writes a chunk a second.
  await expect.poll(() => chunks(ext, s.id), { timeout: 10_000 }).toBeGreaterThan(1);
  return s.id;
}

test('Firefox: the Start frame pauses with the Session, and a Session ended without asking it still ends its recording', async ({
  context,
  extPage,
  site,
}) => {
  test.setTimeout(180_000);
  const ext = await extPage('/onboarding.html');
  await ext.click('allow-mic');
  await ext.waitFor(() => !!document.querySelector('[data-testid="mic-status"]'), undefined, {
    timeout: 20_000,
    what: 'the mic grant',
  });
  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  await ext.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://*/pricing.html' });
    await chrome.storage.session.set({ toolbarTabs: [tab!.id] });
  });
  const toolbar = pricing.getByTestId('toolbar');
  const frame = pricing.getByTestId('toolbar-start-frame');

  // 1. Pause and Resume.
  const first = await startFromFrame(pricing, frame, toolbar, ext);
  await pricing.getByTestId('toolbar-pause').click();
  await expect.poll(async () => !!(await activeSession(ext))?.paused).toBe(true);
  // The chunk in flight at the pause lands; after that, nothing while paused.
  await pricing.waitForTimeout(1500);
  const atPause = await chunks(ext, first);
  await pricing.waitForTimeout(3000);
  expect(await chunks(ext, first), 'no video chunks while paused').toBe(atPause);
  await expect(frame).toHaveAttribute('data-recording', 'true');
  await pricing.getByTestId('toolbar-resume').click();
  await expect
    .poll(() => chunks(ext, first), { timeout: 10_000, message: 'recording again after Resume' })
    .toBeGreaterThan(atPause + 1);

  // 2. Cancel: the frame's recording ends and its capture is freed.
  await pricing.getByTestId('toolbar-cancel').click();
  await expect(toolbar).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
  await expect(frame).toHaveAttribute('data-recording', 'false', { timeout: 15_000 });
  const afterCancel = await chunks(ext, first);
  await pricing.waitForTimeout(2500);
  // Discarded after its Undo window, or kept: either way nothing more is written.
  expect(await chunks(ext, first)).toBeLessThanOrEqual(afterCancel);
  // Let the Undo window pass, so the next Start is not an Undo.
  await expect(pricing.getByTestId('toolbar-undo-discard')).toBeHidden({ timeout: 20_000 });

  // 3. The Session ends with no Stop or Cancel sent to anyone (as a restarted worker finding it gone would): the frame
  // hears it over the Port and ends its recording on its own.
  const second = await startFromFrame(pricing, frame, toolbar, ext);
  await ext.evaluate(() => chrome.storage.session.set({ activeSession: null }));
  await expect(frame).toHaveAttribute('data-recording', 'false', { timeout: 15_000 });
  const flushed = await chunks(ext, second);
  expect(flushed).toBeGreaterThan(1);
  await pricing.waitForTimeout(2500);
  expect(await chunks(ext, second), 'no chunks after the recording ended').toBe(flushed);
  // Nothing holds the capture: a new Start picks again and records.
  await startFromFrame(pricing, frame, toolbar, ext);
  await pricing.getByTestId('toolbar-stop').click();
  await expect(toolbar).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
});
