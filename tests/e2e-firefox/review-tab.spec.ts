// Decisions log #39 in Firefox (an event page, not a service worker): "Open review" focuses the tab already showing
// that Session's review instead of opening another. The Session is a fixture session.json restored from the side
// panel (the file is handed to the input from the page, as RDP cannot upload one).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ExtPage, expect, ROOT, test } from './fixtures';

const doc = readFileSync(join(ROOT, 'fixtures/sessions/a-move-here.word.json'), 'utf8');
const SESSION = (JSON.parse(doc) as { session: { id: string } }).session.id;

const reviewTabs = (page: ExtPage) =>
  page.evaluate(async (id) => {
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter((t) => t.url?.startsWith(chrome.runtime.getURL('/review.html')))
      .filter((t) => new URL(t.url!).searchParams.get('session') === id)
      .map((t) => ({ active: t.active }));
  }, SESSION);

test('Firefox: Open review twice leaves one review tab for the Session', async ({ extPage, openExtensionWindow }) => {
  test.setTimeout(60_000);
  const panel = await openExtensionWindow('sidepanel.html');
  await panel.waitFor((json) => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="restore-input"]');
    if (!input) return false;
    const dt = new DataTransfer();
    dt.items.add(new File([json], 'session.json', { type: 'application/json' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, doc);
  await panel.waitForText('restore-done', /Restored/);

  await panel.click('restore-open-review');
  const review = await extPage(`/review.html?session=${SESSION}`, 20_000);
  await review.waitFor(() => !!document.querySelector('h1, h2'), undefined, { what: 'the review page' });
  expect(await reviewTabs(panel)).toHaveLength(1);

  await panel.click('restore-open-review');
  await expect.poll(() => reviewTabs(panel), { timeout: 10_000 }).toEqual([{ active: true }]);
  await new Promise((r) => setTimeout(r, 1000));
  expect(await reviewTabs(panel)).toHaveLength(1);
});
