// E11 proof: a Session without voice, Process without a model, and comment-box dictation.
//
// No microphone (setup never granted it): Start from the page's toolbar records without voice ("No mic", no Mute).
// An Object Select pick with a typed comment, a Text Comment typed on the heading, and a drawn circle whose note box
// opens by itself (no voice to say what it is about) with a typed note. Stop, then Process with no Anthropic key:
// three Change Items built in code carry the typed text, and the exported review.md lists them.
//
// Dictation: the fake mic plays fixtures/audio/voice-session.wav and a scripted transcript speaks a numbered line
// every 1.5 s. In 'auto' an open comment box takes the speech: words land in the box (their segments tagged with the
// pick), never in the Session transcript or the captions. In 'push' nothing lands until the box's mic button is on,
// and that works while muted, which holds again once the box closes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { ALLOW_TAB_CAPTURE, expect, grantMic, test, useBoxDictation, useScript } from './fixtures';
import { circle } from './helpers/draw';
import { exportAndUnzip } from './helpers/export';
import { activeSessionId, ofType, sessionEvents } from './helpers/session';

test.use({ extraArgs: [ALLOW_TAB_CAPTURE] });

async function startFromToolbar(
  context: BrowserContext,
  sw: Worker,
  site: { primaryOrigin: string },
): Promise<{ pricing: Page; sessionId: string }> {
  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://*/pricing.html' });
    (chrome.action.onClicked as unknown as { dispatch(tab: chrome.tabs.Tab): void }).dispatch(tab!);
  });
  await pricing.getByTestId('toolbar-start').click();
  await expect(pricing.getByTestId('toolbar')).toHaveAttribute('data-state', 'recording');
  return { pricing, sessionId: (await activeSessionId(sw))! };
}

/** Object Select on, then a click on the CTA: its comment box opens. */
async function pickCta(pricing: Page) {
  await pricing.getByTestId('toolbar-object-select').click();
  await expect(pricing.getByTestId('toolbar-object-select')).toHaveAttribute('aria-pressed', 'true');
  const cta = (await pricing.locator('button.cta').boundingBox())!;
  await pricing.mouse.move(cta.x + 10, cta.y + 10);
  await pricing.mouse.click(cta.x + cta.width / 2, cta.y + cta.height / 2);
  await expect(pricing.getByTestId('object-select-input')).toBeFocused({ timeout: 15_000 });
}

async function selectHeading(pricing: Page) {
  const ends = await pricing.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('#hero-title')!);
    const rects = [...range.getClientRects()];
    return {
      from: { x: rects[0]!.left + 1, y: rects[0]!.top + rects[0]!.height / 2 },
      to: { x: rects.at(-1)!.right - 1, y: rects.at(-1)!.top + rects.at(-1)!.height / 2 },
    };
  });
  await pricing.mouse.move(ends.from.x, ends.from.y);
  await pricing.mouse.down();
  await pricing.mouse.move(ends.to.x, ends.to.y, { steps: 10 });
  await pricing.mouse.up();
}

