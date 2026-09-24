// Slice 7: the Session list (PRD P0-14), the 80% storage warning, and the 45/60-minute soft cap (P0-1).
import type { Page, Worker } from '@playwright/test';
import { expect, grantMic, test } from './fixtures';
import { putRows } from './helpers/seed';
import { activeSessionId } from './helpers/session';

/** Starts a Session on `page` from the panel, records for a moment, stops, and closes the review tab it opens. */
async function recordSession(panel: Page, page: Page, ms = 1500): Promise<void> {
  await page.bringToFront();
  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  await panel.waitForTimeout(ms);
  const review = panel.context().waitForEvent('page', (p) => p.url().includes('/review.html'));
  await panel.getByTestId('stop').click();
  await (await review).close();
  await expect(panel.getByTestId('status')).toHaveText('Ready');
}

/** Rows per store for one Session, read from IndexedDB in an extension page. */
function storedRows(page: Page, sessionId: string) {
  return page.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const count = (store: string, index: string | null) =>
      new Promise<number>((res, rej) => {
        const s = idb.transaction(store).objectStore(store);
        const r = index ? s.index(index).count(id) : s.count(id);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    return {
      sessions: await count('sessions', null),
      events: await count('events', 'session_id'),
      blobs: await count('blobs', 'session_id'),
    };
  }, sessionId);
}

/**
 * Moves the Session's clock origin so it has run `minutes` already. The service worker also rewrites the active
 * Session (Voice Command status, captions), and a write that read the old value can undo this one, so it is
 * re-applied until the panel's timer shows it.
 */
async function runFor(sw: Worker, panel: Page, minutes: number) {
  await expect(async () => {
    await sw.evaluate(async (m) => {
      const { activeSession } = (await chrome.storage.session.get('activeSession')) as {
        activeSession: { t0: number };
      };
      await chrome.storage.session.set({ activeSession: { ...activeSession, t0: Date.now() - m * 60_000 } });
    }, minutes);
    await expect(panel.getByTestId('timer')).toHaveText(new RegExp(`^${minutes}:\\d\\d$`), { timeout: 2000 });
  }).toPass({ timeout: 15_000 });
}

