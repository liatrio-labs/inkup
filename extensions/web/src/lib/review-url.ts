// The review page's address for a Session, and whether a tab shows it (background/review-tab.ts).

export const REVIEW_PATH = '/review.html';

export const reviewPath = (sessionId: string) => `${REVIEW_PATH}?session=${encodeURIComponent(sessionId)}`;

/**
 * `url` is this extension's review page for `sessionId`, whatever its hash or other parameters. `origin`: the
 * extension's, as `chrome.runtime.getURL('')` gives it. Compared as scheme and host, since `URL.origin` is "null" for
 * the extension schemes outside the browser that owns them.
 */
export function isReviewOf(url: string | undefined, sessionId: string, origin: string): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    `${u.protocol}//${u.host}` === origin.replace(/\/$/, '') &&
    u.pathname === REVIEW_PATH &&
    u.searchParams.get('session') === sessionId
  );
}
