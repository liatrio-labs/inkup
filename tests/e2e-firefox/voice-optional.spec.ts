// E11 in Firefox. No microphone (setup never granted it): Start from the toolbar frame records without voice ("No mic",
// no Mute); an Object Select pick with a typed comment and a drawn circle whose note box opens by itself with a typed
// note; Stop, then Process with no Anthropic key: two Change Items built in code carry the typed text.
// Dictation: Firefox's fake microphone is a tone, not speech, so the scripted transcript stands in for the Whisper tier
// (which emits finals only: no live caption there). In 'auto' an open comment box takes the speech, tagged with the pick
// and kept out of the transcript; in 'push' nothing lands until the box's mic button is on.
import type { Page } from '@playwright/test';
import { circle } from '../e2e/helpers/draw';
import { type ExtPage, expect, test } from './fixtures';

type Row = { type: string; t: number; seq: number; [k: string]: unknown };

function events(page: ExtPage, sessionId: string): Promise<Row[]> {
  return page.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return new Promise<Row[]>((res, rej) => {
      const r = idb.transaction('events').objectStore('events').index('session_id').getAll(id);
      r.onsuccess = () => res((r.result as Row[]).sort((a, b) => a.t - b.t || a.seq - b.seq));
      r.onerror = () => rej(r.error);
    });
  }, sessionId);
}

/** Setup (granting the mic only when `mic`), then Start from the toolbar frame on the pricing page. */
async function start(
  extPage: (part: string) => Promise<ExtPage>,
  page: Page,
  origin: string,
  overrides: Record<string, unknown>,
  mic: boolean,
) {
  const onboarding = await extPage('/onboarding.html');
  await onboarding.evaluate(
    (o) => chrome.storage.local.set({ devOverrides: { transcription: 'scripted', ...o } }),
    overrides,
  );
  if (mic) {
    await onboarding.click('allow-mic');
    await onboarding.waitFor(() => !!document.querySelector('[data-testid="mic-status"]'), undefined, {
      timeout: 20_000,
      what: 'the mic grant',
    });
  }
  await page.goto(`${origin}/pricing.html`);
  await onboarding.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://*/pricing.html' });
    await chrome.storage.session.set({ toolbarTabs: [tab!.id] });
  });
  const frame = page.getByTestId('toolbar-start-frame');
  await expect(frame).toBeVisible();
  await page.waitForTimeout(1000);
  const box = (await frame.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('toolbar')).toHaveAttribute('data-state', 'recording', { timeout: 15_000 });
  const session = await onboarding.evaluate(
    async () => (await chrome.storage.session.get('activeSession')).activeSession as { id: string },
  );
  return { onboarding, sessionId: session.id };
}

async function pickCta(pricing: Page) {
  await pricing.getByTestId('toolbar-object-select').click();
  await expect(pricing.getByTestId('toolbar-object-select')).toHaveAttribute('aria-pressed', 'true');
  const cta = (await pricing.locator('button.cta').boundingBox())!;
  await pricing.mouse.move(cta.x + 10, cta.y + 10);
  await pricing.mouse.click(cta.x + cta.width / 2, cta.y + cta.height / 2);
  await expect(pricing.getByTestId('object-select-input')).toBeFocused({ timeout: 15_000 });
}