test('the Session list groups by starting origin, shows date, length, items and size, opens the review and deletes after a confirmation', async ({
  context,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  await grantMic(openExtensionPage);
  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  const partner = await context.newPage();
  await partner.goto(`${site.secondOrigin}/second/other.html`);
  const panel = await openExtensionPage('sidepanel.html');

  await recordSession(panel, pricing);
  await recordSession(panel, partner);
  await recordSession(panel, pricing, 2500);

  // The panel links to the list.
  await expect(panel.getByTestId('open-sessions')).toHaveAttribute('href', '/sessions.html');
  const list = await openExtensionPage('sessions.html');
  await expect(list.getByTestId('session-row')).toHaveCount(3);
  const groups = list.getByTestId('origin-group');
  await expect(groups).toHaveCount(2);
  // Groups ordered by their newest Session: the last recording was on the primary origin.
  await expect(groups.nth(0)).toHaveAttribute('data-origin', site.primaryOrigin);
  await expect(groups.nth(1)).toHaveAttribute('data-origin', site.secondOrigin);
  await expect(groups.nth(0).getByTestId('session-row')).toHaveCount(2);
  const newest = groups.nth(0).getByTestId('session-row').first();
  await expect(newest).toContainText('Pricing Fixture');
  await expect(newest.getByTestId('session-length')).toHaveText(/^00:0[2-9]$/);
  await expect(newest.getByTestId('session-items')).toHaveText('not processed');
  await expect(newest.getByTestId('session-size')).toHaveText(/^\d+(\.\d)? (KB|MB)$/);
  await expect(newest.getByTestId('session-date')).not.toBeEmpty();
  await expect(list.getByTestId('storage-total')).toContainText('3 Sessions');

  // Open review.
  const id = (await newest.getAttribute('data-session'))!;
  const reviewPromise = context.waitForEvent('page', (p) => p.url().includes(`/review.html?session=${id}`));
  await newest.getByTestId('open-review').click();
  const review = await reviewPromise;
  await expect(review.getByRole('heading', { name: 'Session review' })).toBeVisible();
  await review.close();

  // Delete asks first; Cancel keeps it; Delete removes the Session and everything stored for it.
  expect((await storedRows(list, id)).blobs).toBeGreaterThan(0);
  await newest.getByTestId('delete-session').click();
  await expect(newest).toContainText('This cannot be undone');
  await newest.getByRole('button', { name: 'Cancel' }).click();
  await expect(list.getByTestId('session-row')).toHaveCount(3);
  await list.locator(`[data-session="${id}"]`).getByTestId('delete-session').click();
  await list.locator(`[data-session="${id}"]`).getByTestId('confirm-delete').click();
  await expect(list.getByTestId('session-row')).toHaveCount(2);
  await expect(list.getByTestId('storage-total')).toContainText('2 Sessions');
  expect(await storedRows(list, id)).toEqual({ sessions: 0, events: 0, blobs: 0 });

  // The options page links here too.
  const options = await openExtensionPage('options.html');
  await expect(options.getByTestId('open-sessions')).toHaveAttribute('href', '/sessions.html');
});

/** A processed Session as stored: its row, a done Process run with `ids` as its Change Items, and no media. */
function processedSession(id: string, ids: string[], startedAt: string) {
  const runId = `${id}-run`;
  return {
    runId,
    session: {
      id,
      tab_id: 1,
      t0: 0,
      started_at: startedAt,
      ended_at: startedAt,
      duration_ms: 5000,
      start_url: 'https://app.example/pricing',
      start_title: `Seeded ${id}`,
      status: 'ended',
      transcription: null,
      video_off_reason: null,
      media_deleted_at: null,
      audio: null,
      video: null,
    },
    run: {
      id: runId,
      session_id: id,
      created_at: 1,
      finished_at: 2,
      status: 'done',
      model: 'seeded',
      estimate: null,
      items: ids.map((item) => ({
        id: item,
        title: `Change ${item}`,
        category: 'copy',
        intent: 'Seeded.',
        locations: [],
        evidence: { video: null, screenshots: [] },
        transcript: '',
        confidence: 0.9,
        agent_prompt: 'Seeded.',
        pinned: false,
      })),
      calls: [],
      second_pass: [],
      error: null,
      error_code: null,
    },
  };
}

test('a Session row counts its current Change Items by their latest Resolution, on the list and in the side panel', async ({
  openExtensionPage,
}) => {
  const list = await openExtensionPage('sessions.html');
  await expect(list.getByTestId('no-sessions')).toBeVisible();
  const acted = processedSession(
    'acted',
    ['item_0001', 'item_0002', 'item_0003', 'item_0004', 'item_0005', 'item_0006'],
    '2026-09-20T10:00:00.000Z',
  );
  const untouched = processedSession('untouched', ['item_0001', 'item_0002'], '2026-09-21T10:00:00.000Z');
  const res = (id: string, item_id: string, status: string, created_at: number, run_id = acted.runId) => ({
    id,
    session_id: 'acted',
    run_id,
    item_id,
    status,
    note: '',
    source: 'mcp',
    created_at,
  });
  await putRows(list, {
    sessions: [acted.session, untouched.session],
    processRuns: [acted.run, untouched.run],
    // The reviewer deleted item_0006; its Resolution no longer counts.
    events: [
      {
        type: 'item_edit',
        id: 'edit-1',
        t: 5000,
        edited_at: '2026-09-20T10:01:00.000Z',
        run_id: acted.runId,
        edit: { op: 'delete', item_id: 'item_0006' },
        session_id: 'acted',
      },
    ],
    resolutions: [
      res('r1', 'item_0001', 'in_progress', 100),
      // Started, then resolved in the same millisecond: the later id wins.
      res('r2a', 'item_0002', 'in_progress', 200),
      res('r2b', 'item_0002', 'resolved', 200),
      res('r3', 'item_0003', 'wont_fix', 300),
      res('r4', 'item_0004', 'needs_info', 400),
      res('r6', 'item_0006', 'resolved', 600),
      // A Resolution of an earlier run's item is not this run's.
      res('r5', 'item_0005', 'resolved', 700, 'acted-older-run'),
    ],
  });

  for (const page of [list, await openExtensionPage('sidepanel.html')]) {
    await page.reload();
    const items = page.locator('[data-session="acted"]').getByTestId('session-items');
    await expect(items).toHaveText('5 Change Items: 1 open · 1 in work · 2 done · 1 needs info');
    await expect(items).toHaveAttribute('data-total', '5');
    await expect(items).toHaveAttribute('data-open', '1');
    await expect(items).toHaveAttribute('data-in-progress', '1');
    await expect(items).toHaveAttribute('data-done', '2');
    await expect(items).toHaveAttribute('data-needs-info', '1');
    // Nothing acted on: the plain count, as before any agent.
    await expect(page.locator('[data-session="untouched"]').getByTestId('session-items')).toHaveText('2 Change Items');
  }
});

test('at 80% of the storage quota the Session list and the panel warn', async ({ context, openExtensionPage }) => {
  // The quota is the browser's; stand in for a nearly full disk by answering estimate() with 85%.
  await context.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:') return;
    Object.defineProperty(navigator.storage, 'estimate', {
      value: async () => ({ usage: 85_000_000, quota: 100_000_000 }),
    });
  });
  const list = await openExtensionPage('sessions.html');
  await expect(list.getByTestId('storage-warning')).toContainText('Storage is 85% full');
  await expect(list.getByTestId('storage-total')).toContainText('85%');
  const panel = await openExtensionPage('sidepanel.html');
  await expect(panel.getByTestId('storage-warning')).toContainText('Storage is 85% full');
});

