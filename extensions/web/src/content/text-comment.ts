// Text Comments (CONTEXT.md; plans E3, E7): while Select Text is on, selecting text on the page opens a one-line comment
// box ("This should say…") right next to the selection: Enter saves, Esc cancels. A save closes any open Annotation and
// records a `text_comment` with the selected text, a text-quote anchor, the element holding the selection and a
// screenshot of the selection. While Select Text is off, selecting text does nothing special.
//
// - The box (./comment-box.ts) lives in the overlay's shadow root, so snapshots and click capture skip it, and it hides
//   for every screenshot like the toolbar.
// - Draw, Object Select and Select Text are one at a time (background/modes.ts); a pause or the mode going off cancels
//   an open box.
// - A mouse selection opens the box on release, a keyboard one (Shift+arrows) when Shift is let go. Focusing the box
//   takes the page's selection away, so the range is kept from then; on save it is put back for the screenshot, then
//   cleared.

import { toOffset } from '@inkup/core/clock';
import { CLOSE_TIMEOUT_MS, expired, withTimeout } from '@inkup/core/overlay-lifetime';
import { textQuoteAnchor } from '@inkup/core/text-quote';
import { computeAccessibleName, getRole } from 'dom-accessibility-api';
import type { ContentSessionState, TextCommentInput } from '@/messaging';
import { CommentBox } from './comment-box';
import { pageContext } from './overlay';
import { CLASS_BLACKLIST, selectorFor } from './selector';

export interface TextCommentCallbacks {
  /** Close the open Annotation (reason text_comment) and wait until it is recorded. */
  closeAnnotation(t: number): Promise<void>;
  record(input: TextCommentInput): Promise<unknown>;
}

/** Characters of the anchor's context the surrounding container should hold beyond the selection. */
const CONTEXT_CHARS = 64;

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

interface Picked {
  range: Range;
  input: Omit<TextCommentInput, 'comment' | 't_end'>;
}

export class TextCommentUi {
  private readonly box: CommentBox;
  private state: ContentSessionState;
  /** Session time the current selection was made; null while nothing is selected. */
  private selectedAt: number | null = null;
  private picked: Picked | null = null;
  /** Putting the range back for the screenshot must not open the box again. */
  private saving = false;

  constructor(
    container: HTMLElement,
    private readonly host: HTMLElement,
    state: ContentSessionState,
    private readonly cb: TextCommentCallbacks,
  ) {
    this.state = state;
    this.box = new CommentBox(container, {
      testid: 'text-comment-box',
      inputTestid: 'text-comment-input',
      label: 'Comment on the selected text',
      placeholder: 'This should say…',
      hint: 'Enter to save · Esc to cancel',
      onSave: () => void this.save(),
      onCancel: () => {
        this.cancel();
        document.getSelection()?.removeAllRanges();
      },
    });
    document.addEventListener('selectionchange', this.onSelectionChange);
    document.addEventListener('pointerdown', this.onPagePointerDown, true);
    document.addEventListener('pointerup', this.onPagePointerUp, true);
    document.addEventListener('keyup', this.onPageKeyUp, true);
  }

  update(state: ContentSessionState) {
    this.state = state;
    if (this.enabled()) return;
    this.cancel();
    this.selectedAt = null;
  }

  destroy() {
    document.removeEventListener('selectionchange', this.onSelectionChange);
    document.removeEventListener('pointerdown', this.onPagePointerDown, true);
    document.removeEventListener('pointerup', this.onPagePointerUp, true);
    document.removeEventListener('keyup', this.onPageKeyUp, true);
    this.box.destroy();
  }

  /** The overlay cap (E9): a comment box left that long since its last keystroke is saved as typed, or closed if empty. */
  sweep(now: number, maxMs: number): void {
    if (!this.box.isOpen || this.saving || !expired(this.box.lastActivity, now, maxMs)) return;
    if (this.box.text) void this.save();
    else this.clear();
  }

  /** Clear all (E9): the open comment box closes unsaved and the selection goes. How many boxes were closed. */
  clear(): number {
    const open = this.box.isOpen ? 1 : 0;
    this.cancel();
    if (open || this.selectedRange()) document.getSelection()?.removeAllRanges();
    this.selectedAt = null;
    return open;
  }

  hideForCapture(hidden: boolean): Promise<void> {
    return this.box.hideForCapture(hidden);
  }

  private enabled = () => !this.state.paused && this.state.select_mode === 'text';
  private offset = () => toOffset(this.state.t0, Date.now());
  private ours = (e: Event) => e.composedPath().includes(this.host);

