// The comment box and the draw note as the extension renders them: through the overlay host's React root
// (mountSurfaces), driven through their handles. Enter submits and Esc drops (and the page never sees the keys), the box
// opens beside its anchor clamped to the viewport and takes the caret only while it is open, E11 dictation (auto, push,
// the live caption, words for another target, one box at a time), the box's own theme, hiding for a capture, and the
// draw note's promise: Enter, Esc, a press elsewhere, the overlay cap, Clear all and leaving.
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BoxAnchor,
  type CommentBoxOptions,
  connectDictation,
  type DictationHost,
  type MountedCommentBox,
  type MountedDrawNote,
  mountCommentBox,
  mountDrawNote,
  receiveDictation,
} from '../src/comment-box';
import { mountSurfaces, type Surfaces } from '../src/toolbar';

const target = { annotation_id: 'a1' };
const anchor = (): BoxAnchor => ({ rect: new DOMRect(10, 10, 100, 20), align: 'start' });

let container: HTMLElement;
let surfaces: Surfaces;
let mode: 'auto' | 'push' | null;
let host: { mode: DictationHost['mode']; set: ReturnType<typeof vi.fn<DictationHost['set']>> };

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  surfaces = mountSurfaces(container);
  mode = 'push';
  host = { mode: () => mode, set: vi.fn<DictationHost['set']>() };
  connectDictation(host);
});
afterEach(() => {
  connectDictation(null);
  surfaces.unmount();
  container.remove();
  cleanup();
  vi.restoreAllMocks();
});

function box(over: Partial<CommentBoxOptions> = {}): MountedCommentBox {
  return mountCommentBox(surfaces, {
    testid: 'b',
    inputTestid: 'b-input',
    label: 'Comment on the picked element',
    placeholder: 'What should change?',
    hint: 'Enter to save · Esc to drop',
    onSave: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  });
}
const field = () => screen.getByTestId('b-input') as HTMLTextAreaElement;
const dialog = () => screen.getByTestId('b');
const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(field(), { key, ...init });
const type = (text: string) => {
  field().value = text;
  fireEvent.input(field());
};

