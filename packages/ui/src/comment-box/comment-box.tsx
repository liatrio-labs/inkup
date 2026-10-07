// The small one-line comment box that Select Text and Object Select open next to what the reviewer chose (E3, E7). It
// sits in the overlay's shadow root, so snapshots and click capture skip it, and it hides for every screenshot like the
// toolbar. Enter saves, Esc cancels, and keys typed in it never reach the page's shortcuts. It renders into the
// overlay host's one React root (ADR 0011) through `mountCommentBox`, and is driven through its handle: the page code
// (Object Select, Select Text, the draw note) opens it at a rectangle and reads what was typed.
//
// Theme: the box asks its caller (`themeFor`) for the theme of the page under it, light over dark and dark over light,
// and wears it as its own `data-theme` (the palette on the element, shadow.css), so it stays readable where the toolbar
// is over another colour. With no answer it takes the host's, which is the toolbar's.
//
// Focus: opening takes the caret (the reviewer is about to type) and closing gives it back; nothing else here focuses.
//
// Dictation (E11): a box opened for a target (the Annotation or Text Comment it is about) in a Session with voice has
// a mic button. In 'auto' it dictates from the moment it opens, in 'push' only while the button is on; while it
// dictates, what is said shows as a live caption under the text and final words are appended to it, and the service
// worker keeps that speech out of the Session transcript and Voice Commands. One box dictates at a time.
import type { DictationTarget } from '@inkup/core/timeline';
import { type KeyboardEvent, type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { cn } from '../lib/utils';
import { nextPaint } from '../toolbar/paint';
import type { Surfaces } from '../toolbar/surfaces';

export type BoxTheme = 'light' | 'dark';

/** How a box takes speech: from the moment it opens, or only while its mic button is on. */
export type BoxDictationMode = 'auto' | 'push';

/** Dictated words for a box (E11): `final` ones are appended to the text, an interim one only shown. */
export interface DictationWords {
  target: DictationTarget;
  text: string;
  final: boolean;
}

/** The page's side of dictation: how boxes take speech now, and turning it on or off for a target. */
export interface DictationHost {
  /** Null: the Session has no voice, so boxes have no mic button. */
  mode(): BoxDictationMode | null;
  set(target: DictationTarget, on: boolean): void;
}

/** What the box is about: the rectangle (viewport px) it opens beside, and which of its edges the box lines up with. */
export interface BoxAnchor {
  rect: DOMRect;
  align: 'start' | 'end';
}

export interface CommentBoxOptions {
  testid: string;
  inputTestid: string;
  label: string;
  placeholder: string;
  hint: string;
  /** Enter with nothing typed saves too (Object Select: the reviewer spoke instead); otherwise it does nothing. */
  allowEmpty?: boolean;
  /** Enter: the trimmed text, or null when empty (only with allowEmpty). */
  onSave(text: string | null): void;
  /** Esc in the box. */
  onCancel(): void;
  /** The theme for the box over `rect` (viewport px): the page under it decides. Without it the box takes the host's. */
  themeFor?(rect: DOMRect): BoxTheme;
}

export interface CommentBoxHandle {
  /** Opens the box at `anchor` and puts the caret in it. `target`: what the box is about, so what is said into it can be tagged (E11); without one it only takes typing. */
  open(anchor: () => BoxAnchor | null, target?: DictationTarget | null): void;
  close(): void;
  readonly isOpen: boolean;
  /** The text typed so far, trimmed; null when empty. */
  readonly text: string | null;
  /** Epoch ms of the box's last activity (opened, typed in, dictated into): the overlay cap counts from it (E9). */
  readonly lastActivity: number;
  readonly isDictating: boolean;
  startDictation(): void;
  stopDictation(): void;
  /** Dictated words: a final one is appended to the text, an interim one only shown. */
  receive(words: DictationWords): void;
  /** Places the box again on the next frame (a scroll, a resize, the anchor moving). */
  reposition(): void;
  /** Off screen for a screenshot (resolves once a frame without it has been painted), or back. */
  hideForCapture(hidden: boolean): Promise<void>;
  /** The box's element, to tell a press inside it from one on the page; null once unmounted. */
  readonly element: HTMLElement | null;
}

export interface CommentBoxProps extends CommentBoxOptions {
  ref?: Ref<CommentBoxHandle>;
}

const GAP = 6;
/** The box keeps this far from the viewport's edges. */
const MARGIN = 8;
const MAX_CHARS = 2000;

let dictationHost: DictationHost | null = null;
/** The box dictating now, if any. */
let dictating: CommentBoxHandle | null = null;

export function connectDictation(host: DictationHost | null): void {
  dictationHost = host;
  if (!host) dictating?.stopDictation();
}

/** Words from the service worker for the dictating box; ignored when it is about another target (closed since). */
export function receiveDictation(words: DictationWords): void {
  dictating?.receive(words);
}

const sameTarget = (a: DictationTarget, b: DictationTarget) => JSON.stringify(a) === JSON.stringify(b);

// DESIGN.md on the palette (so the box's own `data-theme` decides the colours): a paper card with a hairline edge and
// the Card shadow, as the toolbar floats; a recessed paper-2 field; the ink fill for the pressed mic (the Red Pen Rule
// keeps red for the reviewer's marks); the 2px ink focus ring at 3px offset; the DESIGN easing on state changes.
const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-solid focus-visible:outline-ink';
const BOX = cn(
  'pointer-events-auto fixed z-[2] box-border flex w-[300px] max-w-[calc(100vw-16px)] flex-col gap-1.5 rounded-lg border border-hairline bg-paper p-2 font-sans text-xs leading-tight font-medium text-ink',
  'shadow-[0_1px_2px_rgb(31_42_68/0.08),0_8px_24px_-8px_rgb(31_42_68/0.18)] data-[theme=dark]:shadow-[0_1px_2px_rgb(0_0_0/0.3),0_8px_24px_-8px_rgb(0_0_0/0.5)]',
);
const FIELD = cn(
  'm-0 block h-8 w-full min-w-0 flex-1 resize-none overflow-hidden rounded-sm border-0 bg-paper-2 px-2.5 py-1.5 font-sans text-sm leading-5 font-normal whitespace-nowrap text-ink',
  'placeholder:text-muted-foreground',
  FOCUS,
);
const MIC_BUTTON = cn(
  'inline-grid size-8 flex-none cursor-pointer place-items-center rounded-sm border-0 bg-paper-2 p-0 text-muted-foreground transition-colors duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]',
  'hover:bg-paper-3 hover:text-ink aria-pressed:bg-ink aria-pressed:text-on-ink aria-pressed:hover:bg-ink-2',
  '[&_svg]:block [&_svg]:size-3.5',
  FOCUS,
);

/** The microphone, in the toolbar's 24-unit stroke (DESIGN.md). The pressed state is the ink fill, not the glyph. */
function MicIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

export function CommentBox(props: CommentBoxProps) {
  const { testid, inputTestid, label, placeholder, hint, ref } = props;
  // The latest callbacks, for handlers that live across renders.
  const latest = useRef(props);
  latest.current = props;
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const [mic, setMic] = useState(false);
  const [listening, setListening] = useState(false);
  const [caption, setCaption] = useState('');
  /** What the handle reads synchronously, between renders. */
  const now = useRef({
    open: false,
    listening: false,
    mounted: true,
    target: null as DictationTarget | null,
    anchor: null as (() => BoxAnchor | null) | null,
    raf: 0,
    lastActivity: 0,
  });

  /** Renders `change` now: callers place, focus and theme what they just opened. */
  const commit = useCallback((change: () => void) => {
    if (now.current.mounted) flushSync(change);
  }, []);

  /** Below the anchor (above it when there is no room), kept on screen, in the theme of the page under it. */
  const place = useCallback(() => {
    const at = now.current.anchor?.();
    const el = box.current;
    if (!at || !el || !now.current.open) return;
    const { rect, align } = at;
    const { width, height } = el.getBoundingClientRect();
    const x = Math.max(
      MARGIN,
      Math.min(align === 'end' ? rect.right - width : rect.left, window.innerWidth - width - MARGIN),
    );
    const below = rect.bottom + GAP;
    const y = below + height + MARGIN <= window.innerHeight ? below : Math.max(MARGIN, rect.top - height - GAP);
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    const theme = latest.current.themeFor?.(new DOMRect(x, y, width, height));
    if (theme) el.dataset.theme = theme;
  }, []);

  const reposition = useCallback(() => {
    if (now.current.raf || !now.current.open) return;
    now.current.raf = requestAnimationFrame(() => {
      now.current.raf = 0;
      place();
    });
  }, [place]);

  const [api] = useState<CommentBoxHandle>(() => {
    const touch = () => {
      now.current.lastActivity = Date.now();
    };
    const self: CommentBoxHandle = {
      open(anchor, target = null) {
        const st = now.current;
        st.anchor = anchor;
        st.target = target;
        if (input.current) input.current.value = '';
        const mode = target ? (dictationHost?.mode() ?? null) : null;
        touch();
        st.open = true;
        commit(() => {
          setMic(mode !== null);
          setOpen(true);
        });
        // Placed now, before the next frame: the box is never painted where it last was (or at the top left).
        place();
        input.current?.focus();
        if (mode === 'auto') self.startDictation();
      },
      close() {
        const st = now.current;
        self.stopDictation();
        st.target = null;
        st.anchor = null;
        st.open = false;
        // Focus left in a hidden box would keep the page's keys (Esc, the mode shortcuts) ours.
        const root = box.current?.getRootNode() as Document | ShadowRoot | undefined;
        if (input.current && root?.activeElement === input.current) input.current.blur();
        commit(() => setOpen(false));
      },
      get isOpen() {
        return now.current.open;
      },
      get text() {
        return input.current?.value.trim().slice(0, MAX_CHARS) || null;
      },
      get lastActivity() {
        return now.current.lastActivity;
      },
      get isDictating() {
        return now.current.listening;
      },
      startDictation() {
        const st = now.current;
        const host = dictationHost;
        if (st.listening || !st.target || !host || !st.open) return;
        if (dictating && dictating !== self) dictating.stopDictation();
        dictating = self;
        st.listening = true;
        touch();
        commit(() => {
          setListening(true);
          setCaption('Listening…');
        });
        host.set(st.target, true);
      },
      stopDictation() {
        const st = now.current;
        if (!st.listening) return;
        st.listening = false;
        if (dictating === self) dictating = null;
        commit(() => {
          setListening(false);
          setCaption('');
        });
        if (st.target) dictationHost?.set(st.target, false);
      },
      receive(words) {
        const st = now.current;
        if (!st.listening || !st.target || !sameTarget(words.target, st.target)) return;
        // Speaking into the box is activity, as typing is (E9).
        touch();
        if (!words.final) {
          commit(() => setCaption(words.text));
          return;
        }
        const text = words.text.trim();
        const field = input.current;
        if (text && field) field.value = field.value.trim() ? `${field.value.trimEnd()} ${text}` : text;
        commit(() => setCaption('Listening…'));
        reposition();
      },
      reposition,
      async hideForCapture(hidden) {
        if (box.current) box.current.style.visibility = hidden ? 'hidden' : '';
        // Even a box that is already closed waits: it may have closed a moment ago (a save), and the last painted
        // frame, the one the screenshot grabs, can still show it.
        if (hidden) await nextPaint();
      },
      get element() {
        return box.current;
      },
    };
    return self;
  });
  useImperativeHandle(ref, () => api, [api]);

  // While open: the scroll and resize that move what the box is beside.
  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', reposition, { passive: true, capture: true });
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, { capture: true });
      window.removeEventListener('resize', reposition);
      cancelAnimationFrame(now.current.raf);
      now.current.raf = 0;
    };
  }, [open, reposition]);

  // Unmounted (the host leaves, or the caller removed the surface): the speech it took goes back to the Session.
  useEffect(() => {
    const st = now.current;
    st.mounted = true;
    return () => {
      st.mounted = false;
      st.open = false;
      if (st.listening) {
        st.listening = false;
        if (dictating === api) dictating = null;
        if (st.target) dictationHost?.set(st.target, false);
      }
    };
  }, [api]);

  // keypress has no React event for a key without a character, so it is stopped on the element itself.
  useEffect(() => {
    const el = box.current;
    const stop = (e: Event) => e.stopPropagation();
    el?.addEventListener('keypress', stop);
    return () => el?.removeEventListener('keypress', stop);
  }, []);

  const onFieldKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      latest.current.onCancel();
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      // One line: Enter, with or without Shift, saves.
      e.preventDefault();
      const text = api.text;
      if (text || latest.current.allowEmpty) latest.current.onSave(text);
    }
  };

  return (
    <div
      ref={box}
      role="dialog"
      aria-label={label}
      data-testid={testid}
      data-island=""
      hidden={!open}
      className={BOX}
      // Typing here is ours: the page's shortcuts must not see it.
      onKeyDown={(e) => {
        e.stopPropagation();
        now.current.lastActivity = Date.now();
      }}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        <textarea
          ref={input}
          rows={1}
          aria-label="Comment"
          placeholder={placeholder}
          data-testid={inputTestid}
          className={FIELD}
          onKeyDown={onFieldKey}
          onInput={() => {
            now.current.lastActivity = Date.now();
          }}
        />
        <button
          type="button"
          hidden={!mic}
          data-testid={`${testid}-mic`}
          aria-pressed={listening}
          aria-label={listening ? 'Stop dictating (type instead)' : 'Dictate'}
          className={MIC_BUTTON}
          // Keep the caret in the text while the button toggles.
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            if (now.current.listening) api.stopDictation();
            else api.startDictation();
            input.current?.focus();
          }}
        >
          <MicIcon />
        </button>
      </div>
      <div
        hidden={!listening}
        aria-live="polite"
        data-testid={`${testid}-caption`}
        className="min-h-[1.2em] px-0.5 text-xs font-normal text-pretty text-ink-2 italic"
      >
        {caption}
      </div>
      <span className="px-0.5 text-xs font-normal text-muted-foreground">{hint}</span>
    </div>
  );
}

export type MountedCommentBox = CommentBoxHandle & {
  /** Removes the box from the overlay's React root (and stops its dictation). */
  destroy(): void;
};

/** Renders a box into the overlay host's React root as the surface `opts.testid`, and returns its handle. */
export function mountCommentBox(surfaces: Surfaces, opts: CommentBoxOptions, key = opts.testid): MountedCommentBox {
  const ref: { current: CommentBoxHandle | null } = { current: null };
  surfaces.set(key, <CommentBox {...opts} ref={ref} />);
  const handle = ref.current;
  if (!handle) throw new Error('the comment box did not mount');
  return Object.assign(Object.create(handle) as CommentBoxHandle, {
    destroy() {
      handle.stopDictation();
      surfaces.set(key, null);
    },
  });
}
