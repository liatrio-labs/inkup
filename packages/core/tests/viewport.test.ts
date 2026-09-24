import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixtureFile } from '../../../scripts/gen-session-fixtures.ts';
import { renderReviewMarkdown } from '../src/export/review-md';
import type { ChangeItem } from '../src/process/change-item';
import { renderEvents } from '../src/process/script';
import { itemViewports, withViewportSizes } from '../src/process/viewport';
import { type SessionDocument, SessionDocumentSchema } from '../src/session-document';
import type { EventOf, TimelineEvent } from '../src/timeline';
import { TimelineEventSchema } from '../src/timeline';
import { clampSize, fitScale, frameRect, sizeWithScale, VIEWPORT_PRESETS, viewportAt } from '../src/viewport';

describe('viewport geometry', () => {
  it('offers the plan presets, each a valid size', () => {
    expect(VIEWPORT_PRESETS.map((p) => `${p.width}x${p.height}`)).toEqual([
      '375x812',
      '390x844',
      '768x1024',
      '1280x800',
      '1440x900',
    ]);
    for (const p of VIEWPORT_PRESETS) expect(clampSize(p)).toEqual({ width: p.width, height: p.height });
  });

  it('clamps typed and dragged sizes to whole px within the limits', () => {
    expect(clampSize({ width: 899.6, height: 700.2 })).toEqual({ width: 900, height: 700 });
    expect(clampSize({ width: 20, height: -5 })).toEqual({ width: 200, height: 200 });
    expect(clampSize({ width: 99_999, height: Number.NaN })).toEqual({ width: 3840, height: 200 });
  });

  it('centres a frame smaller than the tab at 1:1', () => {
    expect(frameRect({ width: 375, height: 600 }, { width: 1280, height: 720 })).toEqual({
      x: 453,
      y: 60,
      width: 375,
      height: 600,
      scale: 1,
    });
  });

  it('scales a frame larger than the tab down to fit, by the tighter side, and never rounds up past a fit', () => {
    expect(fitScale({ width: 1600, height: 1000 }, { width: 800, height: 900 })).toBe(0.5);
    expect(fitScale({ width: 1440, height: 900 }, { width: 1280, height: 720 })).toBe(0.8);
    expect(fitScale({ width: 3000, height: 1000 }, { width: 1000, height: 1000 })).toBe(0.333);
    const r = frameRect({ width: 1440, height: 900 }, { width: 1280, height: 720 });
    expect(r).toEqual({ x: 64, y: 0, width: 1152, height: 720, scale: 0.8 });
    expect(sizeWithScale({ width: 1440, height: 900, scale: 0.8 })).toBe('1440×900 at 80%');
    expect(sizeWithScale({ width: 375, height: 812, scale: 1 })).toBe('375×812');
  });
});

const change = (
  t: number,
  width: number,
  height: number,
  mechanism: 'frame_host' | 'none' = 'frame_host',
): EventOf<'viewport_change'> =>
  TimelineEventSchema.parse({
    id: `vc${t}`,
    type: 'viewport_change',
    t,
    width,
    height,
    scale: 1,
    mechanism,
  }) as EventOf<'viewport_change'>;

describe('which viewport a moment was seen at', () => {
  const events: TimelineEvent[] = [change(1000, 375, 812), change(5000, 900, 812), change(9000, 1280, 633, 'none')];

  it('is the latest change at or before t, and none at the tab size', () => {
    expect(viewportAt(events, 500)).toBeNull();
    expect(viewportAt(events, 1000)?.width).toBe(375);
    expect(viewportAt(events, 4999)?.width).toBe(375);
    expect(viewportAt(events, 6000)?.width).toBe(900);
    expect(viewportAt(events, 9500)).toBeNull();
  });

  it('rejects a scale above 1 or a zero size in the event', () => {
    expect(() =>
      TimelineEventSchema.parse({
        id: 'x',
        type: 'viewport_change',
        t: 0,
        width: 375,
        height: 812,
        scale: 1.5,
        mechanism: 'frame_host',
      }),
    ).toThrow();
    expect(() =>
      TimelineEventSchema.parse({
        id: 'x',
        type: 'viewport_change',
        t: 0,
        width: 0,
        height: 812,
        scale: 1,
        mechanism: 'frame_host',
      }),
    ).toThrow();
    // Chrome's debugger was turned down (decisions log, E6): the frame host is the one mechanism.
    expect(() =>
      TimelineEventSchema.parse({
        id: 'x',
        type: 'viewport_change',
        t: 0,
        width: 375,
        height: 812,
        scale: 1,
        mechanism: 'debugger',
      }),
    ).toThrow();
  });
});

