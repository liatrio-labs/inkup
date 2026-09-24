// Object Select (plan E7): pick one element exactly, then say or type what should change about it. The page is never
// modified.
//
// - While it is on, the element under the pointer is outlined. The hit-test is the event's composedPath, so it sees
//   into open shadow roots. ↑ moves the outline to the parent (through shadow hosts), ↓ back toward the element first
//   outlined; the pointer moving starts over. A click or ⏎ picks the outlined element.
// - Page clicks, presses and the keys above never reach the page while it is on: they are stopped in the window's
//   capture phase, before the page and the drawing overlay's click capture see them. Our own overlay host (the
//   toolbar, the comment box) is left alone.
// - A pick closes any open drawn Annotation and is screenshotted with its outline (the caller's `pick`); then a small
//   comment box opens next to the element. Enter records it (with what was typed, or nothing: the reviewer may just
//   speak, and speech from the pick to Enter is about it). Esc in the box drops the pick. A click on the page, the mode
//   going off, a pause or Stop record it as it is. What is said while the box is open goes into it (E11,
//   ./comment-box.ts), not into the Session transcript.

import { CLOSE_TIMEOUT_MS, expired, withTimeout } from '@inkup/core/overlay-lifetime';
import type { DictationTarget } from '@inkup/core/timeline';
import { CommentBox } from './comment-box';
import { composedParent } from './snapshot';
import { themeFor } from './theme';

/** `T`: what the caller made of a pick, handed back to `record`. */
export interface ObjectSelectCallbacks<T> {
  /** The pick: close the open drawn Annotation, screenshot the outline. Returns what `record` needs, or null. */
  pick(el: Element): Promise<T | null>;
  /** The pick is done: record it as an Annotation, with the typed comment (null: none). */
  record(pick: T, comment: string | null): Promise<unknown>;
  /** The pick was dropped (Esc, Clear all) after `pick` answered: what it made (the screenshot) goes. */
  discard?(pick: T): void;
  /** The Annotation the pick becomes, for its comment box's dictation (E11). */
  target?(pick: T): DictationTarget;
}

/** Presses and clicks that never reach the page while Object Select is on. */
const SWALLOWED = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
] as const;

const STYLES = `
.var-hl { all: initial; position: fixed; z-index: 0; pointer-events: none; box-sizing: border-box; border: 2px solid #2563eb;
  background: rgba(37,99,235,.12); border-radius: 2px; }
.var-hl[data-picked] { border-color: #dc2626; background: rgba(220,38,38,.08); }
.var-hl-label { all: initial; position: fixed; z-index: 0; pointer-events: none; padding: 2px 6px; border-radius: 4px; background: #1e3a8a;
  color: #fff; font: 500 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; max-width: 60vw; overflow: hidden;
  text-overflow: ellipsis; }
.var-hl[hidden], .var-hl-label[hidden] { display: none !important; }
.var-hl[data-theme="light"] { border-color: #93c5fd; background: rgba(147,197,253,.18); }
.var-hl[data-theme="light"][data-picked] { border-color: #f87171; background: rgba(248,113,113,.14); }
.var-hl-label[data-theme="light"] { background: #dbeafe; color: #1e3a8a; }
`;

interface Picked<T> {
  el: Element;
  /** Null until the caller has recorded the pick's start. */
  token: T | null;
  /** Ended (not dropped) before its start was recorded: recorded with this comment once it is. */
  ended?: { comment: string | null };
}

export class ObjectSelect<T> {
  private readonly style: HTMLStyleElement;
  private readonly outlineBox: HTMLElement;
  private readonly label: HTMLElement;
  private readonly box: CommentBox;
  private on = false;
  private hovered: Element | null = null;
  /** Elements ↑ went up from, the latest last; ↓ returns to them. */
  private down: Element[] = [];
  private picked: Picked<T> | null = null;
  private raf = 0;
  private chain: Promise<unknown> = Promise.resolve();
  /** Epoch ms of the last pointer move or key while on: the overlay cap counts from it (E9). */
  private lastActivity = Date.now();