  /** The page's current selection when it is text a comment can go on. */
  private selectedRange(): Range | null {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    if (node === this.host || this.host.contains(node)) return null;
    return collapse(sel.toString()) ? range : null;
  }

  private onSelectionChange = () => {
    if (this.saving || !this.enabled()) return;
    if (!this.selectedRange()) this.selectedAt = null;
    else this.selectedAt ??= this.offset();
  };

  private onPagePointerDown = (e: PointerEvent) => {
    // A press anywhere else on the page leaves the comment box.
    if (!this.ours(e) && this.box.isOpen) this.cancel();
  };

  /** A finished mouse selection opens the box (after the browser settles the selection for this release). */
  private onPagePointerUp = (e: PointerEvent) => {
    if (this.ours(e) || !this.enabled()) return;
    setTimeout(this.open, 0);
  };

  private onPageKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Shift' && !this.ours(e) && this.enabled()) this.open();
  };

  private open = () => {
    if (this.box.isOpen || this.saving || !this.enabled()) return;
    const range = this.selectedRange();
    if (!range) return;
    const picked = this.pick(range.cloneRange());
    if (!picked) return;
    this.picked = picked;
    this.box.open(
      () => {
        const rects = [...picked.range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
        return { rect: rects.at(-1) ?? picked.range.getBoundingClientRect(), align: 'end' };
      },
      { comment_id: picked.input.comment_id },
    );
  };

  private cancel() {
    this.picked = null;
    this.box.close();
  }

  private async save() {
    const picked = this.picked;
    const comment = this.box.text;
    if (!picked || !comment) return;
    this.saving = true;
    this.cancel();
    const t_end = Math.max(picked.input.t, this.offset());
    try {
      // The screenshot shows the selection: put it back (the box took it) before the service worker shoots.
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(picked.range);
      // Neither may hold the selection on the page for good (E9).
      await withTimeout(this.cb.closeAnnotation(t_end), CLOSE_TIMEOUT_MS, undefined);
      await withTimeout(
        this.cb.record({ ...picked.input, ...pageContext(), comment, t_end }),
        CLOSE_TIMEOUT_MS,
        undefined,
      );
    } catch (err) {
      console.warn('[var] text comment failed', err);
    } finally {
      document.getSelection()?.removeAllRanges();
      this.saving = false;
      this.selectedAt = null;
    }
  }

  /** What the comment is on, read while the selection is still the page's. */
  private pick(range: Range): Picked | null {
    const common = range.commonAncestorContainer;
    const el = common instanceof Element ? common : common.parentElement;
    if (!el) return null;
    // The anchor's context comes from a container with some text around the selection, the element at least.
    let root: Element = el;
    const exactLength = range.toString().length;
    while (
      root.parentElement &&
      root !== document.body &&
      (root.textContent ?? '').length < exactLength + CONTEXT_CHARS
    )
      root = root.parentElement;
    const before = document.createRange();
    before.setStart(root, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    const anchor = textQuoteAnchor(root.textContent ?? '', start, start + exactLength);
    if (!anchor) return null;
    const r = range.getBoundingClientRect();
    const sx = window.scrollX;
    const sy = window.scrollY;
    return {
      range,
      input: {
        comment_id: crypto.randomUUID(),
        t: this.selectedAt ?? this.offset(),
        selected_text: collapse(range.toString()).slice(0, 2000) || anchor.exact.slice(0, 2000),
        anchor,
        element: describe(el),
        bbox: { x: r.left + sx, y: r.top + sy, width: r.width, height: r.height },
        ...pageContext(),
      },
    };
  }
}

/** The element holding the selection, described like a Candidate. */
function describe(el: Element): TextCommentInput['element'] {
  const r = el.getBoundingClientRect();
  let role: string | null = null;
  let name = '';
  try {
    role = getRole(el);
    name = collapse(computeAccessibleName(el)).slice(0, 200);
  } catch {
    /* exotic elements (SVG internals) */
  }
  const text = el instanceof HTMLElement ? (el.innerText ?? el.textContent ?? '') : (el.textContent ?? '');
  return {
    selector: selectorFor(el),
    tag: el.tagName.toLowerCase(),
    role,
    name,
    text: collapse(text).slice(0, 200),
    testid: el.getAttribute('data-testid'),
    id: el.id || null,
    classes: [...el.classList].filter((c) => !CLASS_BLACKLIST.some((re) => re.test(`.${c}`))).slice(0, 8),
    bbox: { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height },
  };
}
