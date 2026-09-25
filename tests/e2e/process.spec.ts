// Slice 2 proof (docs/PLAN.md): capture a real Session, then Process it from the review page through the real
// service worker and Anthropic adapter, pointed at a local stub of the Anthropic API (the dev-only
// `anthropicBaseUrl` override). No real key or network call is involved.
import { readFileSync } from 'node:fs';
import type { Page, Worker } from '@playwright/test';
import { SessionDocumentSchema } from '../../packages/core/src/session-document.ts';
import { buildLongSession } from '../../scripts/gen-long-session.ts';
import {
  type AnthropicStub,
  DEFAULT_STUB_MODELS,
  errorReply,
  isVetRequest,
  messageReply,
  scriptOf,
  startAnthropicStub,
} from '../support/anthropic-stub';
import { scriptModel } from '../support/script-model';
import { expect, grantMic, test, useScriptedTranscript } from './fixtures';
import { circle } from './helpers/draw';
import { seedSession } from './helpers/seed';

test.use({ fakeAudio: 'review-two-notes.wav' });

const MODEL = 'claude-sonnet-5';
const FIRST_PASS_AMBIGUITY = 'First pass: "the header" could mean the nav links or the logo side.';
const VETTED_AMBIGUITY = 'Vetted: the screenshot shows no mark in the header, so the exact spot is unclear.';

/** A fixed, valid payload whose selectors match the captured Session (button.cta, Annotation #1, its screenshot). */
function items(shot: string) {
  const moveItem = {
    id: 'item_0001',
    title: "Move the 'Get started' button into the header",
    category: 'layout',
    intent: 'The primary CTA should sit in the site header instead of the hero card.',
    locations: [
      {
        role: 'subject',
        selector: 'button.cta',
        element: "button 'Get started'",
        url: '/pricing.html',
        screenshot: shot,
        annotation: 1,
      },
      {
        role: 'destination',
        selector: 'header.site-header',
        element: 'site header',
        url: '/pricing.html',
        screenshot: null,
        annotation: null,
      },
    ],
    evidence: { video: { start: 2.5, end: 4.3 }, screenshots: [shot] },
    transcript: 'this button should go in the header',
    confidence: 0.88,
    agent_prompt: `On /pricing.html move the 'Get started' button (button.cta) out of the hero card into header.site-header. See screenshots/${shot}.png for the circled button.`,
    pinned: false,
  };
  const unsure = {
    ...moveItem,
    id: 'item_0002',
    title: 'Check where in the header the button goes',
    category: 'question',
    intent: 'The reviewer did not mark a spot in the header.',
    confidence: 0.42,
    ambiguity: FIRST_PASS_AMBIGUITY,
    agent_prompt: `Ask where in header.site-header the button should go. See screenshots/${shot}.png.`,
  };
  return { moveItem, unsure };
}

async function setDevOverrides(sw: Worker, extra: Record<string, unknown>) {
  await sw.evaluate(async (more) => {
    const { devOverrides } = await chrome.storage.local.get('devOverrides');
    await chrome.storage.local.set({ devOverrides: { ...(devOverrides ?? {}), ...more } });
  }, extra);
}

