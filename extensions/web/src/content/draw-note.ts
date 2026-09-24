// The note on a drawn Annotation in a Session without voice (E11). With no microphone, nothing says what a circle or
// an arrow is about, so a drawn Annotation that closes while the reviewer is drawing (a pause in drawing, Draw off, a
// scroll) opens the comment box next to it first: Enter records the Annotation with the typed note, Esc with none.
// Pressing anywhere else (the next Stroke, a click on the page) takes what was typed so far, and so do Stop, a pause,
// an Object Select pick and a Text Comment, which flush it before they close anything. Left idle for the overlay cap
// it records what was typed (E9); Clear all closes it with no note.

import { expired } from '@inkup/core/overlay-lifetime';
import type { AnnotationInput } from '@/messaging';
import { CommentBox } from './comment-box';

/** Closes the reviewer is present for; the others (Stop, navigation, a pick, a pause) record the Annotation as it is. */
const ASKS: ReadonlySet<AnnotationInput['close_reason']> = new Set(['time_gap', 'draw_toggle', 'scroll']);

export const asksForNote = (reason: AnnotationInput['close_reason']) => ASKS.has(reason);

export class DrawNote {
  private readonly box: CommentBox;
  private pending: ((note: string | null) => void) | null = null;

  constructor(container: HTMLElement) {
    this.box = new CommentBox(container, {
      testid: 'annotation-note-box',
      inputTestid: 'annotation-note-input',
      label: 'Note on the drawn Annotation',
      placeholder: 'What should change here?',
      hint: 'Enter to save · Esc to skip',
      allowEmpty: true,
      onSave: (text) => this.settle(text),
      onCancel: () => this.settle(null),
    });
    document.addEventListener('pointerdown', this.onPointerDown, true);
  }

  get isOpen(): boolean {
    return this.pending !== null;
  }

  /** Opens the box next to the Annotation and resolves with the note (null: skipped or empty). */
  ask(input: AnnotationInput): Promise<string | null> {
    this.settle(this.box.text);
    return new Promise((resolve) => {
      this.pending = resolve;
      this.box.open(() => {
        const b = input.bbox;
        return { rect: new DOMRect(b.x - window.scrollX, b.y - window.scrollY, b.width, b.height), align: 'start' };
      });
    });
  }

  /** Takes what was typed so far (Stop, a pause, a pick, a Text Comment). */
  flush(): void {
    this.settle(this.box.text);
  }

  /** The overlay cap (E9): a note box idle that long records what was typed. */
  sweep(now: number, maxMs: number): void {
    if (this.pending && expired(this.box.lastActivity, now, maxMs)) this.flush();
  }

  /** Clear all (E9): the box closes and its Annotation is recorded with no note. How many boxes were closed. */
  clear(): number {
    if (!this.pending) return 0;
    this.settle(null);
    return 1;
  }

  hideForCapture(hidden: boolean): Promise<void> {
    return this.box.hideForCapture(hidden);
  }

  destroy(): void {
    this.flush();
    document.removeEventListener('pointerdown', this.onPointerDown, true);
    this.box.destroy();
  }

  private settle(note: string | null): void {
    const done = this.pending;
    if (!done) return;
    this.pending = null;
    this.box.close();
    done(note);
  }

  private onPointerDown = (e: PointerEvent) => {
    if (this.pending && !e.composedPath().includes(this.box.box)) this.flush();
  };
}
