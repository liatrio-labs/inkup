// E6 in Firefox: the toolbar's viewport control uses the frame host, as in Chrome. The 375 preset,
// picked on the page's toolbar, reloads the page into a 375×812 frame of our viewport page. The framed page gets the
// overlay and keeps recording; a Snap there records its own viewport, 375×812, and the screenshot is the frame
// cropped out of the tab. The frame's right handle drags it to 900; Reset gives the tab back; each is logged.
//
// Playwright's Firefox cannot follow a tab to one of our pages (fixtures.ts), so once the tab is the frame host it is
// scripted over RDP, and nothing can draw inside its frame: drawing at a resized viewport, and matchMedia in the
// framed page, are proved in Chrome with the same frame host (tests/e2e/viewport.spec.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TimelineEvent } from '../../packages/core/src/timeline.ts';
import { type ExtPage, expect, ROOT, test } from './fixtures';

const PHONE = { width: 375, height: 812 };

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

test('Firefox: the frame host resizes the page to 375; a Snap there is the 375 frame; drag to 900; Reset', async ({
  context,
  extPage,
  site,
}) => {
  test.setTimeout(150_000);
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
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(`${site.primaryOrigin}/responsive.html`);
  // What the toolbar icon does (RDP cannot click it): add the tab to the toolbar's tabs; the background pushes it.
  const tabId = await onboarding.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://*/responsive.html' });
    await chrome.storage.session.set({ toolbarTabs: [tab!.id] });
    return tab!.id!;
  });
  const toolbar = page.getByTestId('toolbar');
  await expect(toolbar).toHaveAttribute('data-state', 'idle');
  await expect(page.getByTestId('toolbar-viewport')).toBeVisible();
  // Start: a real click in the toolbar's Start frame (the picker is granted by the fake-media prefs).
  const startFrame = page.getByTestId('toolbar-start-frame');
  await expect(startFrame).toBeVisible();
  await page.waitForTimeout(1000);
  const box = (await startFrame.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(toolbar).toHaveAttribute('data-state', 'recording', { timeout: 15_000 });
  const session = await onboarding.evaluate(
    async () => (await chrome.storage.session.get('activeSession')).activeSession as { id: string },
  );

  await page.getByTestId('toolbar-viewport').click();
  await page.getByTestId('viewport-preset-375x812').click();
  // The tab now shows the frame host, our page, which Playwright's Firefox cannot follow (fixtures.ts): from here the
  // host page is scripted over RDP, and nothing can draw inside its frame, so a Snap stands in for the Annotation.
  await onboarding.waitFor(
    async (id) => (await chrome.tabs.get(id)).url?.includes('/viewport.html?u=') ?? false,
    tabId,
    { what: 'the frame host' },
  );
  const host = await extPage('/viewport.html');
  await host.waitForText('viewport-readout', /^375×812$/);
  // The framed page got the overlay (the probe asked for it) and still records: a Snap reads its page context.
  await host.waitFor(
    () => {
      const f = document.querySelector('iframe')!;
      return f.name === 'var-viewport-frame' && f.getBoundingClientRect().width === 375;
    },
    undefined,
    { what: 'the 375 px frame' },
  );
  const snapped = await host.waitFor(
    () =>
      new Promise<string | null>((res) =>
        chrome.runtime.sendMessage(
          { id: 1, type: 'snapScreenshot', data: undefined, timestamp: Date.now() },
          (r: { res?: { screenshot_id: string | null } }) => res(r?.res?.screenshot_id ?? null),
        ),
      ),
    undefined,
    { what: 'a Snap of the framed page' },
  );

  // Freeform: the host page's right handle, 525 px to the right (synthetic pointer events over RDP).
  await host.evaluate(() => {
    const h = document.querySelector<HTMLElement>('[data-testid="viewport-handle-right"]')!;
    const r = h.getBoundingClientRect();
    const at = (type: string, x: number) =>
      h.dispatchEvent(
        new PointerEvent(type, { pointerId: 7, button: 0, clientX: x, clientY: r.top + r.height / 2, bubbles: true }),
      );
    const x = r.left + r.width / 2;
    at('pointerdown', x);
    at('pointermove', x + 260);
    at('pointermove', x + 525);
    at('pointerup', x + 525);
  });
  await host.waitForText('viewport-readout', /^900×812$/);
  await host.waitFor(() => document.querySelector('iframe')!.getBoundingClientRect().width === 900, undefined, {
    what: 'the 900 px frame',
  });

  // Reset reloads the tab with the page: the frame host goes away.
  await host.click('viewport-host-reset', { navigates: true });
  await onboarding.waitFor(
    async (id) => (await chrome.tabs.get(id)).url?.endsWith('/responsive.html') ?? false,
    tabId,
    { what: 'the page back in the tab' },
  );
  await onboarding.waitFor(async () => {
    await new Promise((r) =>
      chrome.runtime.sendMessage({ id: 2, type: 'stopSession', data: undefined, timestamp: Date.now() }, r),
    );
    return true;
  });
  const review = await extPage('/review.html', 30_000);
  const events = await sessionEvents(review, session.id);
  const changes = events.filter(
    (e): e is Extract<TimelineEvent, { type: 'viewport_change' }> => e.type === 'viewport_change',
  );
  expect(changes.map((c) => [c.width, c.height, c.mechanism])).toEqual([
    [375, 812, 'frame_host'],
    [900, 812, 'frame_host'],
    [changes[2]!.width, changes[2]!.height, 'none'],
  ]);
  const shot = events.find(
    (e): e is Extract<TimelineEvent, { type: 'screenshot' }> => e.type === 'screenshot' && e.screenshot_id === snapped,
  )!;
  // The framed page's own context: its viewport is the frame.
  expect(shot.viewport).toEqual(PHONE);
  expect(shot.url).toMatch(/\/responsive\.html$/);
  // The screenshot is the frame, cropped out of the tab: 375×812 CSS px at the image's pixel ratio.
  const img = await review.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
    });
    const row = await new Promise<{ blob: Blob }>((res) => {
      const r = idb.transaction('blobs').objectStore('blobs').get(id);
      r.onsuccess = () => res(r.result);
    });
    const bmp = await createImageBitmap(row.blob);
    return { width: bmp.width, height: bmp.height };
  }, shot.screenshot_id);
  expect(Math.abs(img.width - PHONE.width * shot.dpr)).toBeLessThanOrEqual(1);
  expect(Math.abs(img.height - PHONE.height * shot.dpr)).toBeLessThanOrEqual(1);
});
