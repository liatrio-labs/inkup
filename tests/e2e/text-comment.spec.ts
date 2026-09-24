// E3/E7 proof: a Text Comment. With Select Text on (Alt+Shift+T, or its toolbar toggle), selecting the fixture heading
// opens the comment box right away; the reviewer types "This should say Pricing plans" and presses Enter. The
// `text_comment` event holds the selection, its text-quote anchor, the heading's selector and a screenshot in which the
// comment box does not appear. Speech said while the text was selected joins it. Process (the Anthropic stub) makes no
// call for an explicit replacement and shows a `copy` Change Item on the selector quoting the old and new text. With
// Select Text off, selecting does nothing special; Draw, Object Select and Select Text are one at a time and Esc turns
// them off. Paired, the comment reaches an agent as a Signal while the Session is live, and the item after Process.
import type { BrowserContext, Page, Worker } from '@playwright/test';
import type { EventOf } from '../../packages/core/src/timeline.ts';
import { type AnthropicStub, startAnthropicStub } from '../support/anthropic-stub';
import { ALLOW_TAB_CAPTURE, expect, grantMic, test, useBoxDictation, useScript } from './fixtures';
import { circle } from './helpers/draw';
import { HostProcess, pairThroughOptions, tempDataDir } from './helpers/host';
import { McpClient } from './helpers/mcp';
import { activeSessionId, ofType, screenshotPixel, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'review-two-notes.wav' });

const SPEECH = 'the headline sells the wrong thing';
type Box = { x: number; y: number; width: number; height: number };

/** A mouse drag across the heading's text, from before its first character to after its last. */
async function dragAcrossHeading(pricing: Page) {
  const ends = await pricing.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('#hero-title')!);
    const rects = [...range.getClientRects()];
    const first = rects[0]!;
    const last = rects.at(-1)!;
    return {
      from: { x: first.left + 1, y: first.top + first.height / 2 },
      to: { x: last.right - 1, y: last.top + last.height / 2 },
    };
  });
  await pricing.mouse.move(ends.from.x, ends.from.y);
  await pricing.mouse.down();
  await pricing.mouse.move(ends.to.x, ends.to.y, { steps: 10 });
  await pricing.mouse.up();
}

/**
 * Selecting the heading with Select Text on: the comment box opens and takes focus. Focusing it takes the page's
 * selection away, so the box, not the selection, says the heading was selected.
 */
async function selectHeading(pricing: Page) {
  await dragAcrossHeading(pricing);
  await expect(pricing.getByTestId('text-comment-box')).toBeVisible();
  await expect(pricing.getByTestId('text-comment-input')).toBeFocused();
}

const selectMode = (sw: Worker) =>
  sw.evaluate(
    async () =>
      ((await chrome.storage.session.get('activeSession')).activeSession as { select_mode?: string | null } | null)
        ?.select_mode ?? null,
  );
const drawMode = (sw: Worker) =>
  sw.evaluate(
    async () =>
      ((await chrome.storage.session.get('activeSession')).activeSession as { draw_mode: boolean } | null)?.draw_mode ??
      false,
  );

/** A mode shortcut on the page, once: the page has the Session by the time anything says Recording (F1). */
async function shortcut(page: Page, sw: Worker, key: string, want: string | null) {
  await page.keyboard.press(key);
  await expect.poll(() => selectMode(sw)).toBe(want);
}

/** Select Text on with its shortcut on the page. */
const selectTextOn = (pricing: Page, sw: Worker) => shortcut(pricing, sw, 'Alt+Shift+KeyT', 'text');

/** Selecting the heading with Select Text off: after a moment, still no comment box. */
async function expectNoBox(pricing: Page) {
  await pricing.evaluate(() => document.getSelection()?.removeAllRanges());
  await dragAcrossHeading(pricing);
  await expect
    .poll(() => pricing.evaluate(() => document.getSelection()?.toString().trim()))
    .toBe('Ship reviews in minutes');
  await pricing.waitForTimeout(500);
  await expect(pricing.getByTestId('text-comment-box')).toBeHidden();
  await pricing.evaluate(() => document.getSelection()?.removeAllRanges());
}

