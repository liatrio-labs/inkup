// E7 in Firefox: Object Select from the toolbar. Hover outlines the CTA, ↑ its card and ↓ back, ⏎ picks it; the
// comment box opens next to it and "Make this roomier" + Enter records an Annotation (close reason object_select) with
// the comment. The page is never modified. Esc on the page turns Object Select off.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { type ExtPage, expect, ROOT, test } from './fixtures';

type Box = { x: number; y: number; width: number; height: number };
const near = (a: Box, b: Box) =>
  Math.abs(a.x - b.x) <= 2 &&
  Math.abs(a.y - b.y) <= 2 &&
  Math.abs(a.width - b.width) <= 2 &&
  Math.abs(a.height - b.height) <= 2;

function events(
  page: ExtPage,
  sessionId: string,
): Promise<{ type: string; t: number; t_end?: number; [k: string]: unknown }[]> {
  return page.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return new Promise<{ type: string; t: number; seq: number }[]>((res, rej) => {
      const r = idb.transaction('events').objectStore('events').index('session_id').getAll(id);
      r.onsuccess = () =>
        res((r.result as { type: string; t: number; seq: number }[]).sort((a, b) => a.t - b.t || a.seq - b.seq));
      r.onerror = () => rej(r.error);
    });
  }, sessionId);
}

const ctaStyle = (pricing: Page) =>
  pricing
    .locator('button.cta')
    .evaluate((el) =>
      [...getComputedStyle(el)].map((p) => `${p}:${getComputedStyle(el).getPropertyValue(p)}`).join(';'),
    );

test('Firefox: Object Select picks the CTA and records the typed comment; the page is never modified', async ({
  context,
  extPage,
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

  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  await onboarding.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://*/pricing.html' });
    await chrome.storage.session.set({ toolbarTabs: [tab!.id] });
  });
  const toolbar = pricing.getByTestId('toolbar');
  const frame = pricing.getByTestId('toolbar-start-frame');
  await expect(frame).toBeVisible();
  await pricing.waitForTimeout(1000);
  const box = (await frame.boundingBox())!;
  await pricing.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(toolbar).toHaveAttribute('data-state', 'recording', { timeout: 15_000 });
  const session = await onboarding.evaluate(
    async () => (await chrome.storage.session.get('activeSession')).activeSession as { id: string },
  );

  const before = await ctaStyle(pricing);

  await pricing.getByTestId('toolbar-object-select').click();
  await expect(pricing.getByTestId('toolbar-object-select')).toHaveAttribute('aria-pressed', 'true');
  const cta = (await pricing.locator('button.cta').boundingBox())!;
  const card = (await pricing.locator('.hero .card').boundingBox())!;
  const outline = pricing.getByTestId('object-select-highlight');
  await pricing.mouse.move(cta.x + 10, cta.y + 10);
  await pricing.mouse.move(cta.x + cta.width / 2, cta.y + cta.height / 2, { steps: 3 });
  await expect.poll(async () => near((await outline.boundingBox())!, cta)).toBe(true);
  await pricing.keyboard.press('ArrowUp');
  await expect.poll(async () => near((await outline.boundingBox())!, card)).toBe(true);
  await pricing.keyboard.press('ArrowDown');
  await expect.poll(async () => near((await outline.boundingBox())!, cta)).toBe(true);
  await pricing.keyboard.press('Enter');
  const commentBox = pricing.getByTestId('object-select-box');
  await expect(commentBox).toBeVisible({ timeout: 15_000 });
  const input = pricing.getByTestId('object-select-input');
  await expect(input).toBeFocused();
  await input.pressSequentially('Make this roomier');
  await input.press('Enter');
  await expect(commentBox).toBeHidden();
  await expect
    .poll(async () => (await events(onboarding, session.id)).filter((e) => e.type === 'annotation').length, {
      timeout: 15_000,
    })
    .toBe(1);
  const [pick] = (await events(onboarding, session.id)).filter((e) => e.type === 'annotation');
  expect(pick).toMatchObject({
    close_reason: 'object_select',
    comment: 'Make this roomier',
    stroke_ids: [],
    pick: 0,
    candidates: [expect.objectContaining({ selector: 'button.cta', relation: 'pick' })],
  });
  expect(pick!.screenshot_id).not.toBeNull();
  expect(pick!.t_end).toBeGreaterThan(pick!.t);

  await pricing.keyboard.press('Escape');
  await expect(pricing.getByTestId('toolbar-object-select')).toHaveAttribute('aria-pressed', 'false');
  expect(await ctaStyle(pricing)).toBe(before);
  await pricing.getByTestId('toolbar-stop').click();
  await expect(toolbar).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
});