test('no microphone: pick, text comment and drawn note all typed; Process with no key makes three items from them', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(150_000);
  const { pricing, sessionId } = await startFromToolbar(context, serviceWorker, site);
  await expect(pricing.getByTestId('toolbar-no-mic')).toHaveText('No mic');
  await expect(pricing.getByTestId('toolbar-voice-on')).toBeVisible();
  await expect(pricing.getByTestId('toolbar-mute')).toHaveCount(0);

  // 1. Object Select: the box has no mic button without voice.
  await pickCta(pricing);
  await expect(pricing.getByTestId('object-select-box-mic')).toBeHidden();
  await pricing.getByTestId('object-select-input').pressSequentially('Make this roomier');
  await pricing.getByTestId('object-select-input').press('Enter');
  await expect(pricing.getByTestId('object-select-box')).toBeHidden();
  await pricing.getByTestId('toolbar-object-select').click();
  await expect(pricing.getByTestId('toolbar-object-select')).toHaveAttribute('aria-pressed', 'false');

  // 2. Select Text on, select the heading, type the new text.
  await pricing.getByTestId('toolbar-select-text').click();
  await expect(pricing.getByTestId('toolbar-select-text')).toHaveAttribute('aria-pressed', 'true');
  await expect(async () => {
    await selectHeading(pricing);
    await expect(pricing.getByTestId('text-comment-box')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await pricing.getByTestId('text-comment-input').pressSequentially('This should say Pricing plans');
  await pricing.getByTestId('text-comment-input').press('Enter');
  await expect(pricing.getByTestId('text-comment-box')).toBeHidden();

  // 3. Draw a circle: once drawing pauses, its note box opens by itself.
  await pricing.getByTestId('toolbar-draw').click();
  await expect(pricing.getByTestId('toolbar-draw')).toHaveAttribute('aria-pressed', 'true');
  await circle(pricing, (await pricing.locator('.hero .card').boundingBox())!);
  await expect(pricing.getByTestId('annotation-note-box')).toBeVisible({ timeout: 10_000 });
  await expect(pricing.getByTestId('annotation-note-input')).toBeFocused();
  await pricing.getByTestId('annotation-note-input').pressSequentially('Too much empty space here');
  await pricing.getByTestId('annotation-note-input').press('Enter');
  await expect(pricing.getByTestId('annotation-note-box')).toBeHidden();
  const ext = await openExtensionPage('sessions.html');
  await expect
    .poll(async () => ofType(await sessionEvents(ext, sessionId), 'annotation').length, { timeout: 15_000 })
    .toBe(2);

  const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await pricing.getByTestId('toolbar-stop').click();
  const review = await reviewPromise;

  const events = await sessionEvents(review, sessionId);
  expect(ofType(events, 'session_start')[0]).toMatchObject({ voice: false });
  expect(ofType(events, 'transcript_segment')).toEqual([]);
  expect(ofType(events, 'annotation').map((a) => [a.close_reason, a.comment])).toEqual([
    ['object_select', 'Make this roomier'],
    [expect.stringMatching(/^(time_gap|draw_toggle)$/), 'Too much empty space here'],
  ]);
  expect(ofType(events, 'text_comment').map((c) => c.comment)).toEqual(['This should say Pricing plans']);
  const row = await review.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return new Promise<{ audio: unknown }>((res) => {
      const r = idb.transaction('sessions').objectStore('sessions').get(id);
      r.onsuccess = () => res(r.result);
    });
  }, sessionId);
  expect(row.audio).toBeNull();

  // Process with no key: built in code, one item per Annotation and Text Comment, with the typed text.
  expect(
    await serviceWorker.evaluate(async () => (await chrome.storage.local.get('anthropicKey')).anthropicKey ?? ''),
  ).toBe('');
  await expect(review.getByTestId('process-button')).toHaveText('Process without a model');
  await review.getByTestId('process-button').click();
  const cards = review.getByTestId('change-item');
  await expect(cards).toHaveCount(3, { timeout: 20_000 });
  await expect(cards.nth(0).getByTestId('item-title')).toHaveText('Make this roomier');
  await expect(cards.nth(1).getByTestId('item-title')).toHaveText(
    'Change "Ship reviews in minutes" to "Pricing plans"',
  );
  await expect(cards.nth(2).getByTestId('item-title')).toHaveText('Too much empty space here');
  await expect(cards.nth(0).getByTestId('item-location').first()).toContainText('button.cta');

  const { dir } = await exportAndUnzip(review, serviceWorker);
  const md = readFileSync(join(dir, 'review.md'), 'utf8');
  for (const typed of ['Make this roomier', 'Pricing plans', 'Too much empty space here']) expect(md).toContain(typed);
  await test.info().attach('review.md', { body: md, contentType: 'text/markdown' });
});

