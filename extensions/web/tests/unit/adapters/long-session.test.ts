// @vitest-environment node
// Slice 7 proof (docs/PLAN.md): a synthetic 40-minute Session processes in windows without truncation. The real
// Anthropic adapter runs against the local stub; the stub answers with a stand-in model that reads each window's
// script (tests/support/script-model.ts). Every live Annotation must end up in some Change Item or be listed as
// dropped by the model, duplicates from the overlaps must be merged, and pinned Draft Items must pass through once.

import { planChunks } from '@inkup/core/process/sections';
import { sessionLength } from '@inkup/core/process/windows';
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
const { doc, truth } = buildLongSession({ minutes: 40 });

let stub: AnthropicStub | null = null;
afterEach(async () => {
  await stub?.close();
  stub = null;
});
const adapter = () =>
  createAnthropicAdapter({ apiKey: 'sk-ant-test-not-a-real-key', baseURL: stub!.baseURL, maxRetries: 0 });

describe('a synthetic 40-minute Session', () => {
  it('has Annotations on the window boundaries, scratched and silent ones, and pinned drafts', () => {
    expect(sessionLength(doc)).toBe(40 * 60_000);
    expect(truth.annotations).toBeGreaterThanOrEqual(50);
    expect(truth.scratched.length).toBeGreaterThan(3);
    expect(truth.silent.length).toBeGreaterThan(2);
    expect(truth.pinned).toHaveLength(2);
    expect(planChunks(applyTranscriptEdits(doc.events), sessionLength(doc), { outputCap: 128_000 })).toHaveLength(4);
  });

  it('processes in 4 windows: every live Annotation is used or explicitly dropped, overlaps merge, pins pass through once', async () => {
    // Window 2 first leaves #16 out silently: the coverage check must send it back for repair.
    const firstOmits = new Set<string>();
    stub = await startAnthropicStub({
      onMessage: (req) => {
        const script = scriptOf(req);
        const window = /^WINDOW (\d) of/m.exec(script)?.[1] ?? '?';
        const repair = (req.body.messages as unknown[]).length > 1;
        const omit = window === '2' && !repair && !firstOmits.has(window) ? [16] : [];
        if (omit.length) firstOmits.add(window);
        return messageReply(MODEL, JSON.stringify(scriptModel(script, { omit })));
      },
    });
    const est = await adapter().estimate({ doc, model: MODEL });
    // The estimate counts every window.
    expect(stub.requests.filter((r) => r.path === '/v1/messages/count_tokens')).toHaveLength(4);
    expect(est.input_tokens).toBe(4 * 4321);

    const r = await adapter().process({ doc, model: MODEL });
    const scripts = stub.messages().map(scriptOf);
    // Chunks run two at a time, so the order of requests varies.
    expect(scripts.map((s) => /^WINDOW (\d) of 4/m.exec(s)?.[1]).sort()).toEqual(['1', '2', '2', '3', '4']);
    expect(r.calls.map((c) => c.kind).sort()).toEqual(['main', 'main', 'main', 'main', 'repair']);
    // The repair names the Annotation left out.
    const repairMsg = stub
      .messages()
      .find((m) => m.body.messages.length > 1)!
      .body.messages.at(-1).content as string;
    expect(repairMsg).toContain('#16');
    expect(r.windows).toBe(4);

    const live = Array.from({ length: truth.annotations }, (_, i) => i + 1).filter((n) => !truth.scratched.includes(n));
    const used = new Map<number, string[]>();
    for (const item of r.items)
      for (const l of item.locations)
        if (l.annotation !== null) used.set(l.annotation, [...(used.get(l.annotation) ?? []), item.id]);
    const dropped = new Set(r.dropped_annotations.map((d) => d.annotation));
    // No silent truncation: each live Annotation is in an item or listed as dropped with a reason.
    for (const n of live) expect(used.has(n) || dropped.has(n), `Annotation #${n}`).toBe(true);
    expect(r.unaccounted_annotations).toEqual([]);
    expect([...dropped].sort((a, b) => a - b)).toEqual(truth.silent);
    expect(r.dropped_annotations.every((d) => d.reason.length > 0)).toBe(true);
    // Scratched Annotations produce nothing.
    for (const n of truth.scratched) expect(used.has(n)).toBe(false);
    // Overlap duplicates were merged: exactly one item per Annotation.
    expect(r.duplicates_merged.length).toBeGreaterThan(0);
    for (const [n, ids] of used) expect(ids, `Annotation #${n}`).toHaveLength(1);
    // Ids are renumbered, unique and in time order.
    expect(r.items.map((i) => i.id)).toEqual(r.items.map((_, i) => `item_${String(i + 1).padStart(4, '0')}`));
    const starts = r.items.map((i) => i.evidence.video?.start ?? 0);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    // Pinned Draft Items pass through unchanged, once each, even the one inside window 2's overlap.
    const pinned = r.items.filter((i) => i.pinned);
    expect(pinned.map((i) => i.title).sort()).toEqual(truth.pinned.map((p) => p.title).sort());
    for (const p of truth.pinned) expect(used.get(p.annotation)).toHaveLength(1);
    // Every non-silent live Annotation got its item (the stand-in model makes one per spoken-about Annotation).
    expect(r.items).toHaveLength(live.length - truth.silent.length);
  });
});
