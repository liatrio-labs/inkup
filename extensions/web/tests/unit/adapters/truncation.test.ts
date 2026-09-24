// @vitest-environment node
// Feedback batch 1, U4: "Process failed: The answer did not fit in 16000 output tokens" on a longer Session.
// A dense 12-minute Session (one Annotation every 12 s) is one Process window. The stub counts one token per
// character, a stand-in for a real answer whose JSON plus thinking runs past 16k tokens, and cuts the answer at the
// request's max_tokens like the real API. Process must finish with every live Annotation accounted for, and no
// request may replay a truncated answer to the model.

import { planChunks } from '@inkup/core/process/sections';
import { buildWindowPrompt, sessionLength } from '@inkup/core/process/windows';
import { applyTranscriptEdits } from '@inkup/core/review-edits';
import { afterEach, describe, expect, it } from 'vitest';
import { createAnthropicAdapter } from '@/adapters/llm';
import { buildLongSession } from '../../../../../scripts/gen-long-session.ts';
import {
  type AnthropicStub,
  messageReply,
  scriptOf,
  startAnthropicStub,
} from '../../../../../tests/support/anthropic-stub';
import { scriptModel } from '../../../../../tests/support/script-model';

const MODEL = 'claude-sonnet-5';
const { doc, truth } = buildLongSession({ minutes: 12, everyMs: 12_000 });
const live = Array.from({ length: truth.annotations }, (_, i) => i + 1).filter((n) => !truth.scratched.includes(n));

let stub: AnthropicStub | null = null;
afterEach(async () => {
  await stub?.close();
  stub = null;
});
const adapter = () =>
  createAnthropicAdapter({ apiKey: 'sk-ant-test-not-a-real-key', baseURL: stub!.baseURL, maxRetries: 0 });

function expectComplete(r: Awaited<ReturnType<ReturnType<typeof adapter>['process']>>) {
  const used = new Map<number, number>();
  for (const item of r.items)
    for (const l of item.locations)
      if (l.annotation !== null) used.set(l.annotation, (used.get(l.annotation) ?? 0) + 1);
  const dropped = new Set(r.dropped_annotations.map((d) => d.annotation));
  for (const n of live) expect(used.has(n) || dropped.has(n), `Annotation #${n}`).toBe(true);
  for (const [n, count] of used) expect(count, `Annotation #${n}`).toBe(1);
  expect(r.unaccounted_annotations).toEqual([]);
  expect(r.items).toHaveLength(live.length - truth.silent.length);
}

/** No request carries an assistant turn: a truncated answer is never sent back for "repair". */
const noReplays = () =>
  stub!.messages().every((m) => (m.body.messages as { role: string }[]).every((x) => x.role === 'user'));

describe('a dense 12-minute Session whose answer is longer than 16k tokens', () => {
  it('is long enough to overflow the old 16k cap', () => {
    const [only] = planChunks(applyTranscriptEdits(doc.events), sessionLength(doc), { outputCap: 128_000 });
    expect(only!.count).toBe(1);
    const answer = JSON.stringify(scriptModel(buildWindowPrompt(doc, only!).script));
    expect(answer.length).toBeGreaterThan(16_000);
  });

  it('processes without a token error: the output cap is the model’s, and nothing truncated is replayed', async () => {
    stub = await startAnthropicStub({
      charsPerToken: 1,
      onMessage: (req) => messageReply(MODEL, JSON.stringify(scriptModel(scriptOf(req)))),
    });
    const r = await adapter().process({ doc, model: MODEL });
    expectComplete(r);
    expect(noReplays()).toBe(true);
    expect(stub.messages().every((m) => m.body.max_tokens === 128_000)).toBe(true);
  });

  it('recovers when a chunk still runs out of tokens: the chunk is split in half and both halves retried', async () => {
    // The stub stops every answer at 20k tokens, whatever max_tokens says (a model whose thinking ate the budget).
    stub = await startAnthropicStub({
      charsPerToken: 1,
      maxOutputTokens: 20_000,
      onMessage: (req) => messageReply(MODEL, JSON.stringify(scriptModel(scriptOf(req)))),
    });
    const r = await adapter().process({ doc, model: MODEL });
    expectComplete(r);
    expect(noReplays()).toBe(true);
    expect(r.calls.filter((c) => c.kind === 'truncated')).toHaveLength(1);
    expect(r.windows).toBe(2);
  });
});