test('Firefox: no microphone: a typed pick and a drawn note; Process with no key makes two items from them', async ({
  context,
  extPage,
  site,
}) => {
  test.setTimeout(120_000);
  const pricing = await context.newPage();
  const { onboarding, sessionId } = await start(
    extPage,
    pricing,
    site.primaryOrigin,
    { script: { timestamp_quality: 'approximate', cues: [] } },
    false,
  );
  await expect(pricing.getByTestId('toolbar-no-mic')).toHaveText('No mic');
  await expect(pricing.getByTestId('toolbar-mute')).toHaveCount(0);

  await pickCta(pricing);
  await expect(pricing.getByTestId('object-select-box-mic')).toBeHidden();
  await pricing.getByTestId('object-select-input').pressSequentially('Make this roomier');
  await pricing.getByTestId('object-select-input').press('Enter');
  await expect(pricing.getByTestId('object-select-box')).toBeHidden();
  await pricing.getByTestId('toolbar-object-select').click();

  await pricing.getByTestId('toolbar-draw').click();
  await expect(pricing.getByTestId('toolbar-draw')).toHaveAttribute('aria-pressed', 'true');
  await circle(pricing, (await pricing.locator('.hero .card').boundingBox())!);
  await expect(pricing.getByTestId('annotation-note-input')).toBeFocused({ timeout: 10_000 });
  await pricing.getByTestId('annotation-note-input').pressSequentially('Too much empty space here');
  await pricing.getByTestId('annotation-note-input').press('Enter');
  await expect
    .poll(async () => (await events(onboarding, sessionId)).filter((e) => e.type === 'annotation').length, {
      timeout: 15_000,
    })
    .toBe(2);

  await pricing.getByTestId('toolbar-stop').click();
  const review = await extPage('/review.html', 30_000);
  const evs = await events(review, sessionId);
  expect(evs.find((e) => e.type === 'session_start')).toMatchObject({ voice: false });
  expect(evs.filter((e) => e.type === 'transcript_segment')).toEqual([]);
  expect(evs.filter((e) => e.type === 'annotation').map((a) => a.comment)).toEqual([
    'Make this roomier',
    'Too much empty space here',
  ]);

  await review.waitForText('process-button', /^Process without a model$/);
  await review.click('process-button');
  await review.waitFor(() => document.querySelectorAll('[data-testid="change-item"]').length === 2, undefined, {
    timeout: 20_000,
    what: 'two Change Items',
  });
  const titles = await review.evaluate(() =>
    [...document.querySelectorAll('[data-testid="item-title"]')].map((e) => e.textContent?.trim()),
  );
  expect(titles).toEqual(['Make this roomier', 'Too much empty space here']);
});

test("Firefox: box dictation: auto puts speech in the open box, not the transcript; push only while the box's mic is on", async ({
  context,
  extPage,
  site,
}) => {
  test.setTimeout(120_000);
  const script = {
    timestamp_quality: 'approximate',
    cues: Array.from({ length: 40 }, (_, i) => ({
      at_ms: 2000 + 1500 * i,
      duration_ms: 1200,
      text: `line ${i + 1} spoken`,
    })),
  };
  const pricing = await context.newPage();
  const { onboarding, sessionId } = await start(extPage, pricing, site.primaryOrigin, { script }, true);
  const segments = async () => (await events(onboarding, sessionId)).filter((e) => e.type === 'transcript_segment');
  await expect.poll(async () => (await segments()).length, { timeout: 20_000 }).toBeGreaterThan(0);

  // auto (the default): the box dictates at once.
  await pickCta(pricing);
  const input = pricing.getByTestId('object-select-input');
  await expect(pricing.getByTestId('object-select-box-mic')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => input.inputValue(), { timeout: 10_000 }).toMatch(/line \d+ spoken/);
  await input.press('Enter');
  await expect
    .poll(async () => (await events(onboarding, sessionId)).filter((e) => e.type === 'annotation').length, {
      timeout: 15_000,
    })
    .toBe(1);
  const pick = (await events(onboarding, sessionId)).find((e) => e.type === 'annotation')!;
  const dictated = (pick.comment as string).match(/line \d+ spoken/g)!;
  const segs = await segments();
  for (const line of dictated)
    expect(segs.filter((s) => s.text === line).map((s) => s.target)).toEqual([{ annotation_id: pick.annotation_id }]);
  await pricing.keyboard.press('Escape');
  await expect(pricing.getByTestId('toolbar-object-select')).toHaveAttribute('aria-pressed', 'false');

  // push: nothing until the box's mic button is on.
  await onboarding.evaluate(async () => {
    const { captureSettings } = await chrome.storage.local.get('captureSettings');
    await chrome.storage.local.set({ captureSettings: { ...(captureSettings ?? {}), boxDictation: 'push' } });
  });
  await pricing.getByTestId('toolbar-mute').click();
  await expect(pricing.getByTestId('toolbar-mute')).toHaveAttribute('aria-pressed', 'true');
  await pickCta(pricing);
  await expect(pricing.getByTestId('object-select-box-mic')).toHaveAttribute('aria-pressed', 'false');
  await pricing.waitForTimeout(3500);
  expect(await input.inputValue()).toBe('');
  await pricing.getByTestId('object-select-box-mic').click();
  await expect.poll(() => input.inputValue(), { timeout: 10_000 }).toMatch(/line \d+ spoken/);
  await input.press('Enter');
  await expect
    .poll(async () => (await events(onboarding, sessionId)).filter((e) => e.type === 'annotation').length, {
      timeout: 15_000,
    })
    .toBe(2);
  await expect(pricing.getByTestId('toolbar-mute')).toHaveAttribute('aria-pressed', 'true');
  expect((await events(onboarding, sessionId)).filter((e) => e.type === 'voice_command')).toEqual([]);
});
