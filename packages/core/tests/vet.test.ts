import { describe, expect, it } from 'vitest';
import { type ChangeItem, ChangeItemSchema } from '../src/process/change-item';
import type { ScriptContext } from '../src/process/script';
import { applyVetResults, markUnverified, VetOutputSchema } from '../src/process/vet';
import { mediaPieces, mediaTimingBlock } from '../src/process/video';

const ctx: ScriptContext = {
  quality: 'word',
  aliases: { s1: 'shot-aaa', s2: 'shot-bbb' },
  annotations: {
    1: { selectors: ['button.cta'], screenshot: 'shot-aaa', url: '/' },
    2: { selectors: ['nav'], screenshot: 'shot-bbb', url: '/' },
  },
  start_url: 'http://localhost/',
};

const item = (over: Partial<ChangeItem> = {}): ChangeItem =>
  ChangeItemSchema.parse({
    id: 'item_0001',
    title: 'Make the button bigger',
    category: 'style',
    intent: 'The CTA is too small.',
    locations: [
      {
        role: 'subject',
        selector: 'button.cta',
        element: "button 'Go'",
        url: '/',
        screenshot: 'shot-aaa',
        annotation: 1,
      },
    ],
    evidence: { video: { start: 1, end: 3 }, screenshots: ['shot-aaa'] },
    transcript: 'make this bigger',
    confidence: 0.9,
    agent_prompt: 'Enlarge button.cta. See screenshots/shot-aaa.png.',
    pinned: false,
    ...over,
  });

/** A correction as the model writes it: aliased screenshot ids. */
const correction = (over: Record<string, unknown> = {}) => ({
  id: 'item_0001',
  title: 'Move the nav to the right',
  category: 'layout',
  intent: 'The footage shows the circle around the nav, not the button.',
  locations: [{ role: 'subject', selector: 'nav', element: 'nav', url: '/', screenshot: 's2', annotation: 2 }],
  evidence: { video: { start: 1.5, end: 3.2 }, screenshots: ['s2'] },
  transcript: 'move this over',
  confidence: 0.8,
  agent_prompt: 'Move the nav right. See screenshots/s2.png.',
  pinned: false,
  ...over,
});

