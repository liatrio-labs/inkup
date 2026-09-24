import { describe, expect, it } from 'vitest';
import { closeShotPlan, unusedAnnotationShots } from '../src/annotation-shot';
import type { TimelineEvent } from '../src/timeline';

describe('which screenshot a closing Annotation uses (U2)', () => {
  it('uses its own shot, taken after a Stroke, whatever closed it', () => {
    for (const reason of ['time_gap', 'scroll', 'speech_boundary', 'session_end'] as const) {
      expect(closeShotPlan({ reason, requested: true, resolved: false, scrolled: reason === 'scroll' })).toBe('own');
    }
    expect(closeShotPlan({ reason: 'navigation', requested: true, resolved: true, scrolled: false })).toBe('own');
  });

  it('never shoots a page that scrolled away from its Strokes: no shot at all instead', () => {
    expect(closeShotPlan({ reason: 'scroll', requested: false, resolved: false, scrolled: true })).toBe('none');
    expect(closeShotPlan({ reason: 'time_gap', requested: false, resolved: false, scrolled: true })).toBe('none');
  });

  it('lets the service worker shoot at close when no shot was asked for and the page has not moved', () => {
    expect(closeShotPlan({ reason: 'session_end', requested: false, resolved: false, scrolled: false })).toBe(
      'service_worker',
    );
  });

  it("a navigation close cannot wait for a pending shot: the service worker finds the page's latest one", () => {
    expect(closeShotPlan({ reason: 'navigation', requested: true, resolved: false, scrolled: false })).toBe(
      'service_worker',
    );
    expect(closeShotPlan({ reason: 'navigation', requested: false, resolved: false, scrolled: true })).toBe(
      'service_worker',
    );
  });

  it('Clear all never shoots: the Strokes are already gone', () => {
    expect(closeShotPlan({ reason: 'cleared', requested: true, resolved: true, scrolled: false })).toBe('none');
    expect(closeShotPlan({ reason: 'cleared', requested: false, resolved: false, scrolled: false })).toBe('none');
  });
});

describe('screenshots no Annotation uses (#22)', () => {
  const shot = (screenshot_id: string, annotation_id: string | null) =>
    ({ type: 'screenshot', screenshot_id, annotation_id }) as unknown as TimelineEvent;
  const annotation = (screenshot_id: string | null) =>
    ({ type: 'annotation', screenshot_id }) as unknown as TimelineEvent;
  const comment = (screenshot_id: string | null) =>
    ({ type: 'text_comment', screenshot_id }) as unknown as TimelineEvent;

  it('counts the shot of a pick that was dropped, and the replaced shots of a drawn Annotation', () => {
    const events = [shot('dropped', 'pick-1'), shot('early', 'a1'), shot('late', 'a1'), annotation('late')];
    expect(unusedAnnotationShots(events)).toEqual(['dropped', 'early']);
  });

  it('never counts a shot with no Annotation, one an Annotation or a Text Comment uses, or a shot listed twice', () => {
    const events = [
      shot('click', null),
      shot('snap', null),
      shot('used', 'a1'),
      annotation('used'),
      shot('tc', null),
      comment('tc'),
      shot('twice', 'a2'),
      shot('twice', 'a2'),
    ];
    expect(unusedAnnotationShots(events)).toEqual(['twice']);
    expect(unusedAnnotationShots([...events, annotation('twice')])).toEqual([]);
  });

  it("an Annotation closed by a navigation may use another Annotation's shot: that one is used", () => {
    expect(unusedAnnotationShots([shot('s1', 'a1'), annotation('s1'), annotation(null)])).toEqual([]);
  });
});
