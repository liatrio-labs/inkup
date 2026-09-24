// Long-Session windowing (packages/core/src/process/windows.ts): window boundaries, the overlap dedupe, pin passthrough and
// the coverage rules that keep a model from dropping Annotations silently.
import { describe, expect, it } from 'vitest';
import { buildLongSession } from '../../../scripts/gen-long-session.ts';
import type { ChangeItem } from '../src/process/change-item';
import { mergePinnedDrafts } from '../src/process/pins';
import {
  buildWindowPrompt,
  coverageIssues,
  jaccard,
  mergeWindowResults,
  owns,
  type ProcessWindow,
  renumberItems,
  sameSubject,
  shownIn,
  similarIntent,
  unaccountedAnnotations,
} from '../src/process/windows';

const MIN = 60_000;

const item = (
  id: string,
  over: Partial<ChangeItem> & { annotation?: number | null; selector?: string | null } = {},
): ChangeItem => {
  const { annotation = 1, selector = 'button.cta', ...rest } = over;
  return {
    id,
    title: 'Make the Get started button blue',
    category: 'style',
    intent: 'The reviewer wants the CTA button blue.',
    locations: [{ role: 'subject', selector, element: 'button', url: '/pricing.html', screenshot: null, annotation }],
    evidence: { video: { start: 10, end: 12 }, screenshots: [] },
    transcript: 'this button should be blue',
    confidence: 0.9,
    agent_prompt: 'Make button.cta blue.',
    pinned: false,
    ...rest,
  };
};

/** Equal ten-minute windows, the shape Process chunks take (planned by packages/core/src/process/sections.ts). */
function planWindows(durationMs: number): ProcessWindow[] {
  const count = durationMs <= 12 * MIN ? 1 : Math.max(2, Math.round(durationMs / (10 * MIN)));
  const size = durationMs / count;
  return Array.from({ length: count }, (_, index) => {
    const start = index === 0 ? 0 : Math.round(index * size);
    const end = index === count - 1 ? Infinity : Math.round((index + 1) * size);
    return {
      index,
      count,
      start,
      end,
      from: index === 0 ? 0 : Math.max(0, start - MIN),
      to: end === Infinity ? Infinity : end + MIN,
    };
  });
}

describe('window ownership', () => {
  it('assigns every instant to exactly one window (the boundary belongs to the later window)', () => {
    const w = planWindows(40 * MIN);
    for (const t of [0, 10 * MIN - 1, 10 * MIN, 10 * MIN + 1, 29 * MIN, 30 * MIN, 50 * MIN]) {
      expect(
        w.filter((x) => owns(x, t)),
        `t=${t}`,
      ).toHaveLength(1);
    }
    expect(owns(w[0]!, 10 * MIN)).toBe(false);
    expect(owns(w[1]!, 10 * MIN)).toBe(true);
  });

  it('shows span events that overlap the shown range', () => {
    const w: ProcessWindow = planWindows(40 * MIN)[1]!;
    const seg = (t: number, t_end: number) => ({ id: 'x', type: 'speech_activity' as const, t, t_end });
    expect(shownIn(w, seg(8 * MIN, 9 * MIN - 1))).toBe(false);
    expect(shownIn(w, seg(8 * MIN, 9 * MIN + 1))).toBe(true); // trails into the overlap
    expect(shownIn(w, seg(21 * MIN, 22 * MIN))).toBe(true);
    expect(shownIn(w, seg(21 * MIN + 1, 22 * MIN))).toBe(false);
  });
});

