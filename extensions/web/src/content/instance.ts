// One overlay client per page (#18). The manifest content script and the copy background/inject.ts puts into tabs
// open at install both run in a tab that was loading then, and after an update the old version's overlay stays in the
// page with a dead runtime. The first live copy claims the page; a second live copy of the same extension instance
// (the same isolated world) finds the claim and exits. After an update Chrome runs the new version in a new world
// while the old copy's script keeps running there with a dead runtime: it leaves when a new copy claims the page. The
// claim is a DOM event, and only a dead copy acts on it, so a page sending it can at most clear an overlay that no
// longer works.
const LIVE = Symbol.for('inkup.overlay-client');
const CLAIM = 'inkup:overlay-claim';
/** The overlay host's tag, in web pages (WXT's shadow-root UI name) and in our own pages (page-overlay/mount.ts). */
export const HOST_TAG = 'var-review-overlay';

/**
 * This copy's own runtime, taken when it starts: after an update the new copy may run in the same world with a new
 * `chrome` global, and only the old object says the old runtime is gone.
 */
const runtime = typeof chrome === 'undefined' ? undefined : chrome.runtime;

/** False once the extension that injected this copy has been updated, reloaded or removed. */
export function runtimeAlive(): boolean {
  try {
    return !!runtime?.id;
  } catch {
    return false;
  }
}

/**
 * Claims the page for this copy. False: a live copy already runs here, and this one must do nothing. `leave` is
 * called once this copy's runtime has died and a newer copy claims the page.
 */
export function claimPage(leave: () => void): boolean {
  const w = window as unknown as Record<symbol, { alive(): boolean } | undefined>;
  if (w[LIVE]?.alive()) return false;
  // An orphaned copy whose script still runs (in any world) removes its overlay and listeners. One whose script
  // context the browser destroyed (Chrome, on an update) left its host behind with nothing running it: it goes too.
  // No live copy of this extension can own one, since there is one isolated world per extension.
  document.dispatchEvent(new CustomEvent(CLAIM));
  for (const stale of document.querySelectorAll(HOST_TAG)) stale.remove();
  for (const stale of document.querySelectorAll(HOST_TAG)) stale.remove();
  w[LIVE] = { alive: runtimeAlive };
  const onClaim = () => {
    if (runtimeAlive()) return;
    document.removeEventListener(CLAIM, onClaim);
    leave();
  };
  document.addEventListener(CLAIM, onClaim);
  return true;
}
