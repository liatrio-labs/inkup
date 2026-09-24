// @vitest-environment node
// Streamed Process (feedback batch 1, U4): the real adapter against the stub's SSE stream. Completed items are
// reported while a chunk still streams, only items that pass the schema are reported, chunks run two at a time,
// each call records its chunk and estimated output, and the estimate names the chunk count.
import { afterEach, describe, expect, it } from 'vitest';
import { type ChunkProgress, createAnthropicAdapter } from '@/adapters/llm';
import { buildLongSession } from '../../../../../scripts/gen-long-session.ts';
import {
  type AnthropicStub,
  messageReply,
  scriptOf,
  startAnthropicStub,
} from '../../../../../tests/support/anthropic-stub';
import { scriptModel } from '../../../../../tests/support/script-model';

const MODEL = 'claude-sonnet-5';
const { doc } = buildLongSession({ minutes: 40 });

let stub: AnthropicStub | null = null;
afterEach(async () => {
  await stub?.close();
  stub = null;
});
const adapter = () =>
  createAnthropicAdapter({ apiKey: 'sk-ant-test-not-a-real-key', baseURL: stub!.baseURL, maxRetries: 0 });
const answer = (req: Parameters<typeof scriptOf>[0], mutate?: (items: { confidence?: number }[]) => void) => {
  const out = scriptModel(scriptOf(req)) as { items: { confidence?: number }[] };
  mutate?.(out.items);
  return messageReply(MODEL, JSON.stringify(out));
};

describe('streamed Process', () => {
  it('reports completed items while each chunk streams, then the chunk’s answer; two chunks at a time', async () => {
    stub = await startAnthropicStub({ deltaChars: 120, streamDelayMs: 1, onMessage: (req) => answer(req) });
    const progress: ChunkProgress[] = [];
    const r = await adapter().process({ doc, model: MODEL, onProgress: (p) => progress.push(structuredClone(p)) });

    const queued = progress.filter((p) => p.status === 'queued');
    expect(queued).toHaveLength(4);
    expect(stub.peakConcurrent()).toBe(2);
    for (const { chunk } of queued) {
      const mine = progress.filter((p) => p.chunk === chunk);
      const done = mine.find((p) => p.status === 'done')!;
      const streamed = mine.filter((p) => p.status === 'streaming' && p.items.length > 0);
      // Items show up one by one before the chunk is done, each identical to the final one.
      expect(streamed.length).toBeGreaterThan(1);
      expect(mine.indexOf(streamed[0]!)).toBeLessThan(mine.indexOf(done));
      const last = streamed.at(-1)!.items;
      expect(last.length).toBe(done.items.length - 1);
      expect(last).toEqual(done.items.slice(0, last.length));
    }
    expect(r.windows).toBe(4);
    // Each call names its chunk and the estimate it can be calibrated against.
    for (const c of r.calls) {
      expect(c.chunk).toBeTypeOf('number');
      expect(c.estimated_output).toBeGreaterThan(0);
    }
    // Every request streamed with the model's output cap.
    expect(stub.messages().every((m) => m.body.stream === true && m.body.max_tokens === 128_000)).toBe(true);
  });

  it('never reports an item that fails the schema', async () => {
    stub = await startAnthropicStub({
      deltaChars: 120,
      onMessage: (req) =>
        answer(req, (items) => {
          // The second item is unsure but gives no ambiguity: invalid, so the chunk goes back for repair.
          if (req.body.messages.length === 1 && items[1]) items[1].confidence = 0.3;
        }),
    });
    const progress: ChunkProgress[] = [];
    await adapter().process({ doc, model: MODEL, onProgress: (p) => progress.push(structuredClone(p)) });
    for (const p of progress) for (const item of p.items) expect(item.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('estimates per chunk and names the chunk count', async () => {
    stub = await startAnthropicStub({ onMessage: (req) => answer(req) });
    const est = await adapter().estimate({ doc, model: MODEL });
    expect(est.chunks).toBe(4);
    expect(est.input_tokens).toBe(4 * 4321);
  });
});
