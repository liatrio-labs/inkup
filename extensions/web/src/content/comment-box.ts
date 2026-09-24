// The small one-line comment box that Select Text and Object Select open next to what the reviewer chose (E3, E7).
// Enter saves, Esc cancels. It lives in the overlay's shadow root, so snapshots and click capture skip it, and it
// hides for every screenshot like the toolbar. Keys typed in it never reach the page's shortcuts. Its theme follows the
// page under it (./theme.ts).
//
// Dictation (E11): a box opened for a target (the Annotation or Text Comment it is about) in a Session with voice has
// a mic button. In 'auto' it dictates from the moment it opens, in 'push' only while the button is on; while it
// dictates, what is said shows as a live caption under the text and final words are appended to it, and the service
// worker keeps that speech out of the Session transcript and Voice Commands. One box dictates at a time.
import type { DictationTarget } from '@inkup/core/timeline';
import type { DictationText } from '@/messaging';
import type { BoxDictation } from '@/settings';
import { nextPaint } from './paint';
import { themeFor } from './theme';

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
}

const GAP = 6;

/** The page's side of dictation: how boxes take speech now, and turning it on or off for a target. */
export interface DictationHost {
  /** Null: the Session has no voice, so boxes have no mic button. */
  mode(): BoxDictation | null;
  set(target: DictationTarget, on: boolean): void;
}

let dictationHost: DictationHost | null = null;
/** The box dictating now, if any. */
let dictating: CommentBox | null = null;

export function connectDictation(host: DictationHost | null): void {
  dictationHost = host;
  if (!host) dictating?.stopDictation();
}

/** Words from the service worker for the dictating box; ignored when it is about another target (closed since). */
export function receiveDictation(d: DictationText): void {
  dictating?.receive(d);
}

const sameTarget = (a: DictationTarget, b: DictationTarget) => JSON.stringify(a) === JSON.stringify(b);