/** Starts from the panel with drawing off, a scripted transcript that speaks at 7 s, and returns the pages. */
async function record(
  context: BrowserContext,
  sw: Worker,
  site: { primaryOrigin: string },
  openExtensionPage: (p: string) => Promise<Page>,
) {
  await useScript(sw, { timestamp_quality: 'approximate', cues: [{ at_ms: 7000, duration_ms: 1500, text: SPEECH }] });
  // The speech is meant for the Session transcript while the box is open, so the box does not take it (E11).
  await useBoxDictation(sw, 'push');
  await grantMic(openExtensionPage);
  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  const panel = await openExtensionPage('sidepanel.html');
  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  const sessionId = (await activeSessionId(sw))!;
  await pricing.bringToFront();
  return { pricing, panel, sessionId };
}

/**
 * With Select Text on, selects the heading (the box opens at once), says the scripted line while the text is selected,
 * and saves. Returns where the box was on screen.
 */
async function comment(pricing: Page, panel: Page, text: string): Promise<{ box: Box }> {
  await selectHeading(pricing);
  const box = pricing.getByTestId('text-comment-box');
  await pricing.getByTestId('text-comment-input').pressSequentially(text);
  // The scripted speech lands while the text is selected (the box is open).
  await expect(panel.getByTestId('captions')).toContainText(SPEECH, { timeout: 20_000 });
  const boxBox = (await box.boundingBox())!;
  await pricing.getByTestId('text-comment-input').press('Enter');
  await expect(box).toBeHidden();
  return { box: boxBox };
}

const isUiDark = ([r, g, b]: [number, number, number]) => r < 60 && g < 60 && b < 60;

/** The share of a grid of points inside `rect` that are the box's dark background in the screenshot. */
async function darkShare(review: Page, shot: EventOf<'screenshot'>, rect: Box): Promise<number> {
  let dark = 0;
  let n = 0;
  for (const fx of [0.15, 0.35, 0.5, 0.65, 0.85]) {
    for (const fy of [0.25, 0.5, 0.75]) {
      const px = (await screenshotPixel(
        review,
        shot.screenshot_id,
        (rect.x + rect.width * fx) * shot.dpr,
        (rect.y + rect.height * fy) * shot.dpr,
      ))!;
      if (isUiDark(px)) dark++;
      n++;
    }
  }
  return dark / n;
}

async function expectComment(review: Page, sessionId: string, at: { box: Box }) {
  const events = await sessionEvents(review, sessionId);
  const [c] = ofType(events, 'text_comment');
  expect(c).toMatchObject({
    index: 1,
    selected_text: 'Ship reviews in minutes',
    comment: 'This should say Pricing plans',
    anchor: {
      exact: 'Ship reviews in minutes',
      prefix: '',
      suffix: expect.stringMatching(/^ ?Simple pricing for teams/),
    },
    element: { selector: '#hero-title', tag: 'h1', role: 'heading', name: 'Ship reviews in minutes' },
  });
  expect(c!.t_end).toBeGreaterThan(c!.t);
  // Its screenshot does not show the comment box.
  const shot = ofType(events, 'screenshot').find((s) => s.screenshot_id === c!.screenshot_id)!;
  expect(shot, 'the Text Comment has its own screenshot').toMatchObject({ trigger: 'text_comment' });
  expect(await darkShare(review, shot, at.box), 'the comment box is not in the screenshot').toBeLessThan(0.4);
  // The speech said while the text was selected falls inside the comment's span.
  const said = ofType(events, 'transcript_segment').find((s) => s.text === SPEECH)!;
  expect(said.t).toBeGreaterThanOrEqual(c!.t);
  expect(said.t).toBeLessThanOrEqual(c!.t_end);
  return c!;
}

