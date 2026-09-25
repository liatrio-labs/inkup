// Processing providers, model lists and effort (PR C): each model role picks Anthropic or the Vercel AI Gateway, a
// model from that provider's live list and an effort. One local stub stands in for both APIs (the dev-only
// `anthropicBaseUrl` and `gatewayBaseUrl` overrides): GET /v1/models answers in each provider's shape, and every
// /v1/messages request is recorded with its headers, so the test sees which key and effort each call carried.
import type { Page, Worker } from '@playwright/test';
import { buildLongSession } from '../../scripts/gen-long-session.ts';
import { type AnthropicStub, messageReply, scriptOf, startAnthropicStub } from '../support/anthropic-stub';
import { scriptModel } from '../support/script-model';
import { expect, test } from './fixtures';
import { seedSession } from './helpers/seed';

const ANTHROPIC_KEY = 'sk-ant-e2e-gateway-spec';
const GATEWAY_KEY = 'vck-e2e-gateway-spec';

async function pointAtStub(sw: Worker, stub: AnthropicStub) {
  await sw.evaluate(async (base) => {
    const { devOverrides } = await chrome.storage.local.get('devOverrides');
    await chrome.storage.local.set({
      devOverrides: { ...(devOverrides ?? {}), anthropicBaseUrl: base, gatewayBaseUrl: base },
    });
  }, stub.baseURL);
}

const optionTexts = (select: ReturnType<Page['getByTestId']>) =>
  select.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));

test('options: model selects list each provider, the Gateway key goes with Gateway roles, effort only when set', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  test.setTimeout(90_000);
  const stub = await startAnthropicStub({
    onMessage: (req) =>
      req.body.max_tokens === 1
        ? messageReply(req.body.model, 'OK', { input_tokens: 10, output_tokens: 1 })
        : messageReply(req.body.model, JSON.stringify(scriptModel(scriptOf(req)))),
  });
  try {
    await pointAtStub(serviceWorker, stub);
    const options = await openExtensionPage('options.html');
    await expect(options.getByRole('heading', { name: 'Processing' })).toBeVisible();

    // No key: the model fields are text inputs, and nothing asked for a list.
    await expect(options.getByTestId('process-model')).toHaveJSProperty('tagName', 'INPUT');
    await expect(options.getByTestId('process-model')).toHaveValue('claude-sonnet-5');
    expect(stub.requests).toHaveLength(0);

    // Both keys saved: a notice for each vendor, and each provider's list fills the selects.
    await options.getByTestId('anthropic-key').fill(ANTHROPIC_KEY);
    await options.getByTestId('gateway-key').fill(GATEWAY_KEY);
    await options.getByTestId('save-processing').click();
    await expect(options.getByTestId('anthropic-notice')).toBeVisible();
    await expect(options.getByTestId('gateway-notice')).toContainText('What goes to Vercel');
    const processModel = options.getByTestId('process-model');
    await expect(processModel).toHaveJSProperty('tagName', 'SELECT');
    await expect(processModel).toHaveValue('claude-sonnet-5');
    expect(await optionTexts(processModel)).toEqual([
      'claude-sonnet-5',
      'claude-opus-5-5',
      'claude-haiku-4-5-20251001',
    ]);
    const lists = stub.requests.filter((r) => r.path === '/v1/models');
    expect(lists.find((r) => r.headers['anthropic-version'])?.headers['x-api-key']).toBe(ANTHROPIC_KEY);
    expect(lists.find((r) => !r.headers['anthropic-version'])?.headers.authorization).toBe(`Bearer ${GATEWAY_KEY}`);

    // Process on the Gateway at high effort: its list, grouped by maker, without the embedding model.
    await options.getByTestId('process-provider').selectOption('gateway');
    await expect(processModel).toHaveValue('anthropic/claude-sonnet-5');
    expect(await optionTexts(processModel)).toEqual([
      'anthropic/claude-sonnet-5',
      'anthropic/claude-haiku-4.5',
      'google/gemini-3.1-pro-preview',
    ]);
    await expect(processModel.locator('optgroup')).toHaveCount(2);
    await options.getByTestId('process-effort').selectOption('high');
    await options.getByTestId('save-processing').click();
    await expect(options.getByRole('status')).toHaveText('Saved.');
    expect(
      await serviceWorker.evaluate(
        async () => (await chrome.storage.local.get('processingSettings')).processingSettings,
      ),
    ).toEqual({
      process: { provider: 'gateway', model: 'anthropic/claude-sonnet-5', effort: 'high' },
      draft: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      merge: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    });

    // Each Test button sits by its key and checks the models set to that provider, with that key.
    await options.getByTestId('test-gateway').click();
    await expect(options.getByTestId('gateway-test-result')).toHaveText(
      'OK: Key works with anthropic/claude-sonnet-5.',
    );
    await options.getByTestId('test-anthropic').click();
    await expect(options.getByTestId('test-result')).toHaveText('OK: Key works with claude-haiku-4-5-20251001.');
    const tests = stub.messages().filter((m) => m.body.max_tokens === 1);
    expect(tests.map((m) => [m.body.model, m.headers['x-api-key']])).toEqual([
      ['anthropic/claude-sonnet-5', GATEWAY_KEY],
      ['claude-haiku-4-5-20251001', ANTHROPIC_KEY],
    ]);

    // Process runs on the Gateway with its key, the Gateway model id and effort, from estimate to answer.
    const { doc } = buildLongSession({ minutes: 5 });
    const review = await openSeeded(openExtensionPage, doc);
    const processed = () => stub.messages().filter((m) => m.body.max_tokens !== 1);
    await review.getByTestId('process-button').click();
    await expect(review.getByTestId('process-estimate')).toBeVisible();
    await review.getByTestId('process-confirm').click();
    await expect(review.getByTestId('change-item').first()).toBeVisible({ timeout: 30_000 });
    // The estimate's count (the Test buttons' counts carry no output_config).
    const count = stub.requests.find((r) => r.path === '/v1/messages/count_tokens' && r.body.output_config);
    expect(count?.headers['x-api-key']).toBe(GATEWAY_KEY);
    expect(count?.body.output_config.effort).toBe('high');
    expect(processed().length).toBeGreaterThan(0);
    for (const m of processed()) {
      expect(m.headers['x-api-key']).toBe(GATEWAY_KEY);
      expect(m.body.model).toBe('anthropic/claude-sonnet-5');
      expect(m.body.output_config).toMatchObject({ effort: 'high', format: { type: 'json_schema' } });
    }

    // Effort back to Default: the next run sends no effort at all.
    await options.bringToFront();
    await options.getByTestId('process-effort').selectOption('');
    await options.getByTestId('save-processing').click();
    await expect(options.getByRole('status')).toHaveText('Saved.');
    const before = processed().length;
    await review.bringToFront();
    await review.getByTestId('process-button').click();
    await review.getByTestId('process-confirm').click();
    await expect.poll(() => processed().length, { timeout: 30_000 }).toBeGreaterThan(before);
    for (const m of processed().slice(before)) {
      expect(m.headers['x-api-key']).toBe(GATEWAY_KEY);
      expect(m.body.output_config).not.toHaveProperty('effort');
    }
  } finally {
    await stub.close();
  }
});