describe('window prompts', () => {
  const { doc, truth } = buildLongSession({ minutes: 40 });
  const windows = planWindows(40 * MIN);

  it('list the owned, non-scratched Annotations and render only the shown range', () => {
    const prompts = windows.map((w) => buildWindowPrompt(doc, w));
    const owned = prompts.flatMap((p) => p.owned);
    const live = Array.from({ length: truth.annotations }, (_, i) => i + 1).filter((n) => !truth.scratched.includes(n));
    // Each live Annotation is owned by exactly one window.
    expect(owned.sort((a, b) => a - b)).toEqual(live);
    for (const p of prompts) {
      const stamps = [...p.script.matchAll(/^\[(\d\d):(\d\d\.\d)\]/gm)].map(
        (m) => (Number(m[1]) * 60 + Number(m[2])) * 1000,
      );
      expect(Math.min(...stamps)).toBeGreaterThanOrEqual(p.window.from - 5_000); // a span may start just before
      expect(Math.max(...stamps)).toBeLessThanOrEqual(p.window.to);
      expect(p.script).toMatch(new RegExp(`^WINDOW ${p.window.index + 1} of 4`));
    }
  });

  it('list a pinned Draft Item as fixed only in the window that owns it', () => {
    const prompts = windows.map((w) => buildWindowPrompt(doc, w));
    for (const pin of truth.pinned) {
      const fixedIn = prompts.filter((p) => new RegExp(`PINNED DRAFT ITEMS[\\s\\S]*- ${pin.draft_id} `).test(p.script));
      expect(fixedIn, pin.draft_id).toHaveLength(1);
    }
    // d1 sits just before 10:00: window 2 still shows it in its overlap, as a timeline line.
    expect(prompts[1]!.script).toContain('DRAFT d1 → PINNED by user');
  });

  it('a single window is the plain prompt with the coverage line first', () => {
    const short = buildLongSession({ minutes: 8 }).doc;
    const [w] = planWindows(8 * MIN);
    const p = buildWindowPrompt(short, w!);
    expect(p.script.split('\n')[0]).toMatch(/^ANNOTATIONS TO ACCOUNT FOR: #1, #2/);
    expect(p.script).not.toMatch(/^WINDOW /m);
  });
});

describe('overlap dedupe', () => {
  const [w1, w2] = planWindows(40 * MIN);
  const events = buildLongSession({ minutes: 40 }).doc.events;
  // Annotation #14 starts at 09:50 (window 1 core, window 2 overlap); #15 at 10:35 (window 2).
  const t14 = (events.find((e) => e.type === 'annotation' && e.index === 14) as { t: number }).t;
  expect(owns(w1!, t14)).toBe(true);

  it('merges the same subject and intent from two windows, keeping the window that owns the subject', () => {
    const a = item('item_0003', { annotation: 13, confidence: 0.7 });
    const b = item('item_0001', { annotation: 13, confidence: 0.95, title: 'Make Get started button blue' });
    const m = mergeWindowResults(
      [
        { window: w1!, items: [a], dropped: [] },
        { window: w2!, items: [b], dropped: [] },
      ],
      events,
    );
    expect(m.items).toHaveLength(1);
    // #13 starts in window 1, so window 1's item wins even though window 2's is more confident.
    expect(m.items[0]!.confidence).toBe(0.7);
    expect(m.duplicates).toEqual([{ kept: 'item_0001', dropped: { window: 1, id: 'item_0001' } }]);
  });

  it('keeps items with the same subject but a different request', () => {
    const a = item('item_0001', { annotation: 13 });
    const b = item('item_0001', {
      annotation: 13,
      category: 'copy',
      title: 'Rename the button to Start now',
      intent: 'Change its label.',
      transcript: 'call it start now',
    });
    const m = mergeWindowResults(
      [
        { window: w1!, items: [a], dropped: [] },
        { window: w2!, items: [b], dropped: [] },
      ],
      events,
    );
    expect(m.items).toHaveLength(2);
  });

  it('never loses an Annotation: keeps the duplicate that covers more, or both when neither covers the other', () => {
    const ref = (n: number) => ({
      role: 'reference' as const,
      selector: '#plan-pro',
      element: 'card',
      url: '/pricing.html',
      screenshot: null,
      annotation: n,
    });
    const a = item('item_0001', { annotation: 13 });
    const b = {
      ...item('item_0001', { annotation: 13 }),
      locations: [...item('x', { annotation: 13 }).locations, ref(15)],
    };
    const m = mergeWindowResults(
      [
        { window: w1!, items: [a], dropped: [] },
        { window: w2!, items: [b], dropped: [] },
      ],
      events,
    );
    expect(m.items).toHaveLength(1);
    expect(m.items[0]!.locations.map((l) => l.annotation)).toEqual([13, 15]);
    const c = { ...a, locations: [...a.locations, ref(12)] };
    const both = mergeWindowResults(
      [
        { window: w1!, items: [c], dropped: [] },
        { window: w2!, items: [b], dropped: [] },
      ],
      events,
    );
    expect(both.items).toHaveLength(2);
  });

  it('does not dedupe within one window, and renumbers in time order', () => {
    const a = item('item_0001', { annotation: 15, evidence: { video: { start: 640, end: 642 }, screenshots: [] } });
    const b = item('item_0002', { annotation: 15, evidence: { video: { start: 641, end: 642 }, screenshots: [] } });
    const c = item('item_0001', {
      annotation: 1,
      selector: '#plan-pro',
      title: 'Other',
      intent: 'x',
      transcript: 'y',
      evidence: { video: { start: 5, end: 6 }, screenshots: [] },
    });
    const m = mergeWindowResults(
      [
        { window: w2!, items: [a, b], dropped: [] },
        { window: w1!, items: [c], dropped: [] },
      ],
      events,
    );
    expect(m.items.map((i) => [i.id, i.locations[0]!.annotation])).toEqual([
      ['item_0001', 1],
      ['item_0002', 15],
      ['item_0003', 15],
    ]);
  });

  it('matches subjects by Annotation, or by selector on the same page', () => {
    expect(sameSubject(item('a', { annotation: 3 }), item('b', { annotation: 3, selector: 'nav' }))).toBe(true);
    expect(sameSubject(item('a', { annotation: 3 }), item('b', { annotation: 4 }))).toBe(true); // same selector and page
    expect(sameSubject(item('a', { annotation: 3 }), item('b', { annotation: 4, selector: 'nav' }))).toBe(false);
    expect(
      similarIntent(
        item('a'),
        item('b', { title: 'Totally different', intent: 'Nothing alike', transcript: 'this button should be blue' }),
      ),
    ).toBe(true);
    expect(jaccard('Make the button blue', 'make button BLUE!')).toBe(1);
  });
});

describe('pinned Draft Items across windows', () => {
  const { doc, truth } = buildLongSession({ minutes: 40 });
  const windows = planWindows(40 * MIN);
  const pin = truth.pinned[0]!; // d1, just before 10:00
  const pinnedItem = item('item_0001', { annotation: pin.annotation, title: pin.title, pinned: true });
  const rewrite = (w: number) => item('item_0002', { annotation: pin.annotation, title: `Rewrite from window ${w}` });

  it('come out exactly once, unchanged, whichever windows mention them', () => {
    const merged = mergeWindowResults(
      [
        { window: windows[0]!, items: [pinnedItem, rewrite(1)], dropped: [] },
        { window: windows[1]!, items: [{ ...pinnedItem, id: 'item_0004' }, rewrite(2)], dropped: [] },
      ],
      doc.events,
    );
    const pins = mergePinnedDrafts(merged.items, doc.events, doc.session.start_url);
    const final = renumberItems(pins.items).items;
    const forAnnotation = final.filter((i) => i.locations.some((l) => l.annotation === pin.annotation));
    expect(forAnnotation).toHaveLength(1);
    expect(forAnnotation[0]).toMatchObject({ pinned: true, title: pin.title, category: 'style' });
    // d2 was never output by any window: it is converted in code, once.
    const d2 = truth.pinned[1]!;
    expect(final.filter((i) => i.pinned && i.title === d2.title)).toHaveLength(1);
    expect(final.map((i) => i.id)).toEqual(final.map((_, i) => `item_${String(i + 1).padStart(4, '0')}`));
  });
});

describe('coverage', () => {
  const { doc, truth } = buildLongSession({ minutes: 40 });
  const known = new Set(Array.from({ length: truth.annotations }, (_, i) => i + 1));

  it('asks for every owned Annotation to be used or dropped with a reason', () => {
    expect(
      coverageIssues([item('a', { annotation: 15 })], [{ annotation: 16, reason: 'nothing said' }], [15, 16], known),
    ).toEqual([]);
    expect(coverageIssues([item('a', { annotation: 15 })], [], [15, 16, 17], known)).toEqual([
      'Annotations #16, #17 are neither used by an item nor listed in dropped_annotations with a reason',
    ]);
    expect(coverageIssues([], [{ annotation: 999, reason: 'x' }], [], known)).toEqual([
      'dropped_annotations.0.annotation: there is no Annotation #999',
    ]);
  });

  it('reports live Annotations nobody accounted for, ignoring scratched ones', () => {
    const missing = unaccountedAnnotations(
      [item('a', { annotation: 1 })],
      [{ annotation: 2, reason: 'x' }],
      doc.events,
    );
    expect(missing).not.toContain(1);
    expect(missing).not.toContain(2);
    for (const n of truth.scratched) expect(missing).not.toContain(n);
    expect(missing).toContain(3);
  });
});