async function stopAndProcess(context: BrowserContext, sw: Worker, panel: Page, stub: AnthropicStub) {
  await sw.evaluate(async (base) => {
    const { devOverrides } = await chrome.storage.local.get('devOverrides');
    await chrome.storage.local.set({
      anthropicKey: 'sk-ant-e2e-text-comment',
      devOverrides: { ...(devOverrides ?? {}), anthropicBaseUrl: base },
    });
  }, stub.baseURL);
  const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await panel.getByTestId('stop').click();
  const review = await reviewPromise;
  await review.getByTestId('process-button').click();
  await review.getByTestId('process-confirm').click();
  const card = review.getByTestId('change-item');
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await expect(card.getByTestId('item-category')).toHaveText('copy');
  await expect(card.getByTestId('item-title')).toHaveText('Change "Ship reviews in minutes" to "Pricing plans"');
  await expect(card.getByTestId('item-location').first()).toHaveAttribute('data-role', 'subject');
  await expect(card.getByTestId('item-location').first()).toContainText('#hero-title');
  await expect(card.getByTestId('check-me')).toHaveCount(0);
  // An explicit replacement is built in code: the stub saw no Process call at all.
  expect(stub.requests.filter((r) => r.path.startsWith('/v1/messages'))).toEqual([]);
  return review;
}

test('standalone: select the heading, comment "This should say Pricing plans", Process makes a copy item on its selector', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(150_000);
  const stub = await startAnthropicStub({
    onMessage: () => ({
      status: 500,
      body: { type: 'error', error: { type: 'api_error', message: 'stub: no call expected' } },
    }),
  });
  try {
    const { pricing, panel, sessionId } = await record(context, serviceWorker, site, openExtensionPage);

    await selectTextOn(pricing, serviceWorker);
    const at = await comment(pricing, panel, 'This should say Pricing plans');
    await expect
      .poll(async () => ofType(await sessionEvents(panel, sessionId), 'text_comment').length, { timeout: 15_000 })
      .toBe(1);
    const review = await stopAndProcess(context, serviceWorker, panel, stub);
    await expectComment(review, sessionId, at);
    // The speech joined the comment in the item's words.
    await expect(review.getByTestId('change-item')).toContainText(`“This should say Pricing plans ... ${SPEECH}”`);
  } finally {
    await stub.close();
  }
});

test('Select Text off: selecting does nothing; on: the box opens; Draw turns it off; Esc cancels the comment and turns modes off', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  const { pricing, panel, sessionId } = await record(context, serviceWorker, site, openExtensionPage);
  // Off (the default): a selection is just a selection.
  await expectNoBox(pricing);

  // On: the box opens right away. Esc in it cancels: nothing is recorded, and Select Text stays on.
  await selectTextOn(pricing, serviceWorker);
  await selectHeading(pricing);
  await expect(pricing.getByTestId('text-comment-box')).toBeVisible();
  await pricing.getByTestId('text-comment-input').pressSequentially('never mind');
  await pricing.getByTestId('text-comment-input').press('Escape');
  await expect(pricing.getByTestId('text-comment-box')).toBeHidden();
  expect(await selectMode(serviceWorker)).toBe('text');

  // Draw on turns Select Text off; the page takes Strokes.
  await panel.getByTestId('draw-toggle').click();
  await expect.poll(() => selectMode(serviceWorker)).toBe(null);
  await pricing.bringToFront();
  await circle(pricing, (await pricing.locator('button.cta').boundingBox())!);
  await expect(panel.getByTestId('annotation-count')).toHaveText('1', { timeout: 10_000 });
  // Select Text on turns Draw off.
  await selectTextOn(pricing, serviceWorker);
  expect(await drawMode(serviceWorker)).toBe(false);
  // Esc on the page turns every mode off: selecting does nothing again.
  await pricing.keyboard.press('Escape');
  await expect.poll(() => selectMode(serviceWorker)).toBe(null);
  await expectNoBox(pricing);
  expect(ofType(await sessionEvents(panel, sessionId), 'text_comment')).toHaveLength(0);
});

