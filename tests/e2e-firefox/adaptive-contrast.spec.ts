// E8 in Firefox, on fixtures/site/contrast.html: the toolbar goes light over the dark section and dark over the light
// one (computed styles), and a capture sample decides over the dark hero image. A Stroke on the red section is not red
// and stands out at least 3:1 from the red in its screenshot. The Light setting forces the light toolbar.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { contrastRatio, parseColor } from '../../packages/core/src/contrast.ts';
import type { EventOf, TimelineEvent } from '../../packages/core/src/timeline.ts';
import { stroke } from '../e2e/helpers/draw';
import { type ExtPage, expect, ROOT, test } from './fixtures';

const RED = parseColor('#c92a2a')!;
const show = (page: Page, id: string) =>
  page.evaluate((id) => window.scrollTo(0, document.getElementById(id)!.offsetTop), id);

function sessionEvents(page: ExtPage, sessionId: string): Promise<TimelineEvent[]> {
  return page.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
    });
    return new Promise<TimelineEvent[]>((res) => {
      const r = idb.transaction('events').objectStore('events').index('session_id').getAll(id);
      r.onsuccess = () =>
        res((r.result as (TimelineEvent & { seq: number })[]).sort((a, b) => a.t - b.t || a.seq - b.seq));
    });
  }, sessionId);
}

function pixel(page: ExtPage, id: string, x: number, y: number): Promise<[number, number, number]> {
  return page.evaluate(
    async ({ id, x, y }) => {
      const idb = await new Promise<IDBDatabase>((res) => {
        const r = indexedDB.open('inkup');
        r.onsuccess = () => res(r.result);
      });
      const row = await new Promise<{ blob: Blob }>((res) => {
        const r = idb.transaction('blobs').objectStore('blobs').get(id);
        r.onsuccess = () => res(r.result);
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

test('Firefox: the toolbar follows the page and the setting; ink on red is not red and stands out 3:1', async ({
  context,
  extPage,
  openExtensionWindow,
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
  const page = await context.newPage();
  await page.goto(`${site.primaryOrigin}/contrast.html`);
  const panel = await openExtensionWindow('sidepanel.html');
  await panel.click('start');
  await panel.waitForText('status', /^Recording$/);
  const sessionId = await panel.waitFor(
    async () =>
      ((await chrome.storage.session.get('activeSession')).activeSession as { id: string } | undefined)?.id ?? null,
    undefined,
    { what: 'an active Session' },
  );
  await page.bringToFront();
  await onboarding.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://*/contrast.html' });
    await chrome.storage.session.set({ toolbarTabs: [tab!.id] });
  });
  const bar = page.getByTestId('toolbar');
  await expect(bar).toHaveAttribute('data-state', 'recording', { timeout: 15_000 });
  // Up from the bottom corner, as in the Chrome spec (a drag end also re-evaluates the theme).
  const grip = (await page.getByTestId('toolbar-grip').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, 300, { steps: 5 });
  await page.mouse.up();

  await expect(bar).toHaveAttribute('data-theme', 'dark');
  await show(page, 'dark');
  await expect(bar).toHaveAttribute('data-theme', 'light');
  await show(page, 'light');
  await expect(bar).toHaveAttribute('data-theme', 'dark');
  await show(page, 'hero');
  await expect(bar).toHaveAttribute('data-theme-from', 'sample', { timeout: 15_000 });
  await expect(bar).toHaveAttribute('data-theme', 'light');

  await show(page, 'red');
  await page.getByTestId('toolbar-draw').click();
  await expect(page.getByTestId('toolbar-draw')).toHaveAttribute('aria-pressed', 'true');
  const vp = page.viewportSize()!;
  await stroke(
    page,
    Array.from({ length: 30 }, (_, i) => [vp.width * 0.25 + i * 10, vp.height * 0.4] as [number, number]),
  );
  await page.waitForTimeout(400);
  await page.getByTestId('toolbar-draw').click();
  await expect(page.getByTestId('toolbar-draw')).toHaveAttribute('aria-pressed', 'false');
  const ann = await onboarding.waitFor(
    async (id) => {
      const idb = await new Promise<IDBDatabase>((res) => {
        const r = indexedDB.open('inkup');
        r.onsuccess = () => res(r.result);
      });
      const rows = await new Promise<{ type: string; screenshot_id?: string | null }[]>((res) => {
        const r = idb.transaction('events').objectStore('events').index('session_id').getAll(id);
        r.onsuccess = () => res(r.result as { type: string; screenshot_id?: string | null }[]);
      });
      return rows.find((e) => e.type === 'annotation' && e.screenshot_id) ?? null;
    },
    sessionId,
    { timeout: 20_000, what: 'the Annotation with its screenshot' },
  );
  const events = await sessionEvents(onboarding, sessionId);
  const a = ann as unknown as EventOf<'annotation'>;
  const s = events.find((e): e is EventOf<'stroke'> => e.type === 'stroke' && e.stroke_id === a.stroke_ids[0])!;
  const shot = events.find(
    (e): e is EventOf<'screenshot'> => e.type === 'screenshot' && e.screenshot_id === a.screenshot_id,
  )!;
  expect(s.color).toMatch(/^#[0-9a-f]{6}$/);
  expect(s.color).not.toBe('#e03131');
  const mid = s.points[Math.floor(s.points.length / 2)]!;
  const [r, g, b] = await pixel(
    onboarding,
    shot.screenshot_id,
    (mid.x - shot.scroll.x) * shot.dpr,
    (mid.y - shot.scroll.y) * shot.dpr,
  );
  expect(contrastRatio({ r, g, b }, RED), `ink pixel ${[r, g, b]} on red`).toBeGreaterThanOrEqual(3);

  await show(page, 'light');
  await expect(bar).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('toolbar-theme').click();
  await expect(page.getByTestId('toolbar-theme')).toHaveAttribute('data-setting', 'light');
  await expect(bar).toHaveAttribute('data-theme', 'light');
  await expect(bar).toHaveAttribute('data-theme-from', 'setting');

  await panel.click('stop');
  await expect(bar).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
});
