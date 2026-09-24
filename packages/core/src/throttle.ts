// Screenshot debounce (PRD P0-6): at most one screenshot per 500ms, shared by every trigger. What a trigger does
// inside the window depends on what it needs:
// - reuse: an Annotation close points at the previous screenshot, so it always has an image.
// - defer: navigation, `snap` and the panel Snap button wait for the window to pass, then capture: the page may
//   have changed, and the reviewer asked for a picture.
// - drop: a click right after another screenshot adds nothing.
// Chrome counts every captureVisibleTab call against its per-second quota, so a capture that was then discarded
// (recorded with a null id) still spends the window; there is nothing to reuse, so reuse waits.

export type ThrottlePolicy = 'reuse' | 'defer' | 'drop';
export type ThrottleDecision =
  | { action: 'capture' }
  | { action: 'reuse'; id: string }
  | { action: 'wait'; ms: number }
  | { action: 'drop' };

export interface ScreenshotThrottle {
  decide(now: number, policy?: ThrottlePolicy): ThrottleDecision;
  record(now: number, id: string | null): void;
}

export function createScreenshotThrottle(minGapMs = 500): ScreenshotThrottle {
  let last: { at: number; id: string | null } | null = null;
  return {
    decide: (now, policy = 'reuse') => {
      if (!last || now - last.at >= minGapMs) return { action: 'capture' };
      if (policy === 'reuse' && last.id) return { action: 'reuse', id: last.id };
      if (policy === 'drop') return { action: 'drop' };
      return { action: 'wait', ms: last.at + minGapMs - now };
    },
    record: (now, id) => {
      last = { at: now, id };
    },
  };
}
