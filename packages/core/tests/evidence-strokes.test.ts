import { describe, expect, it } from 'vitest';
import { strokeIdsForShot } from '../src/evidence-strokes';

const ann = (index: number, screenshot_id: string | null, stroke_ids: string[]) => ({
  index,
  screenshot_id,
  stroke_ids,
});

describe('Strokes drawn over an evidence screenshot (U2)', () => {
  const annotations = [ann(1, 's1', ['a', 'b']), ann(2, 's1', ['c']), ann(3, 's2', ['d'])];

  it("draws only the cited Annotations' Strokes on a screenshot they share with others", () => {
    expect(strokeIdsForShot('s1', [2], annotations)).toEqual(['c']);
    expect(strokeIdsForShot('s1', [1, 2], annotations)).toEqual(['a', 'b', 'c']);
  });

  it('draws no Strokes of an Annotation the item cites on a different screenshot', () => {
    expect(strokeIdsForShot('s2', [1], annotations)).toEqual([]);
  });

  it('an item citing no Annotation draws every Annotation on that screenshot', () => {
    expect(strokeIdsForShot('s1', [], annotations)).toEqual(['a', 'b', 'c']);
  });
});