test('a failed model list leaves the model field a text input', async ({ serviceWorker, openExtensionPage }) => {
  const stub = await startAnthropicStub({ onMessage: () => messageReply('x', 'OK'), failModels: true });
  try {
    await pointAtStub(serviceWorker, stub);
    await serviceWorker.evaluate((k) => chrome.storage.local.set({ anthropicKey: k }), ANTHROPIC_KEY);
    const options = await openExtensionPage('options.html');
    await expect.poll(() => stub.requests.filter((r) => r.path === '/v1/models').length).toBeGreaterThan(0);
    await expect(options.getByTestId('draft-model')).toHaveJSProperty('tagName', 'INPUT');
    await options.getByTestId('draft-model').fill('claude-typed-e2e');
    await options.getByTestId('save-processing').click();
    await expect(options.getByRole('status')).toHaveText('Saved.');
    expect(
      await serviceWorker.evaluate(
        async () =>
          ((await chrome.storage.local.get('processingSettings')).processingSettings as { draft: { model: string } })
            .draft.model,
      ),
    ).toBe('claude-typed-e2e');
  } finally {
    await stub.close();
  }
});

async function openSeeded(openExtensionPage: (path: string) => Promise<Page>, doc: Parameters<typeof seedSession>[1]) {
  // The Sessions page opens (and so creates) the database; the review page then reads the seeded Session.
  const blank = await openExtensionPage('sessions.html');
  await expect
    .poll(() => blank.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === 'inkup')))
    .toBe(true);
  await seedSession(blank, doc);
  await blank.close();
  return openExtensionPage(`review.html?session=${doc.session.id}`);
}