const MIC = (on: boolean) =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>${on ? '' : '<path d="M4 4l16 16"/>'}</svg>`;

const CSS = `
.var-cb { all: initial; position: fixed; z-index: 2; pointer-events: auto; box-sizing: border-box; display: flex; flex-direction: column;
  gap: 4px; padding: 6px; border-radius: 10px; width: 300px; font: 500 12px/1.2 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: #f4f4f5; background: #18181b; box-shadow: 0 4px 16px rgba(0,0,0,.28), 0 0 0 1px rgba(255,255,255,.08); }
.var-cb-input { all: unset; box-sizing: border-box; display: block; width: 100%; resize: none; overflow: hidden; white-space: nowrap;
  padding: 6px 8px; border-radius: 6px; background: #27272a; color: #f4f4f5; font: 400 13px/1.3 ui-sans-serif, system-ui, sans-serif; }
.var-cb-input:focus-visible { outline: 2px solid #60a5fa; outline-offset: 1px; }
.var-cb-input::placeholder { color: #a1a1aa; }
.var-cb-hint { color: #a1a1aa; font-size: 11px; padding: 0 2px; }
.var-cb-row { display: flex; gap: 4px; align-items: center; }
.var-cb-row > .var-cb-input { flex: 1 1 auto; min-width: 0; }
.var-cb-mic { all: unset; box-sizing: border-box; flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 6px;
  cursor: pointer; color: #a1a1aa; background: #27272a; }
.var-cb-mic[aria-pressed='true'] { color: #fff; background: #dc2626; }
.var-cb-mic:focus-visible { outline: 2px solid #60a5fa; outline-offset: 1px; }
.var-cb-caption { color: #d4d4d8; font-style: italic; font-size: 12px; padding: 0 2px; min-height: 1.2em; }
.var-cb[hidden], .var-cb-mic[hidden], .var-cb-caption[hidden] { display: none !important; }
/* The light theme, over dark pages (E8). */
.var-cb[data-theme="light"] { color: #18181b; background: #fafafa; box-shadow: 0 4px 16px rgba(0,0,0,.35), 0 0 0 1px rgba(0,0,0,.12); }
.var-cb[data-theme="light"] .var-cb-input { background: #e4e4e7; color: #18181b; }
.var-cb[data-theme="light"] .var-cb-input:focus-visible { outline-color: #2563eb; }
.var-cb[data-theme="light"] .var-cb-input::placeholder, .var-cb[data-theme="light"] .var-cb-hint { color: #52525b; }
.var-cb[data-theme="light"] .var-cb-mic { color: #52525b; background: #e4e4e7; }
.var-cb[data-theme="light"] .var-cb-mic[aria-pressed='true'] { color: #fff; background: #dc2626; }
.var-cb[data-theme="light"] .var-cb-caption { color: #3f3f46; }
`;

export class CommentBox {
  private readonly style: HTMLStyleElement;
  readonly box: HTMLDivElement;
  readonly input: HTMLTextAreaElement;
  /** Where the box goes: the rectangle it is about, and which of its edges the box lines up with. */
  private anchor: (() => { rect: DOMRect; align: 'start' | 'end' } | null) | null = null;
  private raf = 0;
  readonly mic: HTMLButtonElement;
  readonly caption: HTMLDivElement;
  /** What this box is about, for dictation; null: no dictation. */
  private target: DictationTarget | null = null;
  private listening = false;

  constructor(
    container: HTMLElement,
    private readonly opts: CommentBoxOptions,
  ) {
    this.style = document.createElement('style');
    this.style.textContent = CSS;
    this.box = document.createElement('div');
    Object.assign(this.box, { className: 'var-cb', hidden: true });
    this.box.dataset.testid = opts.testid;
    this.box.setAttribute('role', 'dialog');
    this.box.setAttribute('aria-label', opts.label);
    this.input = document.createElement('textarea');
    Object.assign(this.input, { className: 'var-cb-input', rows: 1, placeholder: opts.placeholder });
    this.input.dataset.testid = opts.inputTestid;
    this.input.setAttribute('aria-label', 'Comment');
    this.mic = document.createElement('button');
    Object.assign(this.mic, { type: 'button', className: 'var-cb-mic', hidden: true, innerHTML: MIC(false) });
    this.mic.dataset.testid = `${opts.testid}-mic`;
    this.mic.setAttribute('aria-pressed', 'false');
    this.mic.setAttribute('aria-label', 'Dictate');
    // Keep the caret in the text while the button toggles.
    this.mic.addEventListener('pointerdown', (e) => e.preventDefault());
    this.mic.addEventListener('click', () => {
      if (this.listening) this.stopDictation();
      else this.startDictation();
      this.input.focus();
    });
    const row = document.createElement('div');
    row.className = 'var-cb-row';
    row.append(this.input, this.mic);
    this.caption = document.createElement('div');
    Object.assign(this.caption, { className: 'var-cb-caption', hidden: true });
    this.caption.dataset.testid = `${opts.testid}-caption`;
    this.caption.setAttribute('aria-live', 'polite');
    const hint = document.createElement('span');
    Object.assign(hint, { className: 'var-cb-hint', textContent: opts.hint });
    this.box.append(row, this.caption, hint);
    container.append(this.style, this.box);
    this.input.addEventListener('keydown', this.onKey);
    // Typing here is ours: the page's shortcuts must not see it.
    for (const type of ['keydown', 'keyup', 'keypress'] as const)
      this.box.addEventListener(type, (e) => e.stopPropagation());
    this.box.addEventListener('keydown', () => (this.lastActivity = Date.now()));
    this.input.addEventListener('input', () => (this.lastActivity = Date.now()));
    window.addEventListener('scroll', this.reposition, { passive: true, capture: true });
    window.addEventListener('resize', this.reposition);
  }

  /** Epoch ms of the box's last activity (opened, typed in): the overlay cap counts from it (E9). */
  lastActivity = 0;

  get isOpen(): boolean {
    return !this.box.hidden;
  }

  /** The text typed so far, trimmed; null when empty. */
  get text(): string | null {
    return this.input.value.trim().slice(0, 2000) || null;
  }

  /** `target`: what the box is about, so what is said into it can be tagged (E11); without one it only takes typing. */
  open(anchor: () => { rect: DOMRect; align: 'start' | 'end' } | null, target: DictationTarget | null = null): void {
    this.anchor = anchor;
    this.input.value = '';
    this.target = target;
    const mode = target ? (dictationHost?.mode() ?? null) : null;
    this.mic.hidden = mode === null;
    this.lastActivity = Date.now();
    this.box.hidden = false;
    this.reposition();
    this.input.focus();
    if (mode === 'auto') this.startDictation();
  }

  /** Dictating into this box right now. */
  get isDictating(): boolean {
    return this.listening;
  }

  startDictation(): void {
    if (this.listening || !this.target || !dictationHost || this.box.hidden) return;
    if (dictating && dictating !== this) dictating.stopDictation();
    dictating = this;
    this.listening = true;
    this.lastActivity = Date.now();
    this.mic.setAttribute('aria-pressed', 'true');
    this.mic.setAttribute('aria-label', 'Stop dictating (type instead)');
    this.mic.innerHTML = MIC(true);
    this.caption.textContent = 'Listening…';
    this.caption.hidden = false;
    dictationHost.set(this.target, true);
  }

  stopDictation(): void {
    if (!this.listening) return;
    this.listening = false;
    if (dictating === this) dictating = null;
    this.mic.setAttribute('aria-pressed', 'false');
    this.mic.setAttribute('aria-label', 'Dictate');
    this.mic.innerHTML = MIC(false);
    this.caption.hidden = true;
    this.caption.textContent = '';
    if (this.target) dictationHost?.set(this.target, false);
  }

  /** Dictated words: a final one is appended to the text, an interim one only shown. */
  receive(d: DictationText): void {
    if (!this.listening || !this.target || !sameTarget(d.target, this.target)) return;
    // Speaking into the box is activity, as typing is (E9).
    this.lastActivity = Date.now();
    if (!d.final) {
      this.caption.textContent = d.text;
      return;
    }
    const text = d.text.trim();
    if (text) this.input.value = this.input.value.trim() ? `${this.input.value.trimEnd()} ${text}` : text;
    this.caption.textContent = 'Listening…';
    this.reposition();
  }

  close(): void {
    this.stopDictation();
    this.target = null;
    this.anchor = null;
    // Focus left in a hidden box would keep the page's keys (Esc, the mode shortcuts) ours.
    if (this.box.matches(':focus-within')) this.input.blur();
    this.box.hidden = true;
  }

  /** Off screen for a screenshot (resolves once a frame without it has been painted), or back. */
  async hideForCapture(hidden: boolean): Promise<void> {
    this.box.style.visibility = hidden ? 'hidden' : '';
    // Even a box that is already closed waits: it may have closed a moment ago (a save), and the last painted frame,
    // the one the screenshot grabs, can still show it.
    if (hidden) await nextPaint();
  }

  destroy(): void {
    this.stopDictation();
    cancelAnimationFrame(this.raf);
    window.removeEventListener('scroll', this.reposition, { capture: true });
    window.removeEventListener('resize', this.reposition);
    this.style.remove();
    this.box.remove();
  }

  /** Below the anchor (above it when there is no room), kept on screen. */
  reposition = () => {
    if (this.raf || this.box.hidden) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const at = this.anchor?.();
      if (!at || this.box.hidden) return;
      const { rect, align } = at;
      const { width, height } = this.box.getBoundingClientRect();
      const x = Math.max(8, Math.min(align === 'end' ? rect.right - width : rect.left, window.innerWidth - width - 8));
      const below = rect.bottom + GAP;
      const y = below + height + 8 <= window.innerHeight ? below : Math.max(8, rect.top - height - GAP);
      this.box.style.left = `${Math.round(x)}px`;
      this.box.style.top = `${Math.round(y)}px`;
      // Light over a dark page, dark over a light one (E8).
      const host = (this.box.getRootNode() as ShadowRoot).host;
      if (host) this.box.dataset.theme = themeFor(new DOMRect(x, y, width, height), host);
    });
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.opts.onCancel();
    } else if (e.key === 'Enter' && !e.isComposing) {
      // One line: Enter, with or without Shift, saves.
      e.preventDefault();
      const text = this.text;
      if (text || this.opts.allowEmpty) this.opts.onSave(text);
    }
  };
}
