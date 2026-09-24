// The cap on how long anything drawn on the page may stay without activity (plan E9,
// packages/core/src/overlay-lifetime.ts): 30 s, or `devOverrides.maxOverlayMs` (tests use a short one).
import { DEFAULT_MAX_OVERLAY_MS } from '@inkup/core/overlay-lifetime';
import { devOverrides } from '@/settings';

let maxMs = DEFAULT_MAX_OVERLAY_MS;
const set = (o: { maxOverlayMs?: number } | null) => (maxMs = o?.maxOverlayMs ?? DEFAULT_MAX_OVERLAY_MS);
try {
  void devOverrides.getValue().then(set, () => {});
  devOverrides.watch(set);
} catch {
  // No extension storage (unit tests): the default.
}

export const maxOverlayMs = () => maxMs;