test.describe('from the toolbar', () => {
  test.use({ extraArgs: [ALLOW_TAB_CAPTURE] });

  test('Select Text is a toolbar toggle; Object Select and Select Text are one at a time; Esc turns both off', async ({
    context,
    serviceWorker,
    site,
    openExtensionPage,
  }) => {
    test.setTimeout(90_000);
    await grantMic(openExtensionPage);
    const pricing = await context.newPage();
    await pricing.goto(`${site.primaryOrigin}/pricing.html`);
    await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: '*://*/pricing.html' });
      (chrome.action.onClicked as unknown as { dispatch(tab: chrome.tabs.Tab): void }).dispatch(tab!);
    });
    await pricing.getByTestId('toolbar-start').click();
    await expect(pricing.getByTestId('toolbar')).toHaveAttribute('data-state', 'recording');
    const text = pricing.getByTestId('toolbar-select-text');
    const objects = pricing.getByTestId('toolbar-object-select');
    await expect(text).toHaveAccessibleName('Select Text');
    await expectNoBox(pricing);

    await text.click();
    await expect(text).toHaveAttribute('aria-pressed', 'true');
    await selectHeading(pricing);
    const box = pricing.getByTestId('text-comment-box');
    await expect(box).toBeVisible();
    // Object Select on: Select Text goes off and its open box is cancelled.
    await objects.click();
    await expect(objects).toHaveAttribute('aria-pressed', 'true');
    await expect(text).toHaveAttribute('aria-pressed', 'false');
    await expect(box).toBeHidden();
    await text.click();
    await expect(text).toHaveAttribute('aria-pressed', 'true');
    await expect(objects).toHaveAttribute('aria-pressed', 'false');
    await pricing.keyboard.press('Escape');
    await expect(text).toHaveAttribute('aria-pressed', 'false');
    await expect(pricing.getByTestId('toolbar-draw')).toHaveAttribute('aria-pressed', 'false');
  });
});

test('paired: the Text Comment reaches an agent as a Signal while live, then as the copy item', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(150_000);
  const stub = await startAnthropicStub({
    onMessage: () => ({
      status: 500,
      body: { type: 'error', error: { type: 'api_error', message: 'stub: no call expected' } },
    }),
  });
  const data = tempDataDir();
  const host = await HostProcess.start(data.dir);
  try {
    const { token } = await pairThroughOptions(serviceWorker, openExtensionPage, host);
    const { pricing, panel, sessionId } = await record(context, serviceWorker, site, openExtensionPage);
    await selectTextOn(pricing, serviceWorker);
    const at = await comment(pricing, panel, 'This should say Pricing plans');

    const agent = await McpClient.connect(host.url);
    type Signal = {
      kind: string;
      number: number;
      selector: string;
      intent: string;
      title: string;
      screenshot: string;
      transcript: string;
    };
    await expect
      .poll(
        async () =>
          (await agent.json<{ signals: Signal[] }>('read_items', { url: site.primaryOrigin })).signals.filter(
            (s) => s.kind === 'text_comment',
          ),
        { timeout: 15_000 },
      )
      .toEqual([
        expect.objectContaining({
          number: 1,
          selector: '#hero-title',
          title: 'Comment on "Ship reviews in minutes"',
          intent: 'This should say Pricing plans',
          transcript: SPEECH,
          screenshot: expect.any(String),
        }),
      ]);

    const review = await stopAndProcess(context, serviceWorker, panel, stub);
    await expectComment(review, sessionId, at);
    type AgentItem = { title: string; category: string; locations: { selector: string }[] };
    await expect
      .poll(async () => (await host.get<unknown[]>(`/api/items?session_id=${sessionId}`, token)).length, {
        timeout: 15_000,
      })
      .toBe(1);
    const open = await agent.json<{ items: AgentItem[]; signals: unknown[] }>('read_items', {
      url: site.primaryOrigin,
    });
    expect(open.signals).toEqual([]);
    expect(open.items).toEqual([
      expect.objectContaining({
        title: 'Change "Ship reviews in minutes" to "Pricing plans"',
        category: 'copy',
        locations: [expect.objectContaining({ selector: '#hero-title' })],
      }),
    ]);
  } finally {
    await host.kill();
    data.remove();
    await stub.close();
  }
});