describe('CommentBox: Enter submits, Esc drops', () => {
  it('Enter saves the trimmed text and Esc cancels', () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const b = box({ onSave, onCancel });
    b.open(anchor);
    type('  Make this bigger ');
    press('Enter');
    expect(onSave).toHaveBeenCalledExactlyOnceWith('Make this bigger');
    press('Escape');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Enter with Shift saves too (one line), and Enter while composing does not', () => {
    const onSave = vi.fn();
    const b = box({ onSave });
    b.open(anchor);
    type('x');
    press('Enter', { shiftKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);
    press('Enter', { isComposing: true });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('Enter with nothing typed does nothing, unless the box allows empty (then null)', () => {
    const onSave = vi.fn();
    const b = box({ onSave });
    b.open(anchor);
    press('Enter');
    expect(onSave).not.toHaveBeenCalled();
    b.destroy();
    const empty = vi.fn();
    const c = box({ onSave: empty, allowEmpty: true });
    c.open(anchor);
    press('Enter');
    expect(empty).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('the text is cut at 2000 characters', () => {
    const b = box();
    b.open(anchor);
    type('a'.repeat(2500));
    expect(b.text).toHaveLength(2000);
  });

  it('keys typed in the box never reach the page', () => {
    const seen = vi.fn();
    for (const type of ['keydown', 'keyup', 'keypress']) document.addEventListener(type, seen);
    const b = box();
    b.open(anchor);
    for (const type of ['keydown', 'keyup', 'keypress'])
      fireEvent(field(), new KeyboardEvent(type, { key: 'a', bubbles: true }));
    expect(seen).not.toHaveBeenCalled();
    for (const type of ['keydown', 'keyup', 'keypress']) document.removeEventListener(type, seen);
  });
});

describe('CommentBox: where it opens, and the focus', () => {
  it('is closed until opened, with the same names, placeholder and hint', () => {
    const b = box();
    expect(dialog().hidden).toBe(true);
    expect(dialog().getAttribute('aria-label')).toBe('Comment on the picked element');
    expect(dialog().getAttribute('role')).toBe('dialog');
    expect(field().placeholder).toBe('What should change?');
    expect(screen.getByText('Enter to save · Esc to drop')).toBeTruthy();
    b.open(anchor);
    expect(screen.getByRole('dialog', { name: 'Comment on the picked element' })).toBe(dialog());
    expect(screen.getByRole('textbox', { name: 'Comment' })).toBe(field());
  });

  it('sits under its anchor as soon as it opens, the caret in the text', () => {
    const b = box();
    b.open(() => ({ rect: new DOMRect(40, 100, 120, 30), align: 'start' }));
    expect(b.isOpen).toBe(true);
    expect(dialog().hidden).toBe(false);
    expect(dialog().style.left).toBe('40px');
    expect(dialog().style.top).toBe('136px');
    expect(document.activeElement).toBe(field());
  });

  it('is clamped to the viewport, and goes above an anchor with no room below', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 60));
    const b = box();
    b.open(() => ({ rect: new DOMRect(window.innerWidth - 10, window.innerHeight - 20, 10, 10), align: 'start' }));
    expect(dialog().style.left).toBe(`${window.innerWidth - 300 - 8}px`);
    expect(dialog().style.top).toBe(`${window.innerHeight - 20 - 60 - 6}px`);
    // Lined up by its right edge, kept off the left edge.
    b.open(() => ({ rect: new DOMRect(0, 10, 100, 20), align: 'end' }));
    expect(dialog().style.left).toBe('8px');
  });

  it('closes, and gives the caret back: no InkUp element keeps the focus', () => {
    const b = box();
    b.open(anchor);
    b.close();
    expect(b.isOpen).toBe(false);
    expect(dialog().hidden).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });

  it('opening empties what was typed before', () => {
    const b = box();
    b.open(anchor);
    type('first');
    b.close();
    b.open(anchor);
    expect(b.text).toBeNull();
  });

  it("wears the theme of the page under it, and none (the host's) without one", () => {
    const themeFor = vi.fn(() => 'light' as const);
    const b = box({ themeFor });
    b.open(anchor);
    expect(dialog().dataset.theme).toBe('light');
    expect(themeFor).toHaveBeenCalledWith(expect.any(DOMRect));
    b.destroy();
    const plain = box();
    plain.open(anchor);
    expect(dialog().dataset.theme).toBeUndefined();
  });

  it('hides for a capture and waits for a painted frame', async () => {
    const b = box();
    b.open(anchor);
    await act(() => b.hideForCapture(true));
    expect(dialog().style.visibility).toBe('hidden');
    await act(() => b.hideForCapture(false));
    expect(dialog().style.visibility).toBe('');
  });

  it('is removed with destroy, and its dictation stops', () => {
    const b = box();
    b.open(anchor, target);
    b.startDictation();
    b.destroy();
    expect(screen.queryByTestId('b')).toBeNull();
    expect(host.set).toHaveBeenLastCalledWith(target, false);
  });
});

describe('CommentBox: dictation (E11)', () => {
  const mic = () => screen.getByTestId('b-mic');
  const caption = () => screen.getByTestId('b-caption');

  it('push: the mic toggles, the caption follows what is said, the text keeps what was dictated', () => {
    const b = box();
    b.open(anchor, target);
    expect(host.set).not.toHaveBeenCalled();
    expect(mic().hidden).toBe(false);
    expect(mic().getAttribute('aria-label')).toBe('Dictate');
    expect(mic().getAttribute('aria-pressed')).toBe('false');
    expect(caption().hidden).toBe(true);
    receiveDictation({ target, text: 'ignored', final: true });
    expect(field().value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }));
    expect(host.set).toHaveBeenLastCalledWith(target, true);
    expect(mic().getAttribute('aria-label')).toBe('Stop dictating (type instead)');
    expect(mic().getAttribute('aria-pressed')).toBe('true');
    expect(caption().hidden).toBe(false);
    expect(caption().textContent).toBe('Listening…');
    expect(document.activeElement).toBe(field());

    act(() => receiveDictation({ target, text: 'change the', final: false }));
    expect(caption().textContent).toBe('change the');
    expect(field().value).toBe('');
    act(() => receiveDictation({ target, text: 'change the colour', final: true }));
    expect(field().value).toBe('change the colour');
    expect(caption().textContent).toBe('Listening…');
    act(() => receiveDictation({ target, text: 'and the size', final: true }));
    expect(field().value).toBe('change the colour and the size');

    fireEvent.click(screen.getByRole('button', { name: 'Stop dictating (type instead)' }));
    expect(host.set).toHaveBeenLastCalledWith(target, false);
    expect(mic().getAttribute('aria-label')).toBe('Dictate');
    expect(caption().hidden).toBe(true);
    expect(caption().textContent).toBe('');
    expect(field().value).toBe('change the colour and the size');
    act(() => receiveDictation({ target, text: 'late', final: true }));
    expect(field().value).toBe('change the colour and the size');
    expect(b.isDictating).toBe(false);
  });

  it('auto: dictates from the moment it opens; words for another target go nowhere', () => {
    mode = 'auto';
    const b = box();
    b.open(anchor, target);
    expect(host.set).toHaveBeenLastCalledWith(target, true);
    expect(mic().getAttribute('aria-pressed')).toBe('true');
    act(() => receiveDictation({ target: { comment_id: 'c9' }, text: 'stray', final: true }));
    expect(field().value).toBe('');
    act(() => receiveDictation({ target, text: 'make this roomier', final: true }));
    expect(field().value).toBe('make this roomier');
  });

  it('closing turns it off', () => {
    const b = box();
    b.open(anchor, target);
    b.startDictation();
    b.close();
    expect(host.set).toHaveBeenLastCalledWith(target, false);
    expect(b.isDictating).toBe(false);
    expect(caption().hidden).toBe(true);
  });

  it('without voice, or without a target, there is no mic button', () => {
    mode = null;
    const b = box();
    b.open(anchor, target);
    expect(mic().hidden).toBe(true);
    b.close();
    mode = 'auto';
    b.open(anchor);
    expect(mic().hidden).toBe(true);
    b.startDictation();
    expect(host.set).not.toHaveBeenCalled();
  });

  it('one box dictates at a time', () => {
    const a = box();
    const other = box({ testid: 'c', inputTestid: 'c-input' });
    a.open(anchor, target);
    other.open(anchor, { comment_id: 'c1' });
    a.startDictation();
    other.startDictation();
    expect(a.isDictating).toBe(false);
    expect(other.isDictating).toBe(true);
    expect(host.set.mock.calls).toEqual([
      [target, true],
      [target, false],
      [{ comment_id: 'c1' }, true],
    ]);
  });

  it('speaking into the box is activity, as typing is', () => {
    const b = box();
    b.open(anchor, target);
    b.startDictation();
    const opened = b.lastActivity;
    vi.spyOn(Date, 'now').mockReturnValue(opened + 5_000);
    act(() => receiveDictation({ target, text: 'hello', final: false }));
    expect(b.lastActivity).toBe(opened + 5_000);
  });
});

