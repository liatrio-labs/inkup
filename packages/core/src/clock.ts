// Session clock (PRD §7): the service worker records t0 = Date.now() at Start; every context stamps
// events with `Date.now() - t0`. This is the one axis transcript, Strokes, screenshots and media share.

export interface SessionClock {
  /** Epoch ms recorded by the service worker at Start. */
  readonly t0: number;
  /** Session offset in whole ms for an epoch time (default: now). Never negative. */
  offset(at?: number): number;
}

export function createSessionClock(t0: number, now: () => number = Date.now): SessionClock {
  if (!Number.isFinite(t0) || t0 < 0) throw new RangeError(`invalid t0: ${t0}`);
  return {
    t0,
    offset: (at = now()) => toOffset(t0, at),
  };
}

/** Offset of `at` from `t0` in whole ms, clamped at 0 (a context's clock may read a hair before t0). */
export function toOffset(t0: number, at: number): number {
  return Math.max(0, Math.round(at - t0));
}

/** mm:ss for the panel timer; minutes keep growing past 59 (e.g. 75:03). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * YYYY-MM-DD-HHmm of an ISO time in the local time zone, for download file names: two copies of one Session share
 * it, two Sessions started on the same day do not.
 */
export function localStamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
