import type { ChangeItem } from '@inkup/core/process/change-item';
import { describe, expect, it } from 'vitest';
import { grade } from '../eval/grade';

const item = (
  category: ChangeItem['category'],
  locations: [ChangeItem['locations'][number]['role'], string | null][],
): ChangeItem => ({
  id: 'item_0001',
  title: 't',
  category,
  intent: 'i',
  locations: locations.map(([role, selector]) => ({
    role,
    selector,
    element: 'e',
    url: '/',
    screenshot: null,
    annotation: null,
  })),
  evidence: { video: null, screenshots: [] },
  transcript: '',
  confidence: 0.9,
  agent_prompt: 'p',
  pinned: false,
});
const exp = {
  description: '',
  category: 'layout',
  locations: { subject: ['button.cta'], destination: ['nav', 'a:nth-of-type(3)'] },
};

describe('eval grading', () => {
  it('passes when one item has the category and every role at an accepted selector', () => {
    expect(
      grade(
        [
          item('style', [['subject', 'p']]),
          item('layout', [
            ['subject', 'button.cta'],
            ['destination', 'a:nth-of-type(3)'],
          ]),
        ],
        exp,
      ),
    ).toEqual([]);
  });
  it('reports the closest item’s problems', () => {
    expect(
      grade(
        [
          item('layout', [
            ['subject', 'div.hero-card'],
            ['reference', 'nav'],
          ]),
        ],
        exp,
      ),
    ).toEqual(['subject at div.hero-card, expected button.cta', 'no destination Location']);
    expect(grade([], exp)).toEqual(['no items']);
    expect(
      grade(
        [
          item('style', [
            ['subject', 'button.cta'],
            ['destination', 'nav'],
          ]),
        ],
        exp,
      ),
    ).toEqual(['category style, expected layout']);
  });
});