describe('DrawNote', () => {
  let note: MountedDrawNote;
  const bbox = { x: 20, y: 30, width: 80, height: 40 };
  const noteField = () => screen.getByTestId('annotation-note-input') as HTMLTextAreaElement;
  const noteBox = () => screen.getByTestId('annotation-note-box');
  const write = (text: string) => {
    noteField().value = text;
    fireEvent.input(noteField());
  };

  beforeEach(() => {
    note = mountDrawNote(surfaces);
  });

  it('asks beside the Annotation with its own words, and Enter resolves with the note', async () => {
    const asked = note.ask(bbox);
    expect(note.isOpen).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Note on the drawn Annotation' })).toBe(noteBox());
    expect(noteField().placeholder).toBe('What should change here?');
    expect(screen.getByText('Enter to save · Esc to skip')).toBeTruthy();
    expect(noteBox().style.left).toBe('20px');
    expect(document.activeElement).toBe(noteField());
    write('Align these');
    fireEvent.keyDown(noteField(), { key: 'Enter' });
    await expect(asked).resolves.toBe('Align these');
    expect(note.isOpen).toBe(false);
    expect(noteBox().hidden).toBe(true);
  });

  it('Enter with nothing typed, or Esc, skips the note', async () => {
    const empty = note.ask(bbox);
    fireEvent.keyDown(noteField(), { key: 'Enter' });
    await expect(empty).resolves.toBeNull();
    const skipped = note.ask(bbox);
    write('typed, then dropped');
    fireEvent.keyDown(noteField(), { key: 'Escape' });
    await expect(skipped).resolves.toBeNull();
    expect(note.isOpen).toBe(false);
  });

  it('a press anywhere else takes what was typed; a press in the note does not', async () => {
    const asked = note.ask(bbox);
    write('half');
    fireEvent.pointerDown(noteField());
    expect(note.isOpen).toBe(true);
    const page = document.createElement('p');
    document.body.append(page);
    fireEvent.pointerDown(page);
    await expect(asked).resolves.toBe('half');
    page.remove();
  });

  it('flush takes what was typed (Stop, a pause, a pick), and a new ask settles the one before it', async () => {
    const first = note.ask(bbox);
    write('one');
    const second = note.ask(bbox);
    await expect(first).resolves.toBe('one');
    write('two');
    note.flush();
    await expect(second).resolves.toBe('two');
    note.flush();
    expect(note.isOpen).toBe(false);
  });

  it('the overlay cap records what was typed once the box has been idle that long', async () => {
    const asked = note.ask(bbox);
    write('idle');
    const t = Date.now();
    note.sweep(t + 1_000, 60_000);
    expect(note.isOpen).toBe(true);
    note.sweep(t + 61_000, 60_000);
    await expect(asked).resolves.toBe('idle');
  });

  it('Clear all closes it with no note and says how many boxes it closed', async () => {
    expect(note.clear()).toBe(0);
    const asked = note.ask(bbox);
    write('gone');
    expect(note.clear()).toBe(1);
    await expect(asked).resolves.toBeNull();
  });

  it('destroy records what was typed, and removes the box', async () => {
    const asked = note.ask(bbox);
    write('last words');
    note.destroy();
    await expect(asked).resolves.toBe('last words');
    expect(screen.queryByTestId('annotation-note-box')).toBeNull();
  });

  it('the host leaving with a note asked for records the Annotation without one', async () => {
    const asked = note.ask(bbox);
    surfaces.unmount();
    await expect(asked).resolves.toBeNull();
  });

  it('hides for a capture', async () => {
    note.ask(bbox);
    await act(() => note.hideForCapture(true));
    expect(noteBox().style.visibility).toBe('hidden');
    await act(() => note.hideForCapture(false));
  });
});
