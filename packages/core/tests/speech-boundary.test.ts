import { describe, expect, it } from 'vitest';
import { speechBoundaryAt } from '../src/speech-boundary';

describe('Speech Boundary', () => {
  it('approximate segments start a sentence at their start', () => {
    expect(speechBoundaryAt({ t: 1200, text: 'and this card should match', words: null })).toBe(1200);
  });

  it('word-level: the latest demonstrative or sentence start', () => {
    const words = [
      { text: 'make', t: 1000, t_end: 1200 },
      { text: 'this', t: 1200, t_end: 1400 },
      { text: 'bigger.', t: 1400, t_end: 1800 },
      { text: 'And', t: 2600, t_end: 2800 },
      { text: 'the', t: 2800, t_end: 2900 },
      { text: 'card', t: 2900, t_end: 3200 },
    ];
    expect(speechBoundaryAt({ t: 1000, text: '', words })).toBe(2600);
    expect(speechBoundaryAt({ t: 1000, text: '', words: words.slice(0, 3) })).toBe(1200);
    expect(speechBoundaryAt({ t: 1000, text: '', words: [...words, { text: 'there', t: 3300, t_end: 3500 }] })).toBe(
      3300,
    );
  });
});