describe('applyVetResults', () => {
  it('confirmed and unverified keep the item and add the verdict', () => {
    const [a, b] = applyVetResults(
      [item(), item({ id: 'item_0002' })],
      [
        { id: 'item_0001', verdict: 'confirmed', reason: 'The circle is on the button.' },
        { id: 'item_0002', verdict: 'unverified', reason: 'Off screen.' },
      ],
      ctx,
    );
    expect(a).toEqual({ ...item(), vetting: { verdict: 'confirmed', reason: 'The circle is on the button.' } });
    expect(b!.vetting).toEqual({ verdict: 'unverified', reason: 'Off screen.' });
    expect(b!.title).toBe(item().title);
  });

  it('a valid correction replaces the item, keeps its id and restores stored screenshot ids', () => {
    const [c] = applyVetResults(
      [item()],
      [{ id: 'item_0001', verdict: 'corrected', reason: 'The ink circles the nav.', item: correction() as never }],
      ctx,
    );
    expect(c).toMatchObject({
      id: 'item_0001',
      title: 'Move the nav to the right',
      locations: [{ selector: 'nav', screenshot: 'shot-bbb' }],
      evidence: { screenshots: ['shot-bbb'] },
      agent_prompt: 'Move the nav right. See screenshots/shot-bbb.png.',
      vetting: { verdict: 'corrected', reason: 'The ink circles the nav.' },
    });
    expect(ChangeItemSchema.safeParse(c).success).toBe(true);
  });

  it('an invalid correction keeps the original, unverified with the reason', () => {
    const bad = [
      correction({
        locations: [{ role: 'subject', selector: 'nav', element: 'nav', url: '/', screenshot: 's9', annotation: 2 }],
      }),
      correction({ confidence: 0.3 }),
      correction({ agent_prompt: 'Move the nav right.' }),
    ];
    for (const b of bad) {
      const [c] = applyVetResults(
        [item()],
        [{ id: 'item_0001', verdict: 'corrected', reason: 'Nav.', item: b as never }],
        ctx,
      );
      expect(c!.title).toBe(item().title);
      expect(c!.vetting!.verdict).toBe('unverified');
      expect(c!.vetting!.reason).toMatch(/^The correction was rejected \(.+\)\. The check said: Nav\.$/);
    }
    const [none] = applyVetResults([item()], [{ id: 'item_0001', verdict: 'corrected', reason: 'Nav.' }], ctx);
    expect(none!.vetting).toEqual({ verdict: 'unverified', reason: 'The check sent no corrected item. It said: Nav.' });
  });

  it('a pinned item is flagged but never rewritten', () => {
    const pinned = item({ pinned: true });
    const [c] = applyVetResults(
      [pinned],
      [{ id: 'item_0001', verdict: 'corrected', reason: 'The ink circles the nav.', item: correction() as never }],
      ctx,
    );
    const { vetting, ...rest } = c!;
    expect(rest).toEqual(pinned);
    expect(vetting).toEqual({
      verdict: 'unverified',
      reason: 'Pinned during the Session, so it was not rewritten. The check said: The ink circles the nav.',
    });
    const [ok] = applyVetResults([pinned], [{ id: 'item_0001', verdict: 'confirmed', reason: 'Yes.' }], ctx);
    expect(ok).toEqual({ ...pinned, vetting: { verdict: 'confirmed', reason: 'Yes.' } });
  });

  it('an item with no verdict is unverified; markUnverified flags them all', () => {
    const [c] = applyVetResults([item()], [], ctx);
    expect(c!.vetting).toEqual({ verdict: 'unverified', reason: 'The check gave no verdict for this item.' });
    expect(markUnverified([item()], 'The check failed.')[0]!.vetting).toEqual({
      verdict: 'unverified',
      reason: 'The check failed.',
    });
  });

  it('the output schema takes a correction that breaks the item rules (checked in code, not repaired)', () => {
    const out = VetOutputSchema.safeParse({
      results: [{ id: 'item_0001', verdict: 'corrected', reason: 'x', item: correction({ confidence: 0.3 }) }],
    });
    expect(out.success).toBe(true);
  });
});

describe('media timing', () => {
  it('without pauses a file is one piece from its start', () => {
    expect(mediaPieces({ start_offset_ms: 400, duration_ms: 60_000 }, [])).toEqual([
      { from: 0, to: 60_000, session: 400 },
    ]);
  });

  it('each pause cuts the file; the next piece resumes after the pause', () => {
    // Recorder at 1 s; paused 10–20 s and 30–35 s of Session time.
    const gaps = [
      { start: 10_000, end: 20_000 },
      { start: 30_000, end: 35_000 },
    ];
    expect(mediaPieces({ start_offset_ms: 1000, duration_ms: 40_000 }, gaps)).toEqual([
      { from: 0, to: 9000, session: 1000 },
      { from: 9000, to: 19_000, session: 20_000 },
      { from: 19_000, to: 40_000, session: 35_000 },
    ]);
  });

  it('the prompt block names each file, its start, the pauses and the rule', () => {
    const block = mediaTimingBlock(
      [
        { kind: 'video', filename: 'video.webm', start_offset_ms: 1000, duration_ms: 40_000 },
        { kind: 'audio', filename: 'audio.webm', start_offset_ms: 200, duration_ms: null },
      ],
      [
        { type: 'session_pause', t: 10_000 },
        { type: 'session_resume', t: 20_000 },
      ] as never,
    );
    expect(block).toContain('- video.webm: the reviewed browser tab, video only (no sound)');
    expect(block).toContain('starts at Session time [00:01.0] (start_offset_ms 1000)');
    expect(block).toContain('file 00:09.0–00:40.0 ↔ Session [00:20.0]–[00:51.0]');
    expect(block).toContain("- audio.webm: the reviewer's microphone, audio only. It starts at Session time [00:00.2]");
    expect(block).toContain('PAUSES (Session time): [00:10.0]–[00:20.0]');
    expect(block).toContain('RULE: media time t_m');
  });
});
