import { describe, expect, it } from 'vitest';
import { type ElementSnapshot, rankCandidates } from '../src/candidates';
import type { Rect } from '../src/geometry';

// A slice of fixtures/site/pricing.html: html > body > main > section.hero > div.card > (p, button.cta)
function el(
  key: string,
  parent: string | null,
  depth: number,
  tag: string,
  bbox: Rect,
  extra: Partial<ElementSnapshot> = {},
): ElementSnapshot {
  return {
    key,
    parent,
    depth,
    tag,
    role: null,
    name: '',
    text: '',
    selector: `${tag}#${key}`,
    testid: null,
    id: null,
    classes: [],
    bbox,
    stroke_hit: false,
    ...extra,
  };
}
const page = (): ElementSnapshot[] => [
  el('html', null, 0, 'html', { x: 0, y: 0, width: 1280, height: 2400 }),
  el('body', 'html', 1, 'body', { x: 0, y: 0, width: 1280, height: 2400 }),
  el('main', 'body', 2, 'main', { x: 120, y: 60, width: 1040, height: 2000 }),
  el(
    'hero',
    'main',
    3,
    'section',
    { x: 152, y: 92, width: 976, height: 300 },
    { role: 'region', name: 'Ship reviews in minutes' },
  ),
  el('card', 'hero', 4, 'div', { x: 656, y: 150, width: 472, height: 180 }),
  el('p', 'card', 5, 'p', { x: 680, y: 174, width: 424, height: 24 }, { text: 'Start your free trial today.' }),
  el(
    'cta',
    'card',
    5,
    'button',
    { x: 815, y: 220, width: 154, height: 52 },
    { role: 'button', name: 'Get started', text: 'Get started', selector: '.hero-card > button.cta' },
  ),
];
const around = (r: Rect, k: number): Rect => ({
  x: r.x - ((k - 1) * r.width) / 2,
  y: r.y - ((k - 1) * r.height) / 2,
  width: r.width * k,
  height: r.height * k,
});
const CTA = { x: 815, y: 220, width: 154, height: 52 };

