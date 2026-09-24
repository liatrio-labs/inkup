// F1 proof (#16, #21): the toolbar's Start works on the first click, every time, and the page has the Session the
// moment the toolbar says Recording. The toolbar shows "Starting…" until the page has acknowledged the Session, so a
// mode shortcut pressed as soon as the timer appears is answered. Twenty Starts in a row, each one click, no retry.
import type { Page, Worker } from '@playwright/test';
import { ALLOW_TAB_CAPTURE, expect, grantMic, test } from './fixtures';
import { activeSessionId } from './helpers/session';
import { armStartProbe, MODES_WITHIN_MS, startProbe } from './helpers/start-probe';

test.use({ extraArgs: [ALLOW_TAB_CAPTURE] });

const STARTS = 20;

const selectMode = (sw: Worker) =>
  sw.evaluate(
    async () =>
      ((await chrome.storage.session.get('activeSession')).activeSession as { select_mode?: string | null } | null)
        ?.select_mode ?? null,
  );

async function stopAndWait(page: Page, sw: Worker) {
  await page.getByTestId('toolbar-stop').click();
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
  await expect.poll(() => activeSessionId(sw), { timeout: 30_000 }).toBe(null);
}

test(`the toolbar's first Start click starts the Session ${STARTS} times in a row, and modes answer within ${MODES_WITHIN_MS} ms of Recording`, async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(STARTS * 20_000);
  await grantMic(openExtensionPage);
  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://*/pricing.html' });
    (chrome.action.onClicked as unknown as { dispatch(tab: chrome.tabs.Tab): void }).dispatch(tab!);
  });
  const toolbar = pricing.getByTestId('toolbar');
  context.on('page', (p) => {
    if (p.url().includes('/review.html')) void p.close().catch(() => {});
  });

  const gaps: number[] = [];
  for (let i = 0; i < STARTS; i++) {
    await expect(toolbar).toHaveAttribute('data-state', 'idle');
    await armStartProbe(pricing);
    // One click. No retry: #16 was a first click that did nothing. Every other click is held down while the service
    // worker pushes the toolbar a new state, which re-renders it: the pressed button must survive that.
    const start = pricing.getByTestId('toolbar-start');
    if (i % 2 === 0) await start.click();
    else {
      const box = (await start.boundingBox())!;
      await pricing.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await pricing.mouse.down();
      await serviceWorker.evaluate(
        (n) => chrome.storage.local.set({ viewportSizes: { [`push ${n}`]: { width: 400 + n, height: 700 } } }),
        i,
      );
      await pricing.waitForTimeout(300);
      await pricing.mouse.up();
    }
    await expect(toolbar, `start ${i + 1}: the first click starts`).toHaveAttribute('data-state', 'recording');
    await expect
      .poll(async () => (await startProbe(pricing)).pressedAt, {
        message: `start ${i + 1}: Object Select answers`,
        timeout: 5_000,
      })
      .not.toBe(null);
    const probe = await startProbe(pricing);
    const gap = probe.pressedAt! - probe.recordingAt!;
    gaps.push(Math.round(gap));
    expect(gap, `start ${i + 1}: states ${probe.states.join(' → ')}`).toBeLessThan(MODES_WITHIN_MS);
    // Never idle again after Recording: the one click started it.
    expect(probe.states.slice(probe.states.indexOf('recording'))).not.toContain('idle');
    // The service worker took the request too: the page showed it at once, and the Session holds it.
    await expect.poll(() => selectMode(serviceWorker)).toBe('object');
    await pricing.keyboard.press('Escape');
    await expect.poll(() => selectMode(serviceWorker)).toBe(null);
    await stopAndWait(pricing, serviceWorker);
  }
  console.log(`Recording → Object Select on, ms: ${gaps.join(', ')}`);
});

test('Alt+Shift+R starts on the first press too, with the toolbar, and modes answer within the same bound', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  await grantMic(openExtensionPage);
  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  const shortcut = () =>
    serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: '*://*/pricing.html' });
      // The real command listener (automation cannot press a browser shortcut).
      (chrome.commands.onCommand as unknown as { dispatch(c: string, tab: chrome.tabs.Tab): void }).dispatch(
        'toggle-session',
        tab!,
      );
    });
  context.on('page', (p) => {
    if (p.url().includes('/review.html')) void p.close().catch(() => {});
  });
  // The first press shows the toolbar and starts at once.
  await shortcut();
  const toolbar = pricing.getByTestId('toolbar');
  await expect(toolbar).toHaveAttribute('data-state', 'recording');
  await stopAndWait(pricing, serviceWorker);
  for (let i = 0; i < 5; i++) {
    await armStartProbe(pricing);
    await shortcut();
    await expect(toolbar, `shortcut start ${i + 1}`).toHaveAttribute('data-state', 'recording');
    await expect.poll(async () => (await startProbe(pricing)).pressedAt, { timeout: 5_000 }).not.toBe(null);
    const probe = await startProbe(pricing);
    expect(probe.pressedAt! - probe.recordingAt!).toBeLessThan(MODES_WITHIN_MS);
    await expect.poll(() => selectMode(serviceWorker)).toBe('object');
    await pricing.keyboard.press('Escape');
    await shortcut();
    await expect(toolbar).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
    await expect.poll(() => activeSessionId(serviceWorker), { timeout: 30_000 }).toBe(null);
  }
});