async function downloadSessionJson(review: Page, sw: Worker) {
  await review.getByTestId('download-session').click();
  await expect(review.getByRole('status').filter({ hasText: 'Downloading session.json' })).toBeVisible();
  const id = Number(await review.evaluate(() => document.body.dataset.downloadId));
  await expect
    .poll(() => sw.evaluate(async (i) => (await chrome.downloads.search({ id: i }))[0]?.state, id))
    .toBe('complete');
  const file = await sw.evaluate(async (i) => (await chrome.downloads.search({ id: i }))[0]!.filename, id);
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('Process: estimate, confirm, Change Items with badges, overlay and agent prompt; failures keep the Session', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  let fail = true;
  const stub: AnthropicStub = await startAnthropicStub({
    inputTokens: () => 4321,
    onMessage: (req) => {
      if (fail) return errorReply(400, 'invalid_request_error', 'stub: simulated failure');
      if (req.body.max_tokens === 1) return messageReply(req.body.model, 'OK', { input_tokens: 12, output_tokens: 1 });
      const shot = /screenshot (s\d+)/.exec(scriptOf(req))?.[1] ?? 's1';
      const { moveItem, unsure } = items(shot);
      // Vetting: the move is confirmed on the screenshot; the unsure item is corrected.
      if (isVetRequest(req))
        return messageReply(
          MODEL,
          JSON.stringify({
            results: [
              { id: 'item_0001', verdict: 'confirmed', reason: 'The circle is on the button.' },
              {
                id: 'item_0002',
                verdict: 'corrected',
                reason: 'No spot in the header is marked.',
                item: { ...unsure, confidence: 0.5, ambiguity: VETTED_AMBIGUITY },
              },
            ],
          }),
        );
      return messageReply(MODEL, JSON.stringify({ items: [moveItem, unsure] }));
    },
  });
  try {
    await useScriptedTranscript(serviceWorker, 'pricing-cta.json');
    await setDevOverrides(serviceWorker, { anthropicBaseUrl: stub.baseURL });
    await grantMic(openExtensionPage);

    // Capture: circle the CTA while the scripted transcript says "this button should go in the header".
    const pricing = await context.newPage();
    await pricing.goto(`${site.primaryOrigin}/pricing.html`);
    const panel = await openExtensionPage('sidepanel.html');
    await panel.getByTestId('start').click();
    await expect(panel.getByTestId('status')).toHaveText('Recording');
    await panel.getByTestId('draw-toggle').click();
    await pricing.bringToFront();
    await circle(pricing, (await pricing.locator('button.cta').boundingBox())!);
    await expect(panel.getByTestId('annotation-count')).toHaveText('1', { timeout: 10_000 });
    await expect(panel.getByTestId('captions')).toContainText('this button should go in the header', {
      timeout: 10_000,
    });
    const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
    await panel.getByTestId('stop').click();
    const review = await reviewPromise;
    await expect(review.getByTestId('annotation')).toHaveCount(1);

    // No key: Process builds the items in code (E11) and the page links to the options page for a key.
    await expect(review.getByTestId('process-button')).toHaveText('Process without a model');
    await expect(review.getByTestId('open-options')).toHaveAttribute('href', '/options.html');

    // Options: saving a key shows the Anthropic notice once.
    const options = await openExtensionPage('options.html');
    await expect(options.getByTestId('process-model')).toHaveValue(MODEL);
    await expect(options.getByTestId('draft-model')).toHaveValue('claude-haiku-4-5-20251001');
    await options.getByTestId('anthropic-key').fill('sk-ant-e2e-stub-key');
    await options.getByTestId('save-processing').click();
    await expect(options.getByTestId('anthropic-notice')).toContainText(
      'to check the Change Items against them (you can turn that off below)',
    );
    await expect(options.getByTestId('vet-items')).toBeChecked();
    await options.reload();
    await options.getByTestId('anthropic-key').fill('sk-ant-e2e-stub-key-2');
    await options.getByTestId('save-processing').click();
    await expect(options.getByRole('status')).toHaveText('Saved.');
    await expect(options.getByTestId('anthropic-notice')).toHaveCount(0);
    // Test makes a free count_tokens call and a 1-token message; the stub is failing messages for now.
    await options.getByTestId('test-anthropic').click();
    await expect(options.getByTestId('test-result')).toContainText('Error: Anthropic API error 400');
    fail = false;
    await options.getByTestId('test-anthropic').click();
    await expect(options.getByTestId('test-result')).toHaveText(
      'OK: Key works with claude-sonnet-5 and claude-haiku-4-5-20251001.',
    );
    fail = true;
    // The key is in storage.local, never storage.sync.
    expect(
      await serviceWorker.evaluate(async () => [
        (await chrome.storage.local.get('anthropicKey')).anthropicKey,
        await chrome.storage.sync.get(null),
      ]),
    ).toEqual(['sk-ant-e2e-stub-key-2', {}]);
    await options.close();

    // A failing Process leaves the Session intact and offers Retry.
    await review.bringToFront();
    await expect(review.getByTestId('process-button')).toBeEnabled();
    await review.getByTestId('process-button').click();
    // Process and the check against the recording: the counted input twice.
    await expect(review.getByTestId('process-estimate')).toContainText('8,642');
    await expect(review.getByTestId('process-estimate')).toContainText('includes checking every item');
    await review.getByTestId('process-confirm').click();
    await expect(review.getByTestId('process-error')).toContainText('stub: simulated failure');
    await expect(review.getByTestId('annotation')).toHaveCount(1);
    await expect(review.getByTestId('transcript')).toContainText('this button should go in the header');
    await expect(review.getByTestId('change-item')).toHaveCount(0);

    // Retry succeeds.
    fail = false;
    const before = stub.messages().length;
    const countsBefore = stub.requests.filter((r) => r.path === '/v1/messages/count_tokens').length;
    await review.getByTestId('process-retry').click();
    await expect(review.getByTestId('process-estimate')).toContainText(`with ${MODEL}`);
    await expect(review.getByTestId('process-estimate')).toContainText('$');
    await review.getByTestId('process-confirm').click();
    await expect(review.getByTestId('change-item')).toHaveCount(2, { timeout: 20_000 });

    // The request carried the section 7 script, and the vetting call carried the items with their screenshot.
    const sent = stub.messages().slice(before);
    expect(sent).toHaveLength(2);
    const script = scriptOf(sent[0]!);
    // A single window: the Annotations to account for, then the header; no WINDOW line. The scripted speech is
    // approximate; it is VAD-aligned when the detector heard the fixture audio by Stop (it may not, on a slow runner).
    expect(script).toMatch(
      /^ANNOTATIONS TO ACCOUNT FOR: #1\. [^\n]*\nTIMESTAMP QUALITY: approximate(, VAD-aligned\nPAIRING WINDOW: 2\.5s|\nPAIRING WINDOW: 4s)\n/,
    );
    expect(script).not.toMatch(/^WINDOW /m);
    expect(script).toMatch(
      /ANNOTATION #1 .* screenshot s1 · closed by [a-z ]+\n {4}c0 button\.cta · <button role=button class="cta"> "Get started" · PICK/,
    );
    expect(script).toMatch(
      /SPEECH "this button should go in the header" .* demonstratives: "this" near #1 · nouns: button, header/,
    );
    expect(sent[0]!.body).toMatchObject({ model: MODEL, output_config: { format: { type: 'json_schema' } } });
    expect(sent[0]!.headers['x-api-key']).toBe('sk-ant-e2e-stub-key-2');
    expect(isVetRequest(sent[1]!)).toBe(true);
    const vetContent = sent[1]!.body.messages[0].content;
    expect(vetContent.at(-1).text).toContain('"id": "item_0002"');
    const image = vetContent.find((b: { type: string }) => b.type === 'image');
    expect(image.source.media_type).toBe('image/png');
    expect(Buffer.from(image.source.data, 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(stub.requests.filter((r) => r.path === '/v1/messages/count_tokens').length - countsBefore).toBe(1);

    // Low confidence sorts first with its badge and the corrected ambiguity; no raw scores. Each card says how the
    // check against the recording went.
    const cards = review.getByTestId('change-item');
    await expect(cards.nth(0)).toHaveAttribute('data-item-id', 'item_0002');
    await expect(cards.nth(0).getByTestId('check-me')).toHaveText('check me');
    await expect(cards.nth(0).getByTestId('ambiguity')).toHaveText(VETTED_AMBIGUITY);
    await expect(cards.nth(0).getByTestId('vetting')).toHaveAttribute('data-verdict', 'corrected');
    await expect(cards.nth(0).getByTestId('vetting')).toHaveText('Corrected: No spot in the header is marked.');
    await expect(cards.nth(1).getByTestId('vetting')).toHaveAttribute('data-verdict', 'confirmed');
    await expect(cards.nth(1).getByTestId('vetting')).toHaveText('Checked');
    await expect(cards.nth(1)).toHaveAttribute('data-item-id', 'item_0001');
    await expect(cards.nth(1).getByTestId('check-me')).toHaveCount(0);
    await expect(review.getByTestId('change-items')).not.toContainText('0.88');
    await expect(review.getByTestId('change-items')).not.toContainText('0.5');

    const move = cards.nth(1);
    await expect(move.getByTestId('item-title')).toHaveText("Move the 'Get started' button into the header");
    await expect(move.getByTestId('item-category')).toHaveText('layout');
    await expect(move.getByTestId('item-location').nth(0)).toHaveAttribute('data-role', 'subject');
    await expect(move.getByTestId('item-location').nth(0)).toContainText('button.cta');
    await expect(move.getByTestId('item-location').nth(1)).toHaveAttribute('data-role', 'destination');

    // Each Location with a screenshot shows it inside the card, right under its row, with the cited Annotation's
    // Stroke overlaid as SVG in the screenshot's viewport coordinates. The destination has no screenshot and no
    // Annotation, so it shows none. The right pane holds only the recording.
    await move.getByTestId('item-title').click();
    await expect(move).toHaveAttribute('data-selected', 'true');
    const shotFigure = move.getByTestId('item-location').nth(0).getByTestId('evidence-shot');
    await expect(shotFigure.locator('img')).toBeVisible();
    await expect(move.getByTestId('item-location').nth(1).getByTestId('evidence-shot')).toHaveCount(0);
    await expect(review.getByRole('complementary', { name: 'Recording' }).getByTestId('evidence-shot')).toHaveCount(0);
    for (const card of await cards.all()) {
      for (const loc of await card.getByTestId('item-location').all()) {
        const role = await loc.getAttribute('data-role');
        if (role === 'subject') await expect(loc.getByTestId('evidence-shot')).toHaveCount(1);
      }
    }
    const overlay = shotFigure.getByTestId('stroke-overlay');
    const d = await overlay.locator('path').first().getAttribute('d');
    expect(d).toMatch(/^M[\d.]+ [\d.]+ Q/);
    const cta = await pricing.locator('button.cta').boundingBox();
    const viewBox = await overlay.getAttribute('viewBox');
    expect(viewBox).toBe(`0 0 ${pricing.viewportSize()!.width} ${pricing.viewportSize()!.height}`);
    // The outline surrounds the CTA: its path's x range spans the button.
    const xs = [...d!.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeLessThan(cta!.x);
    expect(Math.max(...xs)).toBeGreaterThan(cta!.x + cta!.width);
    // Click to enlarge: a dialog with the same screenshot and Strokes, larger; Escape closes it.
    const small = (await shotFigure.boundingBox())!.width;
    await move.getByTestId('item-location').nth(0).getByTestId('location-shot-open').click();
    const dialog = review.getByTestId('location-shot-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading')).toHaveText("Subject: button 'Get started'");
    const large = dialog.getByTestId('evidence-shot-large');
    await expect(large.locator('img')).toBeVisible();
    expect(await large.getByTestId('stroke-overlay').locator('path').first().getAttribute('d')).toBe(d);
    expect((await large.boundingBox())!.width).toBeGreaterThan(small);
    await review.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Copy agent prompt: cites the screenshot by its export path.
    const shotId = await shotFigure.getAttribute('data-screenshot-id');
    // Playwright cannot grant clipboard permissions to chrome-extension:// origins, so record what the page writes.
    await review.evaluate(() => {
      const real = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async (text: string) => {
        document.body.dataset.copied = text;
        return real(text);
      };
    });
    await review.bringToFront();
    await move.getByTestId('copy-prompt').click();
    await expect(move.getByTestId('copy-prompt')).toHaveText('Copied');
    const clip = (await review.evaluate(() => document.body.dataset.copied)) ?? '';
    expect(clip).toContain(`screenshots/${shotId}.png`);
    expect(clip).toContain('button.cta');

    // session.json now includes the Change Items, with stored screenshot ids.
    const doc = SessionDocumentSchema.parse(await downloadSessionJson(review, serviceWorker));
    // change_items are in review order (unsure first), as the review page shows them.
    expect(doc.change_items?.map((i) => i.id)).toEqual(['item_0002', 'item_0001']);
    expect(doc.change_items![1]!.evidence.screenshots).toEqual([shotId]);
    expect(JSON.stringify(doc)).not.toContain('sk-ant-');
  } finally {
    await stub.close();
  }
});

/** A short seeded Session (one Process call) on the review page, with a key and the stub; nothing recorded. */
async function openShortSession(
  serviceWorker: Worker,
  openExtensionPage: (path: string) => Promise<Page>,
  stub: AnthropicStub,
  autoRunBelowUsd?: number,
) {
  await serviceWorker.evaluate(
    async ({ base, autoRunBelowUsd }) => {
      const { devOverrides } = await chrome.storage.local.get('devOverrides');
      await chrome.storage.local.set({
        anthropicKey: 'sk-ant-e2e-stub-key',
        anthropicNoticeShown: true,
        devOverrides: { ...(devOverrides ?? {}), anthropicBaseUrl: base },
        processingSettings: autoRunBelowUsd === undefined ? {} : { autoRunBelowUsd },
      });
    },
    { base: stub.baseURL, autoRunBelowUsd },
  );
  const { doc } = buildLongSession({ minutes: 3 });
  const blank = await openExtensionPage('sessions.html');
  await expect
    .poll(() => blank.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === 'inkup')))
    .toBe(true);
  await seedSession(blank, doc);
  await blank.close();
  const review = await openExtensionPage(`review.html?session=${doc.session.id}`);
  await expect(review.getByTestId('annotation').first()).toBeVisible();
  return review;
}

