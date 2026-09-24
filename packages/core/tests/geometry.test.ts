import { describe, expect, it } from 'vitest';
import {
  area,
  boundsOfPoints,
  containsPoint,
  evenlySample,
  gridPoints,
  intersection,
  intersectionArea,
  union,
} from '../src/geometry';

describe('geometry', () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  it('intersects rects', () => {
    expect(intersection(a, { x: 5, y: 5, width: 10, height: 10 })).toEqual({ x: 5, y: 5, width: 5, height: 5 });
    expect(intersection(a, { x: 10, y: 0, width: 5, height: 5 })).toBeNull(); // touching edges do not overlap
    expect(intersectionArea(a, { x: 20, y: 20, width: 1, height: 1 })).toBe(0);
  });
  it('computes bounds and unions', () => {
    expect(boundsOfPoints([{ x: 3, y: 4 }])).toEqual({ x: 3, y: 4, width: 0, height: 0 });
    expect(
      boundsOfPoints([
        { x: 3, y: 4 },
        { x: -1, y: 10 },
      ]),
    ).toEqual({ x: -1, y: 4, width: 4, height: 6 });
    expect(union([a, { x: 20, y: -5, width: 1, height: 1 }])).toEqual({ x: 0, y: -5, width: 21, height: 15 });
    expect(() => boundsOfPoints([])).toThrow();
    expect(() => union([])).toThrow();
  });
  it('treats negative sizes as empty', () => {
    expect(area({ x: 0, y: 0, width: -3, height: 4 })).toBe(0);
  });
  it('samples a grid of cell centres inside the rect', () => {
    const pts = gridPoints({ x: 0, y: 0, width: 80, height: 40 }, 8);
    expect(pts).toHaveLength(64);
    expect(pts[0]).toEqual({ x: 5, y: 2.5 });
    expect(pts.every((p) => containsPoint({ x: 0, y: 0, width: 80, height: 40 }, p))).toBe(true);
  });
  it('samples evenly and keeps both ends', () => {
    expect(evenlySample([1, 2, 3], 5)).toEqual([1, 2, 3]);
    const s = evenlySample([...Array(100).keys()], 5);
    expect(s).toEqual([0, 25, 50, 74, 99]);
    expect(evenlySample([1, 2, 3], 1)).toEqual([1]);
    expect(evenlySample([1, 2, 3], 0)).toEqual([]);
  });
});
