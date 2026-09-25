// ADR 0019: one review tab per Session. "Open review" and Stop focus the tab already showing that
// Session's review; only a Session with none gets a new tab. Cmd or Ctrl click still opens another on purpose.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { SessionDocument } from '../../packages/core/src/session-document.ts';
import { expect, grantMic, ROOT, test } from './fixtures';
import { reviewTabs } from './helpers/review-tabs';
import { seedSession } from './helpers/seed';

const fixture = (): SessionDocument =>
  JSON.parse(readFileSync(join(ROOT, 'fixtures/sessions/a-move-here.word.json'), 'utf8'));

/** The Sessions page with two stored Sessions, `a` and `b`. */
async function listWithTwo(openExtensionPage: (path: string) => Promise<Page>): Promise<Page> {
  const list = await openExtensionPage('sessions.html');
  await expect
    .poll(() => list.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === 'inkup')))
    .toBe(true);
  for (const id of ['a', 'b']) {
    const doc = fixture();
    await seedSession(list, { ...doc, session: { ...doc.session, id } });
  }
  // Raw IndexedDB writes do not wake Dexie's live queries.
  await list.reload();
  await expect(list.getByTestId('session-row')).toHaveCount(2);
  return list;
}

test('Open review twice keeps one tab for the Session and brings it forward; another Session gets its own', async ({
  context,
  serviceWorker,
  openExtensionPage,
}) => {
  const list = await listWithTwo(openExtensionPage);
  const link = (id: string) => list.locator(`[data-session="${id}"]`).getByTestId('open-review');

  const opened = context.waitForEvent('page', (p) => p.url().includes('/review.html?session=a'));
  await link('a').click();
  const reviewA = await opened;
  await expect(reviewA.getByRole('heading', { name: 'Session review' })).toBeVisible();
  await expect.poll(() => reviewTabs(serviceWorker, 'a')).toHaveLength(1);

  // A second click focuses that tab: no new page, still one tab, and it is the active one.
  await list.bringToFront();
  let extra = 0;
  const count = () => extra++;
  context.on('page', count);
  await link('a').click();
  await expect.poll(() => reviewTabs(serviceWorker, 'a')).toEqual([{ id: expect.any(Number), active: true }]);
  await expect
    .poll(() =>
      serviceWorker.evaluate(
        async () => (await chrome.windows.getLastFocused({ populate: true })).tabs?.find((t) => t.active)?.url,
      ),
    )
    .toContain('/review.html?session=a');
  await list.waitForTimeout(500);
  context.off('page', count);
  expect(extra).toBe(0);

  // Session b has no review tab yet: it gets one.
  const openedB = context.waitForEvent('page', (p) => p.url().includes('/review.html?session=b'));
  await link('b').click();
  await expect((await openedB).getByRole('heading', { name: 'Session review' })).toBeVisible();
  await expect.poll(() => reviewTabs(serviceWorker, 'b')).toHaveLength(1);
  expect(await reviewTabs(serviceWorker, 'a')).toHaveLength(1);

  // A modifier click is a deliberate new tab: the href opens a second copy, as any link would.
  const second = context.waitForEvent('page', (p) => p.url().includes('/review.html?session=a'));
  await link('a').click({ modifiers: ['ControlOrMeta'] });
  await second;
  await expect.poll(() => reviewTabs(serviceWorker, 'a')).toHaveLength(2);
});

test('after Stop opens the review, Open review from the list keeps that one tab', async ({
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
  await panel.waitForTimeout(1500);
  const opened = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await panel.getByTestId('stop').click();
  const review = await opened;
  await expect(panel.getByTestId('status')).toHaveText('Ready');
  const id = new URL(review.url()).searchParams.get('session')!;
  await expect.poll(() => reviewTabs(serviceWorker, id)).toHaveLength(1);

  // From the panel's list and the Sessions page alike.
  await panel.getByTestId('previous-sessions').locator(`[data-session="${id}"]`).getByTestId('open-review').click();
  const list = await openExtensionPage('sessions.html');
  await list.locator(`[data-session="${id}"]`).getByTestId('open-review').click();
  await expect.poll(() => reviewTabs(serviceWorker, id)).toEqual([{ id: expect.any(Number), active: true }]);
  await list.waitForTimeout(500);
  expect(await reviewTabs(serviceWorker, id)).toHaveLength(1);
});