test.describe('comment-box dictation', () => {
  test.use({ fakeAudio: 'voice-session.wav' });

  /** A numbered line every 1.5 s, spoken over the previous 1.2 s, for the whole test. */
  const script = {
    timestamp_quality: 'approximate' as const,
    cues: Array.from({ length: 60 }, (_, i) => ({
      at_ms: 3000 + 1500 * i,
      duration_ms: 1200,
      text: `line ${i + 1} spoken`,
    })),
  };
  const segments = async (review: Page, sessionId: string) =>
    ofType(await sessionEvents(review, sessionId), 'transcript_segment');
  const muted = (sw: Worker) =>
    sw.evaluate(
      async () =>
        !!((await chrome.storage.session.get('activeSession')).activeSession as { muted?: unknown } | null)?.muted,
    );

  test("auto: speech goes into the open box, not the transcript; push: only while the box's mic is on, even muted", async ({
    context,
    serviceWorker,
    site,
    openExtensionPage,
  }) => {
    test.setTimeout(150_000);
    await useScript(serviceWorker, script);
    await useBoxDictation(serviceWorker, 'auto');
    await grantMic(openExtensionPage);
    const { pricing, sessionId } = await startFromToolbar(context, serviceWorker, site);
    const ext = await openExtensionPage('sessions.html');
    await pricing.bringToFront();
    // The Session transcript runs before any box opens.
    await expect.poll(async () => (await segments(ext, sessionId)).length, { timeout: 20_000 }).toBeGreaterThan(0);

    // auto: the box dictates at once; a live caption shows, then the words land in the text.
    await pickCta(pricing);
    const input = pricing.getByTestId('object-select-input');
    await expect(pricing.getByTestId('object-select-box-mic')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => input.inputValue(), { timeout: 10_000 }).toMatch(/line \d+ spoken/);
    await expect(pricing.getByTestId('object-select-box-caption')).toBeVisible();
    await input.press('Enter');
    await expect(pricing.getByTestId('object-select-box')).toBeHidden();
    await expect
      .poll(async () => ofType(await sessionEvents(ext, sessionId), 'annotation').length, { timeout: 15_000 })
      .toBe(1);
    const [first] = ofType(await sessionEvents(ext, sessionId), 'annotation');
    const dictated = first!.comment!.match(/line \d+ spoken/g)!;
    expect(dictated.length).toBeGreaterThan(0);
    // Those words are the pick's: tagged with it, and in no untagged segment (the transcript) or caption.
    const segs = await segments(ext, sessionId);
    for (const line of dictated) {
      expect(segs.filter((s) => s.text === line).map((s) => s.target)).toEqual([
        { annotation_id: first!.annotation_id },
      ]);
    }

    // After the box closed, speech is the Session's again.
    const spoken = (await segments(ext, sessionId)).filter((s) => !s.target).length;
    await expect
      .poll(async () => (await segments(ext, sessionId)).filter((s) => !s.target).length, { timeout: 10_000 })
      .toBeGreaterThan(spoken);

    // push, muted: the next box takes nothing until its mic button is on; then it works although muted.
    await useBoxDictation(serviceWorker, 'push');
    await pricing.keyboard.press('Escape');
    await expect(pricing.getByTestId('toolbar-object-select')).toHaveAttribute('aria-pressed', 'false');
    await pricing.getByTestId('toolbar-mute').click();
    await expect.poll(() => muted(serviceWorker)).toBe(true);
    // The page reads the setting with the Session state, which the mute just pushed.
    await pickCta(pricing);
    await expect(pricing.getByTestId('object-select-box-mic')).toHaveAttribute('aria-pressed', 'false');
    await pricing.waitForTimeout(3500);
    expect(await input.inputValue()).toBe('');
    await pricing.getByTestId('object-select-box-mic').click();
    await expect(pricing.getByTestId('object-select-box-mic')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => input.inputValue(), { timeout: 10_000 }).toMatch(/line \d+ spoken/);
    await input.press('Enter');
    await expect
      .poll(async () => ofType(await sessionEvents(ext, sessionId), 'annotation').length, { timeout: 15_000 })
      .toBe(2);
    // Closed: muted again, so nothing reaches the transcript.
    expect(await muted(serviceWorker)).toBe(true);
    const before = (await segments(ext, sessionId)).length;
    await pricing.waitForTimeout(4000);
    expect((await segments(ext, sessionId)).slice(before).filter((s) => !s.target)).toEqual([]);
    const events = await sessionEvents(ext, sessionId);
    expect(ofType(events, 'voice_command')).toEqual([]);
    await test.info().attach('events.json', { body: JSON.stringify(events, null, 2), contentType: 'application/json' });
  });
});