describe('Candidate ranking', () => {
  it('a tight circle picks the button it encloses', () => {
    const r = rankCandidates(around(CTA, 1.1), page());
    expect(r.resolution).toBe('element');
    expect(r.pick).toBe(0);
    expect(r.candidates[0]).toMatchObject({
      relation: 'pick',
      tag: 'button',
      selector: '.hero-card > button.cta',
      name: 'Get started',
      role: 'button',
    });
    expect(r.candidates[0]!.coverage).toBeGreaterThanOrEqual(0.7);
    // Ancestors nearest first, stopping before body.
    expect(r.candidates.slice(1).map((c) => [c.relation, c.tag])).toEqual([
      ['ancestor', 'div'],
      ['ancestor', 'section'],
      ['ancestor', 'main'],
    ]);
  });

  it('a loose circle around the button picks the button it encloses, not the card around it (U2)', () => {
    for (const k of [1.3, 1.6, 1.9]) {
      const r = rankCandidates(around(CTA, k), page());
      expect(r.candidates[0], `margin ${k}`).toMatchObject({ relation: 'pick', tag: 'button' });
      expect(r.candidates.slice(1, 3).map((c) => [c.relation, c.tag])).toEqual([
        ['ancestor', 'div'],
        ['ancestor', 'section'],
      ]);
    }
  });

  it('a circle around the whole card picks the card and lists its enclosed children as descendants, largest coverage first', () => {
    const card = { x: 656, y: 150, width: 472, height: 180 };
    for (const k of [1.05, 1.3]) {
      const whole = rankCandidates(around(card, k), page()).candidates;
      expect(whole[0], `margin ${k}`).toMatchObject({ relation: 'pick', tag: 'div' });
      const d2 = whole.filter((c) => c.relation === 'descendant');
      expect(d2.map((c) => c.tag)).toEqual(['p', 'button']);
      expect(d2[0]!.coverage).toBeGreaterThanOrEqual(d2[1]!.coverage);
    }
  });

  it('a tiny element inside a big circle does not win over nothing: the enclosed element must fill a quarter of the circle', () => {
    // A circle over empty hero space that happens to enclose only a 10×10 badge picks the hero it lies in.
    const els = [...page(), el('badge', 'hero', 4, 'span', { x: 300, y: 300, width: 10, height: 10 })];
    const r = rankCandidates({ x: 250, y: 250, width: 120, height: 100 }, els);
    expect(r.candidates[0]).toMatchObject({ relation: 'pick', tag: 'section' });
    expect(r.candidates.filter((c) => c.relation === 'descendant').map((c) => c.tag)).toEqual(['span']);
  });

  it('a mark inside one element (nothing enclosed) keeps the >= 70% covering rule', () => {
    // A scribble over part of the paragraph encloses nothing; the paragraph covers the whole mark.
    const r = rankCandidates({ x: 700, y: 176, width: 200, height: 20 }, page());
    expect(r.candidates[0]).toMatchObject({ relation: 'pick', tag: 'p' });
  });

  it('a tight circle on a leaf has no descendants', () => {
    expect(rankCandidates(around(CTA, 1.1), page()).candidates.some((c) => c.relation === 'descendant')).toBe(false);
  });

  it('skips descendants that stick out of the Annotation and caps them at 8', () => {
    const els: ElementSnapshot[] = [
      el('html', null, 0, 'html', { x: 0, y: 0, width: 2000, height: 2000 }),
      el('box', 'html', 1, 'div', { x: 0, y: 0, width: 1000, height: 1000 }),
      el('out', 'box', 2, 'span', { x: 900, y: 900, width: 300, height: 300 }),
    ];
    for (let i = 0; i < 12; i++)
      els.push(el(`k${i}`, 'box', 2, 'i', { x: 10 + i * 60, y: 10, width: 50, height: 10 + i }));
    const r = rankCandidates({ x: 0, y: 0, width: 1000, height: 1000 }, els);
    const desc = r.candidates.filter((c) => c.relation === 'descendant');
    expect(desc).toHaveLength(8);
    expect(desc.some((c) => c.tag === 'span')).toBe(false);
    expect(desc[0]!.selector).toBe('i#k11');
  });

  it('falls back to the largest overlap when nothing covers 70%', () => {
    // A box straddling the hero bottom edge and empty main space: only main covers it, but make main small.
    const els = page().map((e) => (e.key === 'main' ? { ...e, bbox: { x: 120, y: 60, width: 1040, height: 340 } } : e));
    const box = { x: 700, y: 300, width: 100, height: 200 }; // hero covers 92/200 rows, main 100/200, card 30/200
    const r = rankCandidates(box, els);
    expect(r.candidates[0]).toMatchObject({ tag: 'main' });
    expect(r.candidates[0]!.coverage).toBeCloseTo(0.5, 2);
  });

  it('breaks overlap ties toward the deeper element', () => {
    const els = [
      el('html', null, 0, 'html', { x: 0, y: 0, width: 100, height: 100 }),
      el('a', 'html', 1, 'div', { x: 0, y: 0, width: 50, height: 100 }),
      el('b', 'a', 2, 'span', { x: 0, y: 0, width: 50, height: 100 }),
    ];
    const r = rankCandidates({ x: 25, y: 0, width: 100, height: 100 }, els);
    expect(r.candidates[0]!.tag).toBe('span');
  });

  it('adds siblings of the pick that the Strokes cover, but not uncovered ones', () => {
    const els = page().map((e) => (e.key === 'p' ? { ...e, stroke_hit: true } : e));
    const r = rankCandidates(around(CTA, 1.1), els);
    expect(r.candidates.filter((c) => c.relation === 'sibling').map((c) => c.tag)).toEqual(['p']);
    expect(rankCandidates(around(CTA, 1.1), page()).candidates.some((c) => c.relation === 'sibling')).toBe(false);
  });

  it('counts a sibling mostly inside the Annotation bbox as covered', () => {
    const els = [
      ...page(),
      el('badge', 'card', 5, 'span', { x: 975, y: 225, width: 10, height: 10 }), // right next to the button, inside the bbox
    ];
    const r = rankCandidates(around(CTA, 1.15), els);
    expect(r.candidates[0]!.tag).toBe('button');
    expect(r.candidates.find((c) => c.relation === 'sibling')?.tag).toBe('span');
  });

  it('caps ancestors at 5', () => {
    const els: ElementSnapshot[] = [el('html', null, 0, 'html', { x: 0, y: 0, width: 1000, height: 1000 })];
    for (let d = 1; d <= 9; d++)
      els.push(
        el(`d${d}`, d === 1 ? 'html' : `d${d - 1}`, d, 'div', {
          x: d,
          y: d,
          width: 1000 - 2 * d,
          height: 1000 - 2 * d,
        }),
      );
    const r = rankCandidates({ x: 100, y: 100, width: 50, height: 50 }, els);
    expect(r.candidates[0]!.selector).toBe('div#d9');
    expect(r.candidates.filter((c) => c.relation === 'ancestor')).toHaveLength(5);
  });

  it.each(['iframe', 'canvas'])('flags resolution "region" when the pick is an opaque %s', (tag) => {
    const els = [
      el('html', null, 0, 'html', { x: 0, y: 0, width: 1000, height: 1000 }),
      el('body', 'html', 1, 'body', { x: 0, y: 0, width: 1000, height: 1000 }),
      el('frame', 'body', 2, tag, { x: 100, y: 100, width: 400, height: 200 }),
    ];
    expect(rankCandidates({ x: 150, y: 150, width: 100, height: 50 }, els)).toEqual({
      resolution: 'region',
      candidates: [],
      pick: null,
    });
  });

  it('flags "region" when only html/body are under the Annotation, or nothing at all', () => {
    const r = rankCandidates(
      { x: 10, y: 2300, width: 40, height: 40 },
      page().filter((e) => e.depth < 2),
    );
    expect(r).toEqual({ resolution: 'region', candidates: [], pick: null });
    expect(rankCandidates({ x: 0, y: 0, width: 10, height: 10 }, [])).toEqual({
      resolution: 'region',
      candidates: [],
      pick: null,
    });
  });

  it('handles a zero-height underline by giving the bbox a minimum extent', () => {
    const r = rankCandidates({ x: 820, y: 246, width: 140, height: 0 }, page());
    expect(r.candidates[0]!.tag).toBe('button');
  });

  it('carries class names through, at most 8', () => {
    const els = page().map((e) =>
      e.key === 'cta' ? { ...e, classes: ['cta', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] } : e,
    );
    expect(rankCandidates(around(CTA, 1.1), els).candidates[0]!.classes).toEqual([
      'cta',
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
    ]);
  });

  it('truncates name and text to 200 chars', () => {
    const els = page().map((e) => (e.key === 'cta' ? { ...e, name: 'n'.repeat(300), text: 't'.repeat(300) } : e));
    const c = rankCandidates(around(CTA, 1.1), els).candidates[0]!;
    expect(c.name).toHaveLength(200);
    expect(c.text).toHaveLength(200);
  });

  it('ignores zero-size elements', () => {
    const els = [...page(), el('ghost', 'cta', 6, 'span', { x: 820, y: 230, width: 0, height: 0 })];
    expect(rankCandidates(around(CTA, 1.1), els).candidates[0]!.tag).toBe('button');
  });
});
