// Which screenshot a closing Annotation uses (feedback batch 1, U2). The page asks for the Annotation's screenshot
// shortly after each Stroke's pointer-up, while the Strokes are on screen, so the close normally just uses that
// ("own"). A close never shoots a page that has scrolled away from its Strokes.
import type { CloseReason, TimelineEvent } from './timeline.ts';

export type CloseShot =
  /** Wait for the shot the page asked for (its id, or null when it was dropped). */
  | 'own'
  /** Let the service worker decide: shoot now, or, for a navigation, the page's latest screenshot. */
  | 'service_worker'
  /** No screenshot. */
  | 'none';

export function closeShotPlan(p: {
  reason: CloseReason;
  /** A shot was asked for after one of the group's Strokes. */
  requested: boolean;
  /** That shot's answer has arrived. */
  resolved: boolean;
  /** The page scrolled since the group's last Stroke. */
  scrolled: boolean;
}): CloseShot {
  // Clear all: the Strokes are gone at once, so there is nothing to shoot.
  if (p.reason === 'cleared') return 'none';
  // The page is unloading: the close cannot await anything.
  if (p.reason === 'navigation') return p.requested && p.resolved ? 'own' : 'service_worker';
  if (p.requested) return 'own';
  return p.scrolled ? 'none' : 'service_worker';
}

/**
 * Screenshots taken for an Annotation that nothing records using (#22): a pick dropped with Esc, the shots of a drawn
 * Annotation that a later shot replaced, or of one cleared before it closed. A shot with no Annotation (a click, a
 * navigation, Snap) is evidence of its own and never counted.
 */
export function unusedAnnotationShots(events: readonly TimelineEvent[]): string[] {
  const used = new Set<string>();
  for (const e of events) {
    if ((e.type === 'annotation' || e.type === 'text_comment') && e.screenshot_id) used.add(e.screenshot_id);
  }
  const unused = new Set<string>();
  for (const e of events) {
    if (e.type === 'screenshot' && e.annotation_id !== null && !used.has(e.screenshot_id)) unused.add(e.screenshot_id);
  }
  return [...unused];
}
