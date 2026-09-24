// Shape recognition on real Strokes recorded through the overlay (tests/e2e/stroke-capture.spec.ts): clean
// Playwright paths plus jittery, wobbly "hand-drawn" variants.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyStroke, detectConnector, resample } from '../src/shapes';

interface StrokeFixture {
  name: string;
  expected: string;
  strokes: { x: number; y: number; t: number }[][];
}

const DIR = join(__dirname, '../../../fixtures/strokes');
const fixtures: StrokeFixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')));
const byName = (n: string) => fixtures.find((f) => f.name === n)!;
const asStrokes = (f: StrokeFixture) => f.strokes.map((points, i) => ({ stroke_id: `${f.name}-${i}`, points }));

describe('classifyStroke on recorded Strokes', () => {
  it('has fixtures for every class', () => {
    expect(new Set(fixtures.map((f) => f.expected))).toEqual(
      new Set(['circle', 'underline', 'arrow', 'scribble', 'freeform']),
    );
  });

  it.each(fixtures.filter((f) => f.strokes.length === 1).map((f) => [f.name, f.expected, f] as const))(
    '%s → %s',
    (_n, expected, f) => {
      expect(classifyStroke(f.strokes[0]!).shape).toBe(expected);
    },
  );

  it('puts the tail at the start of the shaft and the head at the barbs', () => {
    // arrow: drawn from (640,400) to (1040,60) in viewport coordinates; the page was not scrolled.
    const { arrow } = classifyStroke(byName('arrow').strokes[0]!);
    expect(arrow!.tail.x).toBeCloseTo(640, -1);
    expect(arrow!.tail.y).toBeCloseTo(400, -1);
    expect(Math.hypot(arrow!.head.x - 1040, arrow!.head.y - 60)).toBeLessThan(15);
  });

  it('finds the same arrow when the path is drawn barbs-first', () => {
    const pts = [...byName('arrow-hand').strokes[0]!].reverse();
    const { shape, arrow } = classifyStroke(pts);
    expect(shape).toBe('arrow');
    expect(Math.hypot(arrow!.head.x - 700, arrow!.head.y - 380)).toBeLessThan(20);
  });

  it('calls a dot or a tiny tap freeform', () => {
    expect(classifyStroke([{ x: 1, y: 1 }]).shape).toBe('freeform');
    expect(
      classifyStroke([
        { x: 1, y: 1 },
        { x: 3, y: 2 },
      ]).shape,
    ).toBe('freeform');
  });

  it('a shaft alone is an underline or a line, not an arrow', () => {
    const shaft = byName('arrow-two-stroke').strokes[0]!;
    expect(classifyStroke(shaft).shape).toBe('freeform'); // diagonal line
  });

  it('resamples to evenly spaced points', () => {
    const r = resample(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      11,
    );
    expect(r).toHaveLength(11);
    expect(r[5]!.x).toBeCloseTo(50);
  });
});

describe('detectConnector', () => {
  it.each(['arrow-two-stroke', 'arrow-two-stroke-hand', 'arrow-two-stroke-narrow-v'])(
    '%s: a shaft plus a V at its end is one Connector',
    (name) => {
      const f = byName(name);
      const { connector, shapes } = detectConnector(asStrokes(f));
      expect(connector).not.toBeNull();
      expect(connector!.stroke_ids).toEqual([`${name}-0`, `${name}-1`]);
      expect([...shapes.values()].map((s) => s.shape)).toEqual(['arrow', 'arrow']);
      const shaft = f.strokes[0]!;
      const end = shaft.at(-1)!;
      expect(Math.hypot(connector!.head.x - end.x, connector!.head.y - end.y)).toBeLessThan(25);
      expect(Math.hypot(connector!.tail.x - shaft[0]!.x, connector!.tail.y - shaft[0]!.y)).toBeLessThan(15);
    },
  );

  it('a single-Stroke arrow is the Connector', () => {
    const { connector } = detectConnector(asStrokes(byName('arrow')));
    expect(connector?.stroke_ids).toEqual(['arrow-0']);
  });

  it('circle + underline has no Connector', () => {
    const { connector, shapes } = detectConnector([...asStrokes(byName('circle')), ...asStrokes(byName('underline'))]);
    expect(connector).toBeNull();
    expect([...shapes.values()].map((s) => s.shape)).toEqual(['circle', 'underline']);
  });

  it('a V far from the line is not a head', () => {
    const f = byName('arrow-two-stroke');
    const v = f.strokes[1]!.map((p) => ({ ...p, x: p.x - 300, y: p.y + 250 }));
    expect(
      detectConnector([
        { stroke_id: 's', points: f.strokes[0]! },
        { stroke_id: 'v', points: v },
      ]).connector,
    ).toBeNull();
  });
});
