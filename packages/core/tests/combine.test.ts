import { describe, expect, it } from 'vitest';
import type { ChangeItem } from '../src/process/change-item';
import {
  buildCombinePrompt,
  type CombineOutput,
  CombineOutputSchema,
  checkCombineOutput,
  combinedChanges,
  missingCitations,
} from '../src/process/combine';
import { CROP_PROMPT_PREFIX, SOURCE_PROMPT_PREFIX } from '../src/process/grounding';

const A = '7f1c2e0a-0000-4000-8000-00000000000a';
const B = '7f1c2e0a-0000-4000-8000-00000000000b';

const item = (over: Partial<ChangeItem>): ChangeItem => ({
  id: 'item_0001',
  title: 'Make the CTA bigger',
  category: 'style',
  intent: 'The button is too small.',
  locations: [
    {
      role: 'subject',
      selector: 'button.cta',
      element: "button 'Get started'",
      url: '/pricing.html',
      screenshot: A,
      annotation: 1,
    },
  ],
  evidence: { video: { start: 1, end: 2 }, screenshots: [A], crops: [`${A}.crop`] },
  transcript: 'this button is tiny',
  confidence: 0.9,
  agent_prompt: [
    `On /pricing.html make button.cta larger. See screenshots/${A}.png.`,
    `${SOURCE_PROMPT_PREFIX} button.cta is rendered at src/Cta.tsx:12.`,
    `${CROP_PROMPT_PREFIX} screenshots/${A}.crop.png (the screenshot cropped to the marked element).`,
  ].join('\n'),
  pinned: false,
  ...over,
});
const into = item({});
const from = item({
  id: 'item_0002',
  title: 'Make the CTA blue',
  intent: 'It should use the brand colour.',
  locations: [
    {
      role: 'subject',
      selector: 'button.cta',
      element: "button 'Get started'",
      url: '/pricing.html',
      screenshot: B,
      annotation: 2,
    },
  ],
  evidence: { video: { start: 3, end: 4 }, screenshots: [B], crops: [`${B}.crop`] },
  transcript: 'and make it blue',
  agent_prompt: [
    `Make button.cta use var(--brand). See screenshots/${B}.png.`,
    `${SOURCE_PROMPT_PREFIX} button.cta is rendered at src/Cta.tsx:12.`,
    `${CROP_PROMPT_PREFIX} screenshots/${B}.crop.png (the screenshot cropped to the marked element).`,
  ].join('\n'),
});

const answer = (over: Partial<CombineOutput> = {}): CombineOutput => ({
  title: 'Make the CTA bigger and brand blue',
  category: 'style',
  intent: 'The button is too small and should use the brand colour.',
  agent_prompt:
    'On /pricing.html make button.cta larger and give it var(--brand). See screenshots/s1.png and screenshots/s2.png.',
  ambiguity: null,
  ...over,
});

describe('buildCombinePrompt', () => {
  const p = buildCombinePrompt(into, from);

  it('shows both items with screenshots as short aliases and no grounding lines', () => {
    expect(p.script).toContain('ITEM A\ntitle: "Make the CTA bigger"');
    expect(p.script).toContain('ITEM B\ntitle: "Make the CTA blue"');
    expect(p.script).toContain('transcript: "and make it blue"');
    expect(p.script).toContain(
      "- subject: button 'Get started' (button.cta) on /pricing.html · Annotation #1 · screenshot s1",
    );
    expect(p.script).toContain('See screenshots/s2.png.');
    expect(p.script).toContain(
      'REQUIRED CITATIONS (the agent_prompt must contain each): screenshots/s1.png, screenshots/s2.png',
    );
    expect(p.script).not.toContain(A);
    expect(p.script).not.toContain(SOURCE_PROMPT_PREFIX);
    expect(p.script).not.toContain(CROP_PROMPT_PREFIX);
    expect(p.context.aliases).toEqual({ s1: A, s2: B });
    expect(p.context.needs_ambiguity).toBe(false);
  });

  it('asks for an ambiguity when either item is unsure', () => {
    const unsure = buildCombinePrompt(into, { ...from, confidence: 0.4, ambiguity: 'Which blue?' });
    expect(unsure.context.needs_ambiguity).toBe(true);
    expect(unsure.script).toContain('ambiguity: "Which blue?"');
    expect(unsure.script).toContain('ambiguity is required');
  });

  it('the system prompt is the same for every call (prompt cache)', () => {
    expect(buildCombinePrompt(from, into).system).toBe(p.system);
    expect(p.system).toContain('genuinely contradict');
  });
});

describe('checkCombineOutput', () => {
  const { context } = buildCombinePrompt(into, from);

  it('accepts an answer citing every required screenshot', () => {
    expect(CombineOutputSchema.parse(answer())).toEqual(answer());
    expect(checkCombineOutput(answer(), context)).toEqual([]);
  });

  it('flags a dropped citation, an unknown one and a missing ambiguity', () => {
    expect(
      checkCombineOutput(answer({ agent_prompt: 'Do it. See screenshots/s1.png and screenshots/s9.png.' }), context),
    ).toEqual([
      'agent_prompt: must cite screenshots/s2.png',
      'agent_prompt: screenshots/s9.png is not a screenshot of either item',
    ]);
    const unsure = buildCombinePrompt(into, { ...from, confidence: 0.3, ambiguity: 'x' }).context;
    expect(checkCombineOutput(answer({ ambiguity: '  ' }), unsure)).toEqual([
      'ambiguity: required, one item is unsure (confidence under 0.6)',
    ]);
  });

  it('the schema rejects an unknown category', () => {
    expect(CombineOutputSchema.safeParse(answer({ category: 'vibes' as never })).success).toBe(false);
  });
});

describe('combinedChanges', () => {
  const { context } = buildCombinePrompt(into, from);

  it('restores stored ids and puts the grounding lines back once, with one close-up line for both crops', () => {
    const c = combinedChanges(answer({ title: '  Bigger, blue CTA ', ambiguity: '' }), context);
    expect(c.title).toBe('Bigger, blue CTA');
    expect(c.ambiguity).toBeNull();
    expect(c.agent_prompt).toBe(
      [
        `On /pricing.html make button.cta larger and give it var(--brand). See screenshots/${A}.png and screenshots/${B}.png.`,
        `${SOURCE_PROMPT_PREFIX} button.cta is rendered at src/Cta.tsx:12.`,
        `${CROP_PROMPT_PREFIX} screenshots/${A}.crop.png, screenshots/${B}.crop.png (the screenshot cropped to the marked element).`,
      ].join('\n'),
    );
    expect(missingCitations(into, from, c.agent_prompt)).toEqual([]);
  });

  it('missingCitations names what a prompt left out', () => {
    expect(missingCitations(into, from, `screenshots/${A}.png`)).toEqual([`${A}.crop`, B, `${B}.crop`]);
  });
});
