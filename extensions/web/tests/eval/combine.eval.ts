// `pnpm eval`, merge cases (E12): two Change Items through the real Anthropic adapter's combine, as the review page
// runs it after a merge. The adapter already enforces the schema and that every screenshot stays cited; this checks
// the answer reads as one request (not the two pasted together) and that a genuine conflict becomes an ambiguity.
//
// Needs ANTHROPIC_API_KEY in .env (or the environment). Without it every case is skipped and the run exits 0.
// EVAL_MERGE_MODEL overrides the model (default: the Merge model default).

import type { ChangeItem } from '@inkup/core/process/change-item';
import { afterAll, describe, expect, it } from 'vitest';
import { createAnthropicAdapter } from '@/adapters/llm';
import { DEFAULT_MERGE_MODEL } from '@/settings';

const KEY = process.env.ANTHROPIC_API_KEY?.trim();
const MODEL = process.env.EVAL_MERGE_MODEL?.trim() || DEFAULT_MERGE_MODEL;

const item = (n: number, over: Partial<ChangeItem>): ChangeItem => ({
  id: `item_000${n}`,
  title: '',
  category: 'style',
  intent: '',
  locations: [
    {
      role: 'subject',
      selector: 'button.cta',
      element: "button 'Get started'",
      url: '/pricing.html',
      screenshot: `shot-${n}`,
      annotation: n,
    },
  ],
  evidence: { video: { start: n * 3, end: n * 3 + 2 }, screenshots: [`shot-${n}`] },
  transcript: '',
  confidence: 0.9,
  agent_prompt: '',
  pinned: false,
  ...over,
});

const CASES: { name: string; into: ChangeItem; from: ChangeItem; conflict: boolean }[] = [
  {
    name: 'overlapping requests on one button',
    into: item(1, {
      title: "Make the 'Get started' button bigger",
      intent: 'The CTA is too small to notice.',
      transcript: 'this button is tiny, make it bigger',
      agent_prompt:
        'On /pricing.html increase the size of button.cta (padding and font size) so it stands out. See screenshots/shot-1.png.',
    }),
    from: item(2, {
      title: "Make the 'Get started' button brand blue",
      intent: 'The CTA should use the brand colour and be more prominent.',
      transcript: 'and it should be our blue, more prominent',
      agent_prompt:
        'On /pricing.html set the background of button.cta to var(--brand) and make it more prominent. See screenshots/shot-2.png.',
    }),
    conflict: false,
  },
  {
    name: 'contradicting sizes for one heading',
    into: item(1, {
      title: 'Make the hero heading 32px',
      intent: 'The heading should be larger.',
      transcript: 'this heading should be 32 pixels',
      locations: [
        {
          role: 'subject',
          selector: 'h1#hero-title',
          element: 'heading',
          url: '/pricing.html',
          screenshot: 'shot-1',
          annotation: 1,
        },
      ],
      agent_prompt: 'On /pricing.html set the font-size of h1#hero-title to 32px. See screenshots/shot-1.png.',
    }),
    from: item(2, {
      title: 'Make the hero heading 24px',
      intent: 'The heading should be smaller.',
      transcript: 'actually the heading should be 24 pixels',
      locations: [
        {
          role: 'subject',
          selector: 'h1#hero-title',
          element: 'heading',
          url: '/pricing.html',
          screenshot: 'shot-2',
          annotation: 2,
        },
      ],
      agent_prompt: 'On /pricing.html set the font-size of h1#hero-title to 24px. See screenshots/shot-2.png.',
    }),
    conflict: true,
  },
];

if (!KEY) console.log('\npnpm eval: ANTHROPIC_API_KEY is not set (add it to .env). Skipping the live merge eval.\n');

const results: string[] = [];

describe.skipIf(!KEY)(`live merge (combine) eval (${MODEL})`, () => {
  const adapter = createAnthropicAdapter({ apiKey: KEY ?? '' });

  it.concurrent.each(CASES)('$name', async ({ into, from, conflict }) => {
    const { changes } = await adapter.combine({ into, from, model: MODEL });
    const problems: string[] = [];
    if (changes.title === into.title || changes.title === from.title)
      problems.push('title is one of the two source titles');
    if (changes.intent === `${into.intent} ${from.intent}`) problems.push('intent is the concatenation');
    if (changes.agent_prompt.includes(`${into.agent_prompt}\n\n${from.agent_prompt}`))
      problems.push('agent_prompt is the concatenation');
    if (conflict && !changes.ambiguity) problems.push('a contradiction was not surfaced as ambiguity');
    results.push(
      `${problems.length ? 'FAIL' : 'PASS'} ${into.title} + ${from.title}: ${JSON.stringify(changes)}${problems.length ? ` :: ${problems.join('; ')}` : ''}`,
    );
    expect(problems).toEqual([]);
  });

  afterAll(() => {
    if (results.length) console.log(['', `Merge eval, ${MODEL}`, ...results, ''].join('\n'));
  });
});
