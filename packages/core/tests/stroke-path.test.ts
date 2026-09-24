import { describe, expect, it } from 'vitest';
import { strokeOutlinePath } from '../src/stroke-path';

describe('strokeOutlinePath', () => {
  const ring = Array.from({ length: 33 }, (_, i) => ({
    x: 500 + 100 * Math.cos((i / 32) * 2 * Math.PI),
    y: 700 + 50 * Math.sin((i / 32) * 2 * Math.PI),
  }));

  it('outlines the Stroke in screenshot coordinates (page minus scroll)', () => {
    const d = strokeOutlinePath(ring, { x: 0, y: 400 });
    expect(d).toMatch(/^M[\d.-]+ [\d.-]+( Q[\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+)+ Z$/);
    const nums = [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
    const xs = nums.map((n) => n[0]);
    const ys = nums.map((n) => n[1]);
    expect(Math.min(...xs)).toBeGreaterThan(390);
    expect(Math.max(...xs)).toBeLessThan(610);
    expect(Math.min(...ys)).toBeGreaterThan(240);
    expect(Math.max(...ys)).toBeLessThan(360);
  });

  it('returns an empty path for a single point without extent', () => {
    expect(typeof strokeOutlinePath([{ x: 1, y: 1 }], { x: 0, y: 0 })).toBe('string');
  });
});