test('below 80% nothing warns', async ({ openExtensionPage }) => {
  const list = await openExtensionPage('sessions.html');
  await expect(list.getByTestId('no-sessions')).toBeVisible();
  await expect(list.getByTestId('storage-warning')).toHaveCount(0);
  const panel = await openExtensionPage('sidepanel.html');
  await expect(panel.getByTestId('start')).toBeVisible();
  await expect(panel.getByTestId('storage-warning')).toHaveCount(0);
});

test('the panel warns at 45 and 60 minutes and keeps recording', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  await grantMic(openExtensionPage);
  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  const panel = await openExtensionPage('sidepanel.html');
  await pricing.bringToFront();
  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  await expect(panel.getByTestId('soft-cap')).toHaveCount(0);

  // Move the Session's clock origin back instead of waiting 45 minutes.
  await runFor(serviceWorker, panel, 45);
  await expect(panel.getByTestId('soft-cap')).toHaveAttribute('data-minutes', '45');
  await expect(panel.locator('[data-sonner-toast]').filter({ hasText: 'run for 45 minutes' })).toBeVisible();
  await expect(panel.getByTestId('status')).toHaveText('Recording');

  await runFor(serviceWorker, panel, 60);
  await expect(panel.getByTestId('soft-cap')).toHaveAttribute('data-minutes', '60');
  await expect(panel.locator('[data-sonner-toast]').filter({ hasText: 'run for 60 minutes' })).toBeVisible();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  expect(await activeSessionId(serviceWorker)).not.toBeNull();

  const review = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await panel.getByTestId('stop').click();
  await review;
  await expect(panel.getByTestId('status')).toHaveText('Ready');
});

/** The panel timer as seconds, from its mm:ss text. */
async function timerSeconds(panel: Page): Promise<number> {
  const [m, s] = (await panel.getByTestId('timer').textContent())!.split(':').map(Number);
  return m! * 60 + s!;
}

test('the panel timer stops while paused and continues from there on resume', async ({
  context,
  site,
  openExtensionPage,
}) => {
  await grantMic(openExtensionPage);
  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  const panel = await openExtensionPage('sidepanel.html');
  await pricing.bringToFront();
  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  // At least 2 s: a busy panel repaints the timer late and can skip straight past 00:02.
  await expect.poll(() => timerSeconds(panel), { timeout: 5000 }).toBeGreaterThanOrEqual(2);

  await panel.getByTestId('pause').click();
  await expect(panel.getByTestId('status')).toHaveText('Paused');
  const frozen = await timerSeconds(panel);
  await panel.waitForTimeout(3500);
  expect(await timerSeconds(panel)).toBe(frozen);

  await panel.getByTestId('resume').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  // It continues from the frozen value: no jump by the 3.5 s pause.
  const resumed = await timerSeconds(panel);
  expect(resumed - frozen).toBeLessThanOrEqual(1);
  // And it runs again.
  await expect.poll(() => timerSeconds(panel), { timeout: 3000 }).toBeGreaterThan(resumed);
  expect(await timerSeconds(panel)).toBeLessThanOrEqual(frozen + 3);

  const review = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await panel.getByTestId('stop').click();
  await review;
});

test('the idle panel lists previous Sessions newest first, opens their review and deletes after a confirmation', async ({
  context,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(90_000);
  await grantMic(openExtensionPage);
  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  const partner = await context.newPage();
  await partner.goto(`${site.secondOrigin}/second/other.html`);
  const panel = await openExtensionPage('sidepanel.html');
  await expect(panel.getByTestId('previous-sessions').getByTestId('no-sessions')).toBeVisible();

  await recordSession(panel, pricing);
  await recordSession(panel, partner);

  const rows = panel.getByTestId('previous-sessions').getByTestId('session-row');
  await expect(rows).toHaveCount(2);
  // Newest first: the partner page was recorded last.
  await expect(rows.nth(0)).toContainText(site.secondOrigin);
  await expect(rows.nth(1)).toContainText('Pricing Fixture');
  await expect(rows.nth(1).getByTestId('session-length')).toHaveText(/^00:0[1-9]$/);
  await expect(rows.nth(1).getByTestId('session-items')).toHaveText('not processed');
  await expect(rows.nth(1).getByTestId('session-date')).not.toBeEmpty();

  const id = (await rows.nth(1).getAttribute('data-session'))!;
  const reviewPromise = context.waitForEvent('page', (p) => p.url().includes(`/review.html?session=${id}`));
  await rows.nth(1).getByTestId('open-review').click();
  await expect((await reviewPromise).getByRole('heading', { name: 'Session review' })).toBeVisible();

  await rows.nth(1).getByTestId('delete-session').click();
  await expect(rows.nth(1)).toContainText('This cannot be undone');
  await rows.nth(1).getByTestId('confirm-delete').click();
  await expect(rows).toHaveCount(1);
  expect(await storedRows(panel, id)).toEqual({ sessions: 0, events: 0, blobs: 0 });

  // While recording, the list is replaced by the Session controls.
  await pricing.bringToFront();
  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  await expect(panel.getByTestId('previous-sessions')).toHaveCount(0);
  const review = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await panel.getByTestId('stop').click();
  await review;
});
