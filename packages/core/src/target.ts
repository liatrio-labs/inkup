// What a Session can do on a tab's URL (feedback batch 1, U5). Web pages get the content script's drawing
// overlay. Our own extension pages mount the same overlay themselves (content scripts cannot be declared for
// chrome-extension://). Other extensions' pages, chrome:// pages and the Web Store run no script of ours: a
// Session there records audio, transcript, video and URLs, and screenshots only through the `snap` shortcut's
// activeTab grant.

export type TargetMode = 'page' | 'own_page' | 'no_overlay' | 'not_a_target';

/** Our pages that are part of the recording machinery, not something to review. */
const OWN_MACHINERY = new Set(['/sidepanel.html', '/offscreen.html']);
/** Hosts where Chrome runs no extension scripts. */
const SCRIPT_BLOCKED_HOSTS = /^(chromewebstore|chrome)\.google\.com$/;

/** @param ownOrigin `chrome-extension://<our id>` */
export function targetMode(url: string | undefined, ownOrigin: string): TargetMode {
  if (!url) return 'not_a_target';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'not_a_target';
  }
  if (u.protocol === 'http:' || u.protocol === 'https:')
    return SCRIPT_BLOCKED_HOSTS.test(u.hostname) ? 'no_overlay' : 'page';
  if (u.protocol === 'file:') return 'page';
  // URL.origin is "null" for chrome-extension: outside the browser, so compare scheme and host.
  if (`${u.protocol}//${u.host}` === ownOrigin) return OWN_MACHINERY.has(u.pathname) ? 'not_a_target' : 'own_page';
  if (u.protocol === 'chrome-extension:' || u.protocol === 'chrome:' || u.protocol === 'about:') return 'no_overlay';
  return 'not_a_target';
}

/** What a running Session is doing on its tab's current page. */
export type SessionMode = Exclude<TargetMode, 'not_a_target'>;

/** The Session records drawing on this mode's pages. */
export const hasOverlay = (mode: TargetMode) => mode === 'page' || mode === 'own_page';
