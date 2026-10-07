// The note on a drawn Annotation in a Session without voice (E11). With no microphone, nothing says what a circle or
// an arrow is about, so a drawn Annotation that closes while the reviewer is drawing (a pause in drawing, Draw off, a
// scroll) opens the comment box next to it first: Enter records the Annotation with the typed note, Esc with none.
// Pressing anywhere else (the next Stroke, a click on the page) takes what was typed so far, and so do Stop, a pause,
// an Object Select pick and a Text Comment, which flush it before they close anything. Left idle for the overlay cap
// it records what was typed (E9); Clear all closes it with no note.
//
// Which closes ask for a note is the page code's call (the extension's content/client.ts); this is the box and its
// promise. It renders into the overlay host's React root through `mountDrawNote`.
import { expired } from '@inkup/core/overlay-lifetime';
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Surfaces } from '../toolbar/surfaces';
import { type BoxTheme, CommentBox, type CommentBoxHandle } from './comment-box';

/** The drawn Annotation's rectangle in page coordinates. */
export interface NoteAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DrawNoteHandle {
  /** A note is being asked for. */
  readonly isOpen: boolean;
  /** Opens the box next to the Annotation and resolves with the note (null: skipped or empty). */
  ask(bbox: NoteAnchor): Promise<string | null>;
  /** Takes what was typed so far (Stop, a pause, a pick, a Text Comment). */
  flush(): void;
  /** The overlay cap (E9): a note box idle that long records what was typed. */
  sweep(now: number, maxMs: number): void;
  /** Clear all (E9): the box closes and its Annotation is recorded with no note. How many boxes were closed. */
  clear(): number;
  hideForCapture(hidden: boolean): Promise<void>;
}

export interface DrawNoteProps {
  themeFor?(rect: DOMRect): BoxTheme;
  ref?: Ref<DrawNoteHandle>;
}

export function DrawNote({ themeFor, ref }: DrawNoteProps) {
  const box = useRef<CommentBoxHandle>(null);
  const pending = useRef<((note: string | null) => void) | null>(null);

  const [api] = useState<DrawNoteHandle>(() => {
    const settle = (note: string | null) => {
      const done = pending.current;
      if (!done) return;
      pending.current = null;
      box.current?.close();
      done(note);
    };
    const flush = () => settle(box.current?.text ?? null);
    return {
      get isOpen() {
        return pending.current !== null;
      },
      ask(bbox) {
        flush();
        return new Promise((resolve) => {
          pending.current = resolve;
          box.current?.open(() => ({
            rect: new DOMRect(bbox.x - window.scrollX, bbox.y - window.scrollY, bbox.width, bbox.height),
            align: 'start',
          }));
        });
      },
      flush,
      sweep(now, maxMs) {
        if (pending.current && box.current && expired(box.current.lastActivity, now, maxMs)) flush();
      },
      clear() {
        if (!pending.current) return 0;
        settle(null);
        return 1;
      },
      hideForCapture: (hidden) => box.current?.hideForCapture(hidden) ?? Promise.resolve(),
    };
  });
  useImperativeHandle(ref, () => api, [api]);

  // Pressing anywhere but the box takes what was typed so far.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const el = box.current?.element;
      if (pending.current && !(el && e.composedPath().includes(el))) api.flush();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      // Gone with a note still asked for (the host leaves): the Annotation is recorded without one.
      const done = pending.current;
      pending.current = null;
      done?.(null);
    };
  }, [api]);

  return (
    <CommentBox
      ref={box}
      testid="annotation-note-box"
      inputTestid="annotation-note-input"
      label="Note on the drawn Annotation"
      placeholder="What should change here?"
      hint="Enter to save · Esc to skip"
      allowEmpty
      onSave={(text) => {
        const done = pending.current;
        if (!done) return;
        pending.current = null;
        box.current?.close();
        done(text);
      }}
      onCancel={() => api.clear()}
      themeFor={themeFor}
    />
  );
}

export type MountedDrawNote = DrawNoteHandle & {
  /** Records any note still asked for as typed, and removes the box from the overlay's React root. */
  destroy(): void;
};

const KEY = 'annotation-note-box';

/** Renders the draw note into the overlay host's React root, and returns its handle. */
export function mountDrawNote(surfaces: Surfaces, themeFor?: (rect: DOMRect) => BoxTheme): MountedDrawNote {
  const ref: { current: DrawNoteHandle | null } = { current: null };
  surfaces.set(KEY, <DrawNote ref={ref} themeFor={themeFor} />);
  const handle = ref.current;
  if (!handle) throw new Error('the draw note did not mount');
  return Object.assign(Object.create(handle) as DrawNoteHandle, {
    destroy() {
      handle.flush();
      surfaces.set(KEY, null);
    },
  });
}
