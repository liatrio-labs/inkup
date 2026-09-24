// The toolbar's viewport control (plan E6): the preset sizes, the geometry that fits a size into the tab (centred
// when smaller, scaled down when larger, like devtools device mode), and which size a moment of the Session was
// seen at. Pure; the mechanisms that resize the page live in the extension behind Platform.viewport.
import type { EventOf, TimelineEvent } from './timeline.ts';

export interface Size {
  width: number;
  height: number;
}

export interface ViewportPreset extends Size {
  id: string;
  label: string;
}

export const VIEWPORT_PRESETS: readonly ViewportPreset[] = [
  { id: '375x812', label: 'Phone', width: 375, height: 812 },
  { id: '390x844', label: 'Phone (large)', width: 390, height: 844 },
  { id: '768x1024', label: 'Tablet', width: 768, height: 1024 },
  { id: '1280x800', label: 'Laptop', width: 1280, height: 800 },
  { id: '1440x900', label: 'Desktop', width: 1440, height: 900 },
];

/** Smaller than this, a page is no longer usefully reviewable; larger, no display shows it at 1:1 anyway. */
export const MIN_VIEWPORT: Size = { width: 200, height: 200 };
export const MAX_VIEWPORT: Size = { width: 3840, height: 2160 };

/** A typed or dragged size as whole CSS px inside the limits. */
export function clampSize(size: Size): Size {
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, Math.round(Number.isFinite(v) ? v : lo)));
  return {
    width: clamp(size.width, MIN_VIEWPORT.width, MAX_VIEWPORT.width),
    height: clamp(size.height, MIN_VIEWPORT.height, MAX_VIEWPORT.height),
  };
}

/** How much `size` is scaled down to fit `available` (1 when it fits), to 3 decimals, never rounded up past a fit. */
export function fitScale(size: Size, available: Size): number {
  const s = Math.min(1, available.width / size.width, available.height / size.height);
  return s >= 1 ? 1 : Math.max(0.001, Math.floor(s * 1000) / 1000);
}

/** Where a frame of `size` sits in `available`: scaled to fit, centred, in `available`'s px. */
export function frameRect(
  size: Size,
  available: Size,
): { x: number; y: number; width: number; height: number; scale: number } {
  const scale = fitScale(size, available);
  const width = Math.round(size.width * scale);
  const height = Math.round(size.height * scale);
  return {
    x: Math.max(0, Math.round((available.width - width) / 2)),
    y: Math.max(0, Math.round((available.height - height) / 2)),
    width,
    height,
    scale,
  };
}

export const sizeLabel = (s: Size) => `${Math.round(s.width)}×${Math.round(s.height)}`;

/** "375×812", or "1600×1000 at 50%" when shown scaled down. */
export const sizeWithScale = (s: Size & { scale: number }) =>
  s.scale < 1 ? `${sizeLabel(s)} at ${Math.round(s.scale * 100)}%` : sizeLabel(s);

type ViewportChange = EventOf<'viewport_change'>;

/** The resized viewport in force at Session time `t`, or null at the tab's own size. */
export function viewportAt(events: readonly TimelineEvent[], t: number): ViewportChange | null {
  let at: ViewportChange | null = null;
  for (const e of events) if (e.type === 'viewport_change' && e.t <= t && (!at || e.t >= at.t)) at = e;
  return at && at.mechanism !== 'none' ? at : null;
}

/** "at 375 px wide (375×812)": how a Change Item says the size an issue was seen at. */
export const seenAtPhrase = (s: Size) => `at ${Math.round(s.width)} px wide (${sizeLabel(s)})`;
