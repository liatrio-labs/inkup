// How long anything the extension draws on a page may stay there (plan E9). Ink, highlights, pending picks and comment
// boxes each have a hard cap after their last activity (drawing, hovering, typing), whatever any message to the
// service worker is doing: a screenshot or a close that never answers must not leave ink on the page for good.

/** An overlay element with no activity for this long is removed (the default of the `maxOverlayMs` override). */
export const DEFAULT_MAX_OVERLAY_MS = 30_000;
/** The Annotation screenshot the page asked for counts as missing (null) after this long. */
export const SHOT_TIMEOUT_MS = 5_000;
/** A close (the Strokes, the Annotation) is given up on after this long: its Strokes fade anyway. */
export const CLOSE_TIMEOUT_MS = 10_000;
/** How often the sweeper looks, besides every rendered frame. */
export const SWEEP_EVERY_MS = 1_000;

/** Past its cap: `lastActivity` (epoch ms) is more than `maxMs` before `now`. */
export const expired = (lastActivity: number, now: number, maxMs: number) => now - lastActivity > maxMs;

/** `p`, or `fallback` once `ms` pass without it settling (a rejection also gives `fallback`). */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
