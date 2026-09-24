// U5 (feedback batch 1): extension pages as review targets. Our own pages mount the drawing overlay themselves
// and get full Annotations. Another extension's page runs nothing of ours: the Session records audio, video and
// the URL with no overlay, and the `snap` shortcut (Alt+Shift+S, which grants activeTab) is the only way to screenshot it.
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { expect, FIXTURE_EXTENSION_PATH, grantMic, test, useScript } from './fixtures';
import { circle } from './helpers/draw';
import { activeSessionId, ofType, sessionEvents } from './helpers/session';

const SILENT = { timestamp_quality: 'word' as const, cues: [] };

/** Install opens onboarding.html; close it so Start's fallback (panel opened as a tab) binds the page under test. */
async function closeOnboarding(context: BrowserContext) {
  for (const p of context.pages()) if (p.url().endsWith('/onboarding.html')) await p.close();
}

/** Fires a `commands` event at the service worker's real listeners, as a keyboard shortcut would. */
async function dispatchCommand(sw: Worker, name: string) {
  await sw.evaluate(async (n) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    (chrome.commands.onCommand as unknown as { dispatch(name: string, tab?: chrome.tabs.Tab): void }).dispatch(n, tab);
  }, name);
}

async function sessionRow(extPage: Page, id: string) {
  return extPage.evaluate(async (sid) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return new Promise<{ video: unknown; start_url: string } | undefined>((res, rej) => {
      const r = idb.transaction('sessions').objectStore('sessions').get(sid);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }, id);
}

test.describe('our own Sessions page', () => {
  test.use({ captureSourceTitle: 'Sessions' });

  test('drawing on sessions.html records Annotations with a real pick and a screenshot', async ({
    context,
    serviceWorker,
    openExtensionPage,
  }) => {
    test.setTimeout(60_000);
    await useScript(serviceWorker, SILENT);
    await grantMic(openExtensionPage);
    const sessions = await openExtensionPage('sessions.html');
    await sessions.setViewportSize({ width: 1280, height: 720 });
    await expect(sessions.getByRole('heading', { name: 'Sessions' })).toBeVisible();
    await closeOnboarding(context);
    const panel = await openExtensionPage('sidepanel.html');
    await panel.getByTestId('start').click();
    await expect(panel.getByTestId('status')).toHaveText('Recording');
    await expect(panel.getByTestId('recording-tab')).toContainText('Sessions');
    await expect(panel.getByTestId('no-overlay')).toHaveCount(0);
    const sessionId = (await activeSessionId(serviceWorker))!;

    await panel.getByTestId('draw-toggle').click();
    await expect(sessions.locator('var-review-overlay')).toHaveCount(1);
    await sessions.bringToFront();
    const heading = (await sessions.getByRole('heading', { name: 'Sessions' }).boundingBox())!;
    await circle(sessions, heading, 1.3);
    await expect
      .poll(async () => ofType(await sessionEvents(panel, sessionId), 'annotation').length, { timeout: 10_000 })
      .toBe(1);

    const events = await sessionEvents(panel, sessionId);
    expect(ofType(events, 'session_start')[0]).toMatchObject({
      overlay: 'page',
      url: expect.stringMatching(/^chrome-extension:\/\/.+\/sessions\.html$/),
    });
    const ann = ofType(events, 'annotation')[0]!;
    expect(ann.resolution).toBe('element');
    const pick = ann.candidates[ann.pick!]!;
    expect(pick).toMatchObject({ tag: 'h1', name: 'Sessions' });
    expect(await sessions.evaluate((sel) => document.querySelector(sel)?.textContent, pick.selector)).toBe('Sessions');
    // Our overlay is never a Candidate.
    expect(ann.candidates.some((c) => c.tag === 'var-review-overlay')).toBe(false);
    expect(ann.screenshot_id).toBeTruthy();
    expect(ofType(events, 'screenshot').find((s) => s.screenshot_id === ann.screenshot_id)).toMatchObject({
      url: ann.url,
      scroll: { x: 0, y: 0 },
    });

    // The `snap` shortcut's handler (dispatched: see below) screenshots our page, with its page context read from
    // the overlay, since scripts cannot be injected into extension pages.
    await sessions.evaluate(() => scrollTo(0, 0));
    await dispatchCommand(serviceWorker, 'snap');
    await expect
      .poll(
        async () => ofType(await sessionEvents(panel, sessionId), 'screenshot').find((s) => s.trigger === 'shortcut'),
        { timeout: 10_000 },
      )
      .toMatchObject({
        url: ann.url,
        viewport: { width: 1280, height: 720 },
      });

    await panel.getByTestId('stop').click();
    await expect(sessions.locator('var-review-overlay')).toHaveCount(0);
    // The Session list names our own origin.
    await expect(sessions.getByTestId('origin-label')).toHaveText('This extension', { timeout: 10_000 });
  });
});

test.describe("another extension's page", () => {
  test.use({ extraExtensions: [FIXTURE_EXTENSION_PATH], captureSourceTitle: 'Fixture Extension Page' });

  test('Start there gives a no-overlay Session with video, and the snap shortcut takes a screenshot', async ({
    context,
    serviceWorker,
    openExtensionPage,
  }) => {
    test.setTimeout(60_000);
    await useScript(serviceWorker, SILENT);
    await grantMic(openExtensionPage);
    const fixtureWorker =
      context.serviceWorkers().find((w) => w.url().endsWith('/fixture-sw.js')) ??
      (await context.waitForEvent('serviceworker', { predicate: (w) => w.url().endsWith('/fixture-sw.js') }));
    const other = await context.newPage();
    const url = `chrome-extension://${new URL(fixtureWorker.url()).host}/page.html`;
    await other.goto(url);
    await closeOnboarding(context);
    const panel = await openExtensionPage('sidepanel.html');
    await panel.getByTestId('start').click();
    await expect(panel.getByTestId('status')).toHaveText('Recording');
    await expect(panel.getByTestId('recording-tab')).toContainText('Fixture Extension Page');
    await expect(panel.getByTestId('no-overlay')).toBeVisible();
    await expect(panel.getByTestId('draw-toggle')).toBeDisabled();
    await expect(panel.getByTestId('video-status')).toHaveAttribute('data-state', 'recording');
    const sessionId = (await activeSessionId(serviceWorker))!;

    // The page runs nothing of ours.
    await expect(other.locator('var-review-overlay')).toHaveCount(0);
    // Playwright's key events never reach Chrome's extension-command accelerators (headless or headed), so the
    // test dispatches the `snap` command event to our real onCommand listener instead. That is also why it cannot
    // get the activeTab grant a real Alt+Shift+S gives: without it Chrome refuses to capture another extension's
    // page, so no screenshot is recorded here, and the panel's Snap cannot capture it either. The capture itself
    // is manual check C18.
    const warnings: string[] = [];
    serviceWorker.on('console', (m) => warnings.push(m.text()));
    await other.bringToFront();
    await panel.getByTestId('snap').click();
    await dispatchCommand(serviceWorker, 'snap');
    await expect
      .poll(() => warnings.join('\n'), { timeout: 10_000 })
      .toContain("'activeTab' permission is not in effect");

    await panel.waitForTimeout(1500);
    await panel.getByTestId('stop').click();
    await expect(panel.getByTestId('status')).toHaveText('Ready', { timeout: 20_000 });
    const events = await sessionEvents(panel, sessionId);
    expect(ofType(events, 'session_start')[0]).toMatchObject({ overlay: 'none', url });
    expect(ofType(events, 'stroke')).toHaveLength(0);
    const shots = ofType(events, 'screenshot');
    expect(shots).toHaveLength(0);
    await expect.poll(async () => (await sessionRow(panel, sessionId))?.video, { timeout: 20_000 }).toBeTruthy();
    // Without the management permission another extension keeps its raw origin in the Session list.
    const list = await openExtensionPage('sessions.html');
    await expect(list.getByTestId('origin-label')).toHaveText(url.replace(/\/page\.html$/, ''));
  });
});