const scriptedStub = (more: Omit<Parameters<typeof startAnthropicStub>[0], 'onMessage'> = {}) =>
  startAnthropicStub({ ...more, onMessage: (req) => messageReply(MODEL, JSON.stringify(scriptModel(scriptOf(req)))) });

test('Process runs without asking under the options threshold, and still asks to Process again', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  test.setTimeout(90_000);
  const stub = await scriptedStub();
  try {
    const review = await openShortSession(serviceWorker, openExtensionPage, stub);

    // The threshold is set on the options page and saved with the rest of Processing.
    const options = await openExtensionPage('options.html');
    await expect(options.getByTestId('auto-run-below')).toHaveValue('');
    await options.getByTestId('auto-run-below').fill('0.50');
    await options.getByTestId('save-processing').click();
    await expect(options.getByRole('status')).toHaveText('Saved.');
    expect(
      await serviceWorker.evaluate(
        async () =>
          ((await chrome.storage.local.get('processingSettings')).processingSettings as { autoRunBelowUsd?: number })
            .autoRunBelowUsd,
      ),
    ).toBe(0.5);
    await options.reload();
    await expect(options.getByTestId('auto-run-below')).toHaveValue('0.5');
    await options.close();

    // ~$0.04 is under $0.50: one click runs it, with no confirm step.
    await review.bringToFront();
    await review.getByTestId('process-button').click();
    await expect(review.getByTestId('process-auto-ran')).toContainText('under your $0.50 limit: process');
    await expect(review.getByTestId('process-estimate')).toHaveCount(0);
    await expect(review.getByTestId('change-item').first()).toBeVisible({ timeout: 30_000 });
    await expect(review.getByTestId('process-auto-ran')).toHaveText(
      /^Estimated \$0\.0\d{3}, under your \$0\.50 limit: processed without asking\.$/,
    );
    expect(stub.messages().length).toBeGreaterThan(0);

    // Process again replaces the items and their edits: it asks, even under the threshold.
    await expect(review.getByTestId('process-button')).toHaveText('Process again');
    const sent = stub.messages().length;
    await review.getByTestId('process-button').click();
    await expect(review.getByTestId('process-estimate')).toContainText('replaces the items below');
    await expect(review.getByTestId('process-confirm')).toBeVisible();
    expect(stub.messages().length).toBe(sent);
  } finally {
    await stub.close();
  }
});

