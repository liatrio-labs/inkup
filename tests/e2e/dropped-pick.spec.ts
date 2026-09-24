// F3 proof (#22): a screenshot taken for an Annotation that is never recorded does not outlive it, paired with the real
// host. An Object Select pick is screenshotted at the pick; Esc in its comment box drops it, and its screenshot goes at
// once: the image and its `screenshot` event from IndexedDB, their outbox rows, and (it had already reached the host)
// the host's blob, its file and its event. A drawn Stroke's screenshot whose Annotation Clear all closed without one
// is swept at Stop the same way. What a recorded pick uses stays, everywhere.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Worker } from '@playwright/test';
import type { TimelineEvent } from '../../packages/core/src/timeline.ts';
import { ALLOW_TAB_CAPTURE, expect, grantMic, test } from './fixtures';
import { stroke } from './helpers/draw';
import { HostProcess, pairThroughOptions, tempDataDir } from './helpers/host';
import { storeRows } from './helpers/seed';
import { activeSessionId, ofType, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'review-two-notes.wav', extraArgs: [ALLOW_TAB_CAPTURE] });

type Shot = Extract<TimelineEvent, { type: 'screenshot' }>;

/** The host's file for a blob: named by the SHA-256 of its id (host/crates/store/src/blobs.rs). */
const blobFile = (dataDir: string, id: string) => join(dataDir, 'blobs', createHash('sha256').update(id).digest('hex'));

async function startFromToolbar(page: Page, sw: Worker, origin: string): Promise<string> {
  await page.goto(`${origin}/pricing.html`);
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://*/pricing.html' });
    (chrome.action.onClicked as unknown as { dispatch(tab: chrome.tabs.Tab): void }).dispatch(tab!);
  });
  await page.getByTestId('toolbar-start').click();
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'recording');
  return (await activeSessionId(sw))!;
}

/** Picks the CTA with Object Select; resolves once its comment box is open (the pick's screenshot is stored by then). */
async function pickCta(page: Page) {
  const cta = (await page.locator('button.cta').boundingBox())!;
  await page.mouse.move(cta.x + 10, cta.y + 10);
  await page.mouse.move(cta.x + cta.width / 2, cta.y + cta.height / 2, { steps: 3 });
  await expect(page.getByTestId('object-select-highlight')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('object-select-box')).toBeVisible({ timeout: 15_000 });
}