  constructor(
    container: HTMLElement,
    private readonly host: HTMLElement,
    private readonly cb: ObjectSelectCallbacks<T>,
  ) {
    this.style = document.createElement('style');
    this.style.textContent = STYLES;
    this.outlineBox = document.createElement('div');
    Object.assign(this.outlineBox, { className: 'var-hl', hidden: true });
    this.outlineBox.dataset.testid = 'object-select-highlight';
    this.label = document.createElement('div');
    Object.assign(this.label, { className: 'var-hl-label', hidden: true });
    this.label.dataset.testid = 'object-select-label';
    container.append(this.style, this.outlineBox, this.label);
    this.box = new CommentBox(container, {
      testid: 'object-select-box',
      inputTestid: 'object-select-input',
      label: 'Comment on the picked element',
      placeholder: 'What should change? (or just say it)',
      hint: 'Enter to save · Esc to drop the pick',
      allowEmpty: true,
      onSave: (text) => this.finish(text),
      onCancel: () => this.drop(),
    });
  }

  get active(): boolean {
    return this.on;
  }

  /** Turns Object Select on: the outline follows the pointer and page clicks pick. */
  start(): void {
    if (this.on) return;
    this.on = true;
    for (const type of SWALLOWED) window.addEventListener(type, this.swallow, true);
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('scroll', this.place, { capture: true, passive: true });
    window.addEventListener('resize', this.place);
  }

  /** Turns Object Select off, recording the pick in progress as it is. */
  stop(): void {
    if (!this.on) return;
    this.finish(this.box.text);
    this.on = false;
    for (const type of SWALLOWED) window.removeEventListener(type, this.swallow, true);
    window.removeEventListener('pointermove', this.onMove, true);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('scroll', this.place, { capture: true });
    window.removeEventListener('resize', this.place);
    cancelAnimationFrame(this.raf);
    this.hovered = null;
    this.down = [];
    this.outlineBox.hidden = this.label.hidden = true;
  }

  /** Records the pick in progress and resolves once every pick is recorded (before Stop). */
  async flush(): Promise<void> {
    this.finish(this.box.text);
    await this.picking;
    await this.chain;
  }

  destroy(): void {
    this.stop();
    this.style.remove();
    this.outlineBox.remove();
    this.label.remove();
    this.box.destroy();
  }

  /**
   * The overlay cap (E9): a pick left open that long (no typing) is recorded as it is; an outline left with the
   * pointer still that long goes.
   */
  sweep(now: number, maxMs: number): void {
    if (this.picked) {
      if (expired(Math.max(this.lastActivity, this.box.lastActivity), now, maxMs)) this.finish(this.box.text);
    } else if (this.hovered && expired(this.lastActivity, now, maxMs)) {
      this.hovered = null;
      this.down = [];
      this.place();
    }
  }

  /** Clear all (E9): the pick in progress is dropped (as Esc would) and the outline goes. How many picks were dropped. */
  clear(): number {
    const dropped = this.picked ? 1 : 0;
    this.drop();
    this.hovered = null;
    this.down = [];
    cancelAnimationFrame(this.raf);
    this.outlineBox.hidden = this.label.hidden = true;
    return dropped;
  }

  /** The comment box and the label are never in a screenshot; the outline is, like the ink of a Stroke. */
  async hideForCapture(hidden: boolean): Promise<void> {
    this.label.style.visibility = hidden ? 'hidden' : '';
    await this.box.hideForCapture(hidden);
  }

  // ---- hover and pick ----

  private ours = (e: Event) => e.composedPath().includes(this.host);

  private onMove = (e: PointerEvent) => {
    this.lastActivity = Date.now();
    if (this.picked || this.ours(e)) return;
    const target = e.composedPath()[0];
    if (!(target instanceof Element) || target === this.hovered) return;
    this.down = [];
    this.outline(target);
  };

