// Screenshots in Change Item cards (feedback batch 1, U3): which screenshot a Location shows, and which Strokes are
// drawn on it (only the cited Annotation's, even when Annotations share a screenshot; packages/core/src/evidence-strokes.ts).

import type { EventOf } from '@inkup/core/timeline';
import { describe, expect, it } from 'vitest';
import { locationShot, type ShotIndex, strokesOf } from '@/components/evidence-shot';

const stroke = (id: string) => ({ stroke_id: id }) as EventOf<'stroke'>;
const ann = (index: number, screenshot_id: string | null, stroke_ids: string[]) =>
  ({ index, screenshot_id, stroke_ids }) as unknown as EventOf<'annotation'>;
const index: ShotIndex = {
  shots: new Map(),
  annotations: new Map([
    [1, ann(1, 'shot-a', ['s1', 's2'])],
    [2, ann(2, 'shot-a', ['s3'])],
    [3, ann(3, 'shot-b', ['s4'])],
    [4, ann(4, null, ['s5'])],
  ]),
  strokes: new Map(['s1', 's2', 's3', 's4', 's5'].map((id) => [id, stroke(id)])),
};
const ids = (xs: EventOf<'stroke'>[]) => xs.map((s) => s.stroke_id);

describe('locationShot', () => {
  it("uses the Location's screenshot and draws only the cited Annotation's Strokes", () => {
    const r = locationShot(index, { screenshot: 'shot-a', annotation: 2 })!;
    expect(r.id).toBe('shot-a');
    expect(ids(r.strokes)).toEqual(['s3']);
  });

  it("falls back to the cited Annotation's screenshot", () => {
    const r = locationShot(index, { screenshot: null, annotation: 3 })!;
    expect(r.id).toBe('shot-b');
    expect(ids(r.strokes)).toEqual(['s4']);
  });

  it("draws every Annotation's Strokes on the screenshot when the Location cites none, and none for an Annotation on another screenshot", () => {
    expect(ids(locationShot(index, { screenshot: 'shot-a', annotation: null })!.strokes)).toEqual(['s1', 's2', 's3']);
    expect(ids(locationShot(index, { screenshot: 'shot-a', annotation: 3 })!.strokes)).toEqual([]);
  });

  it('is null without any screenshot', () => {
    expect(locationShot(index, { screenshot: null, annotation: null })).toBeNull();
    expect(locationShot(index, { screenshot: null, annotation: 4 })).toBeNull();
  });
});

describe('strokesOf', () => {
  it('collects the Strokes of several Annotations on one screenshot', () => {
    expect(ids(strokesOf(index, 'shot-a', [1, 2, 3]))).toEqual(['s1', 's2', 's3']);
  });
});
