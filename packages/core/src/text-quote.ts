// Text-quote anchors for Text Comments (E3), after the W3C Web Annotation TextQuoteSelector: the selected text plus a
// little of the text either side, so an implementer (or an agent grepping the source) can find the exact spot even
// where the same words appear twice. Pure: the content script passes the element's text and the selection's offsets
// in it.
import type { TextQuoteAnchor } from './timeline.ts';

/** Characters of context kept either side of the selection. */
export const QUOTE_CONTEXT = 32;

const collapse = (s: string) => s.replace(/\s+/g, ' ');

/**
 * The anchor of `text.slice(start, end)`. Whitespace is collapsed as the page shows it, and whitespace at the edges of
 * the selection moves into the prefix and suffix. Null when the selection holds no visible text.
 */
export function textQuoteAnchor(
  text: string,
  start: number,
  end: number,
  context = QUOTE_CONTEXT,
): TextQuoteAnchor | null {
  let s = Math.max(0, Math.min(start, end, text.length));
  let e = Math.min(text.length, Math.max(start, end));
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  if (s === e) return null;
  return {
    exact: collapse(text.slice(s, e)),
    prefix: collapse(text.slice(0, s)).trimStart().slice(-context),
    suffix: collapse(text.slice(e)).trimEnd().slice(0, context),
  };
}