  /** Presses and clicks on the page never reach it; a click picks the outlined element, or ends the pick in progress. */
  private swallow = (e: Event) => {
    if (this.ours(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'click') return;
    if (this.picked) {
      this.finish(this.box.text);
      return;
    }
    const target = e.composedPath()[0];
    // A click without a hover first (touch, keyboard focus) picks what it landed on.
    if (!this.hovered && target instanceof Element) this.outline(target);
    this.pick();
  };

  private onKey = (e: KeyboardEvent) => {
    this.lastActivity = Date.now();
    // Keys typed into the comment box are the box's; Esc is the page's mode switch (content/client.ts).
    if (this.ours(e) || this.picked) return;
    if (e.key === 'ArrowUp' && this.hovered) {
      const parent = composedParent(this.hovered);
      if (parent && parent !== document.documentElement) {
        this.down.push(this.hovered);
        this.outline(parent);
      }
    } else if (e.key === 'ArrowDown' && this.down.length) {
      this.outline(this.down.pop()!);
    } else if (e.key === 'Enter' && this.hovered) {
      this.pick();
    } else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  private outline(el: Element) {
    this.hovered = el;
    this.place();
  }

  private place = () => {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      const el = this.picked?.el ?? this.hovered;
      if (!el?.isConnected) {
        this.outlineBox.hidden = this.label.hidden = true;
        return;
      }
      const r = el.getBoundingClientRect();
      Object.assign(this.outlineBox.style, {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
      this.outlineBox.toggleAttribute('data-picked', !!this.picked);
      // Light over a dark element, dark over a light one (E8).
      this.outlineBox.dataset.theme = this.label.dataset.theme = themeFor(r, this.host);
      const cls = [...el.classList]
        .slice(0, 2)
        .map((c) => `.${c}`)
        .join('');
      this.label.textContent = `${el.tagName.toLowerCase()}${cls} · ${Math.round(r.width)}×${Math.round(r.height)}`;
      Object.assign(this.label.style, {
        left: `${Math.max(0, r.left)}px`,
        top: `${r.top >= 22 ? r.top - 22 : r.bottom + 4}px`,
      });
      this.outlineBox.hidden = this.label.hidden = false;
      this.box.reposition();
    });
  };

  private pick() {
    const el = this.hovered;
    if (!el || this.picked) return;
    const picked: Picked<T> = { el, token: null };
    this.picked = picked;
    this.place();
    this.picking = this.begin(picked);
  }

  private async begin(picked: Picked<T>) {
    const el = picked.el;
    // A pick that never answers is given up on (E9), so the outline does not stay.
    const token = await withTimeout(
      this.cb.pick(el).catch((err) => {
        console.warn('[var] object select pick failed', err);
        return null;
      }),
      CLOSE_TIMEOUT_MS,
      null,
    );
    // Ended (a click, the mode going off) while the pick was being recorded: record it now. Dropped meanwhile: discard it.
    if (this.picked !== picked) {
      if (token !== null) {
        if (picked.ended) this.send(token, picked.ended.comment);
        else this.cb.discard?.(token);
      }
      return;
    }
    if (token === null) {
      this.picked = null;
      this.place();
      return;
    }
    picked.token = token;
    this.box.open(
      () => (el.isConnected ? { rect: el.getBoundingClientRect(), align: 'start' } : null),
      this.cb.target?.(token) ?? null,
    );
  }

  /** The pick being started (the caller's `pick`). */
  private picking: Promise<void> = Promise.resolve();

  /** The pick is done: record it (with the comment, if any) and go back to hovering. */
  private finish(comment: string | null) {
    const p = this.picked;
    if (!p) return;
    this.picked = null;
    this.box.close();
    this.place();
    if (p.token !== null) this.send(p.token, comment);
    else p.ended = { comment };
  }

  /** Esc in the box: the pick is not recorded, and its screenshot goes. */
  private drop() {
    const p = this.picked;
    if (p?.token != null) this.cb.discard?.(p.token);
    this.picked = null;
    this.box.close();
    this.place();
  }

  private send(token: T, comment: string | null) {
    this.chain = this.chain
      .then(() => withTimeout(this.cb.record(token, comment), CLOSE_TIMEOUT_MS, undefined))
      .catch((err) => console.warn('[var] object select not recorded', err));
  }
}