/** Fixture (a) with its two Annotations drawn at 375×812 and the second size change after them. */
function resized(): { doc: SessionDocument; items: ChangeItem[] } {
  const doc = SessionDocumentSchema.parse(JSON.parse(readFileSync(fixtureFile('a-move-here', 'word'), 'utf8')));
  const anns = doc.events.filter((e): e is EventOf<'annotation'> => e.type === 'annotation');
  const first = anns[0]!;
  doc.events = [
    ...doc.events,
    change(Math.max(0, first.t - 100), 375, 812),
    change(anns[anns.length - 1]!.t_end + 100, 1280, 720, 'none'),
  ].sort((a, b) => a.t - b.t);
  const items: ChangeItem[] = [
    {
      id: 'item_0001',
      title: 'Move the CTA',
      category: 'layout',
      intent: 'Move it.',
      locations: [
        {
          role: 'subject',
          selector: 'button.cta',
          element: "button 'Get started'",
          url: '/pricing.html',
          screenshot: first.screenshot_id,
          annotation: first.index,
        },
      ],
      evidence: { video: null, screenshots: [] },
      transcript: 'this',
      confidence: 0.9,
      agent_prompt: 'Move button.cta into the header.',
      pinned: false,
    },
    {
      id: 'item_0002',
      title: 'Page note',
      category: 'question',
      intent: 'A question.',
      locations: [
        { role: 'subject', selector: null, element: 'page', url: '/pricing.html', screenshot: null, annotation: null },
      ],
      evidence: { video: null, screenshots: [] },
      transcript: '',
      confidence: 0.9,
      agent_prompt: 'Look at the page.',
      pinned: false,
    },
  ];
  return { doc, items };
}

describe('Change Items say the size an issue was seen at', () => {
  it('the Process script marks Annotations drawn at a resized viewport and lists the changes', () => {
    const { doc } = resized();
    const { lines } = renderEvents(doc.events, doc.session.start_url, 'word');
    expect(
      lines
        .filter((l) => l.includes('ANNOTATION #'))
        .every((l) => l.includes('viewport 375×812 (resized for the review)')),
    ).toBe(true);
    expect(lines.some((l) => l.endsWith('VIEWPORT resized to 375×812'))).toBe(true);
    expect(lines.some((l) => l.endsWith("VIEWPORT back to the tab's own size"))).toBe(true);
  });

  it('agent_prompt names the size once, only for items drawn at a resized viewport', () => {
    const { doc, items } = resized();
    expect(itemViewports(items[0]!, doc.events)).toEqual([{ width: 375, height: 812 }]);
    const [a, b] = withViewportSizes(items, doc.events);
    expect(a!.agent_prompt).toContain('at 375 px wide (375×812)');
    expect(b!.agent_prompt).toBe('Look at the page.');
    // Already said by the model: left alone.
    expect(withViewportSizes([a!], doc.events)[0]!.agent_prompt).toBe(a!.agent_prompt);
  });

  it('review.md names the sizes and the width of each Location drawn at one', () => {
    const { doc, items } = resized();
    const md = renderReviewMarkdown({ ...doc, change_items: items }, { include: { video: false, audio: false } });
    expect(md).toMatch(
      /^Viewport: resized for the review: 375×812 from \d\d:\d\d, the tab's own size from \d\d:\d\d\./m,
    );
    expect(md).toContain("button 'Get started' `button.cta` on /pricing.html at 375 px wide (375×812) (Annotation #1)");
  });
});
