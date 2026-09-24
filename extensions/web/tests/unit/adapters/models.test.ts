// @vitest-environment node
// The providers' model lists (src/adapters/llm/models.ts) against the local stub, and the catalog cost reads.
import { priceFor } from '@inkup/core/process/cost';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogOf, gatewayModel, listAnthropicModels, listGatewayModels, perMillion } from '@/adapters/llm/models';
import { type AnthropicStub, startAnthropicStub } from '../../../../../tests/support/anthropic-stub';

let stub: AnthropicStub | null = null;
afterEach(async () => {
  await stub?.close();
  stub = null;
});
const noMessages = () => {
  throw new Error('no messages expected');
};

describe('model lists', () => {
  it('converts per-token price strings to USD per 1M without float noise', () => {
    expect(perMillion('0.000002')).toBe(2);
    expect(perMillion('0.0000002')).toBe(0.2);
    expect(perMillion('0.000012')).toBe(12);
    expect(perMillion(undefined)).toBeNull();
    expect(perMillion('free')).toBeNull();
  });

  it('keeps language models of the Gateway list, with prices, limits and tags', () => {
    expect(
      gatewayModel({
        id: 'google/gemini-3.1-pro-preview',
        name: 'Gemini 3.1 Pro Preview',
        type: 'language',
        context_window: 1_000_000,
        max_tokens: 64_000,
        tags: ['file-input', 'vision'],
        pricing: { input: '0.000002', output: '0.000012', input_cache_read: '0.0000002' },
      }),
    ).toEqual({
      id: 'google/gemini-3.1-pro-preview',
      name: 'Gemini 3.1 Pro Preview',
      price: { input: 2, output: 12 },
      context_window: 1_000_000,
      max_tokens: 64_000,
      tags: ['file-input', 'vision'],
    });
    expect(gatewayModel({ id: 'openai/text-embedding-4', type: 'embedding' })).toBeNull();
    expect(gatewayModel({ id: 'x/no-pricing' })).toMatchObject({ price: null, context_window: null, tags: [] });
  });

  it('lists the Gateway with the key as a Bearer token, and Anthropic through the SDK', async () => {
    stub = await startAnthropicStub({ onMessage: noMessages });
    const gateway = await listGatewayModels({ apiKey: 'vck-test-not-a-real-key', baseURL: stub.baseURL });
    expect(gateway.map((m) => m.id)).toEqual([
      'anthropic/claude-sonnet-5',
      'anthropic/claude-haiku-4.5',
      'google/gemini-3.1-pro-preview',
    ]);
    expect(stub.requests[0]!.headers.authorization).toBe('Bearer vck-test-not-a-real-key');
    const anthropic = await listAnthropicModels({ apiKey: 'sk-ant-test-not-a-real-key', baseURL: stub.baseURL });
    expect(anthropic[0]).toEqual({
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      price: null,
      context_window: 1_000_000,
      max_tokens: 128_000,
      tags: [],
    });
    expect(stub.requests[1]!.headers['x-api-key']).toBe('sk-ant-test-not-a-real-key');
  });

  it('throws a readable error when the Gateway list fails', async () => {
    stub = await startAnthropicStub({ onMessage: noMessages, failModels: true });
    await expect(listGatewayModels({ apiKey: 'k', baseURL: stub.baseURL })).rejects.toThrow(
      'Vercel AI Gateway answered 500 for its model list.',
    );
  });

  it('builds one catalog from the cached lists, dated by the Gateway fetch', () => {
    const catalog = catalogOf({
      anthropic: {
        fetched_at: Date.UTC(2026, 8, 20),
        models: [
          { id: 'claude-sonnet-5', name: null, price: null, context_window: 1_000_000, max_tokens: 128_000, tags: [] },
        ],
      },
      gateway: {
        fetched_at: Date.UTC(2026, 8, 24),
        models: [
          {
            id: 'google/gemini-3.1-pro-preview',
            name: null,
            price: { input: 2, output: 12 },
            context_window: 1_000_000,
            max_tokens: 64_000,
            tags: [],
          },
        ],
      },
    });
    expect(catalog?.as_of).toBe('2026-09-24');
    expect(priceFor('google/gemini-3.1-pro-preview', catalog)).toEqual({ input: 2, output: 12 });
    expect(catalogOf({})).toBeNull();
  });
});