test('a dropped pick leaves no screenshot locally, in the outbox or on the host; Stop sweeps any other unused one', async ({
  context,
  serviceWorker: sw,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(180_000);
  const data = tempDataDir();
  const host = await HostProcess.start(data.dir);
  try {
    const { options: ext, token } = await pairThroughOptions(sw, openExtensionPage, host);
    await grantMic(openExtensionPage);
    const page = await context.newPage();
    const sessionId = await startFromToolbar(page, sw, site.primaryOrigin);
    const shots = async () => ofType(await sessionEvents(ext, sessionId), 'screenshot') as Shot[];
    const hostEvents = () => host.get<TimelineEvent[]>(`/api/sessions/${sessionId}/events`, token);

    // 1. A pick recorded with Enter: its screenshot stays.
    await page.getByTestId('toolbar-object-select').click();
    await expect(page.getByTestId('toolbar-object-select')).toHaveAttribute('aria-pressed', 'true');
    await pickCta(page);
    await page.getByTestId('object-select-input').fill('Make this roomier');
    await page.getByTestId('object-select-input').press('Enter');
    await expect
      .poll(async () => ofType(await sessionEvents(ext, sessionId), 'annotation').length, { timeout: 15_000 })
      .toBe(1);
    const kept = ofType(await sessionEvents(ext, sessionId), 'annotation')[0]!.screenshot_id!;
    expect(kept).toBeTruthy();

    // 2. A pick dropped with Esc, once its screenshot has reached the host.
    const before = new Set((await shots()).map((s) => s.screenshot_id));
    await pickCta(page);
    const dropped = (await shots()).find((s) => !before.has(s.screenshot_id) && s.annotation_id !== null)!;
    expect(dropped, 'the pick was screenshotted').toBeTruthy();
    await expect
      .poll(async () => (await host.blob(dropped.screenshot_id, token)).status, { timeout: 15_000 })
      .toBe(200);
    await expect
      .poll(async () => (await hostEvents()).some((e) => e.id === dropped.id), { timeout: 15_000 })
      .toBe(true);
    await page.getByTestId('object-select-input').press('Escape');
    await expect(page.getByTestId('object-select-box')).toBeHidden();
    // Gone at once, before Stop: locally, from the outbox, and from the host.
    await expect
      .poll(async () => (await shots()).some((s) => s.screenshot_id === dropped.screenshot_id), { timeout: 10_000 })
      .toBe(false);
    expect((await storeRows<{ id: string }>(ext, 'blobs')).some((b) => b.id === dropped.screenshot_id)).toBe(false);
    await expect
      .poll(async () => (await host.blob(dropped.screenshot_id, token)).status, { timeout: 15_000 })
      .toBe(404);
    expect((await hostEvents()).some((e) => e.id === dropped.id)).toBe(false);
    expect(existsSync(blobFile(data.dir, dropped.screenshot_id)), "the host's file").toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('toolbar-object-select')).toHaveAttribute('aria-pressed', 'false');

    // 3. A Stroke screenshotted, then cleared before its Annotation closed: nothing uses that screenshot.
    const beforeInk = new Set((await shots()).map((s) => s.screenshot_id));
    const draw = page.getByTestId('toolbar-draw');
    await draw.click();
    await expect(draw).toHaveAttribute('aria-pressed', 'true');
    const vp = page.viewportSize()!;
    await stroke(page, [
      [vp.width * 0.2, vp.height * 0.3],
      [vp.width * 0.3, vp.height * 0.35],
      [vp.width * 0.4, vp.height * 0.3],
    ]);
    await expect
      .poll(async () => (await shots()).filter((s) => !beforeInk.has(s.screenshot_id)).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    const inkShots = (await shots()).filter((s) => !beforeInk.has(s.screenshot_id));
    await page.getByTestId('toolbar-clear').click();
    await expect
      .poll(async () => ofType(await sessionEvents(ext, sessionId), 'annotation').length, { timeout: 15_000 })
      .toBe(2);
    expect(ofType(await sessionEvents(ext, sessionId), 'annotation')[1]).toMatchObject({
      close_reason: 'cleared',
      screenshot_id: null,
    });
    // Kept until Stop.
    expect((await shots()).filter((s) => !beforeInk.has(s.screenshot_id)).length).toBe(inkShots.length);

    // 4. Stop.
    await page.getByTestId('toolbar-stop').click();
    await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
    await expect
      .poll(async () => (await sessionEvents(ext, sessionId)).some((e) => e.type === 'session_end'), {
        timeout: 30_000,
      })
      .toBe(true);
    // The sweep runs once the Session is saved, before the review page opens.
    await expect
      .poll(async () => (await shots()).filter((s) => !beforeInk.has(s.screenshot_id)).length, { timeout: 30_000 })
      .toBe(0);
    await expect.poll(async () => (await storeRows(ext, 'outbox')).length, { timeout: 30_000 }).toBe(0);

    const local = await sessionEvents(ext, sessionId);
    const localShots = ofType(local, 'screenshot') as Shot[];
    const used = new Set(
      local.flatMap((e) =>
        (e.type === 'annotation' || e.type === 'text_comment') && e.screenshot_id ? [e.screenshot_id] : [],
      ),
    );
    // No screenshot taken for an Annotation is left that no Annotation uses; the recorded pick's is there.
    expect(localShots.filter((s) => s.annotation_id !== null && !used.has(s.screenshot_id))).toEqual([]);
    expect(localShots.map((s) => s.screenshot_id)).toContain(kept);
    for (const s of inkShots) expect(localShots.map((x) => x.screenshot_id)).not.toContain(s.screenshot_id);
    const localBlobs = (await storeRows<{ id: string; session_id: string; kind: string }>(ext, 'blobs')).filter(
      (b) => b.session_id === sessionId && b.kind === 'screenshot',
    );
    expect(localBlobs.map((b) => b.id).sort()).toEqual(localShots.map((s) => s.screenshot_id).sort());

    // The host holds exactly the same screenshots: events, blobs and files.
    const remote = await hostEvents();
    expect(remote.map((e) => e.id).sort()).toEqual(local.map((e) => e.id).sort());
    for (const s of [dropped, ...inkShots]) {
      expect((await host.blob(s.screenshot_id, token)).status, `host blob ${s.screenshot_id}`).toBe(404);
      expect(existsSync(blobFile(data.dir, s.screenshot_id))).toBe(false);
    }
    for (const s of localShots)
      expect((await host.blob(s.screenshot_id, token)).status, `host blob ${s.screenshot_id}`).toBe(200);
    const files = readdirSync(join(data.dir, 'blobs')).filter((f) => !f.startsWith('.'));
    // Chunks stay in the browser; the whole audio and video, screenshots and crops go to the host.
    const hostBlobIds = (await storeRows<{ id: string; session_id: string; kind: string }>(ext, 'blobs'))
      .filter((b) => b.session_id === sessionId && !b.kind.endsWith('_chunk'))
      .map((b) => b.id);
    expect(files.sort()).toEqual(hostBlobIds.map((id) => createHash('sha256').update(id).digest('hex')).sort());
  } finally {
    await host.kill();
    data.remove();
  }
});