test('Process asks when the estimate is over the threshold', async ({ serviceWorker, openExtensionPage }) => {
  const stub = await scriptedStub();
  try {
    const review = await openShortSession(serviceWorker, openExtensionPage, stub, 0.01);
    await review.getByTestId('process-button').click();
    await expect(review.getByTestId('process-confirm')).toBeVisible();
    await expect(review.getByTestId('process-auto-ran')).toHaveCount(0);
    await expect(review.getByTestId('process-limit-warning')).toHaveCount(0);
    expect(stub.messages()).toHaveLength(0);
  } finally {
    await stub.close();
  }
});

test("a call near the model's context window warns, and the warning stops the auto-run", async ({
  serviceWorker,
  openExtensionPage,
}) => {
  // The listed context window is 200,000 and the call counts 190,000 (95%); ~$0.40 is under the $5 threshold.
  const stub = await scriptedStub({
    inputTokens: () => 190_000,
    models: {
      ...DEFAULT_STUB_MODELS,
      anthropic: DEFAULT_STUB_MODELS.anthropic.map((m) => (m.id === MODEL ? { ...m, max_input_tokens: 200_000 } : m)),
    },
  });
  try {
    const review = await openShortSession(serviceWorker, openExtensionPage, stub, 5);
    // The options page fetches and caches the model list, which gives the window.
    const options = await openExtensionPage('options.html');
    await expect
      .poll(() =>
        serviceWorker.evaluate(
          async (id) =>
            (
              (await chrome.storage.local.get('modelLists')).modelLists as
                | { anthropic?: { models: { id: string; context_window: number | null }[] } }
                | undefined
            )?.anthropic?.models.find((m) => m.id === id)?.context_window ?? null,
          MODEL,
        ),
      )
      .toBe(200_000);
    await options.close();

    await review.bringToFront();
    await review.getByTestId('process-button').click();
    await expect(review.getByTestId('process-limit-warning')).toHaveText(
      `This run is about 190,000 input tokens, 95% of ${MODEL}'s 200,000-token context window. It may be refused or cut short.`,
    );
    await expect(review.getByTestId('process-confirm')).toBeVisible();
    await expect(review.getByTestId('process-auto-ran')).toHaveCount(0);
    expect(stub.messages()).toHaveLength(0);
  } finally {
    await stub.close();
  }
});
