// E11: comment-box dictation. In 'auto' a box opened for a target dictates at once; in 'push' only while its mic
// button is on. Interim words show as a caption, final ones are appended to the text; words for another target (a
// box closed since) are ignored; closing stops the dictation. Without voice (no mode) the box has no mic button.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentBox, connectDictation, type DictationHost, receiveDictation } from '@/content/comment-box';
import type { BoxDictation } from '@/settings';

describe('CommentBox dictation', () => {
  let container: HTMLElement;
  let mode: BoxDictation | null;
  let host: { mode: DictationHost['mode']; set: ReturnType<typeof vi.fn<DictationHost['set']>> };
  const anchor = () => ({ rect: new DOMRect(10, 10, 100, 20), align: 'start' as const });
  const target = { annotation_id: 'a1' };

  function box(): CommentBox {
    return new CommentBox(container, {
      testid: 'b',
      inputTestid: 'b-input',
      label: 'x',
      placeholder: 'x',
      hint: 'x',
      allowEmpty: true,
      onSave: vi.fn(),
      onCancel: vi.fn(),
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    mode = 'auto';
    host = { mode: () => mode, set: vi.fn<DictationHost['set']>() };
    connectDictation(host);
  });
  afterEach(() => {
    connectDictation(null);
    container.remove();
  });

  it('auto: dictates from the moment it opens; interim words show, finals are appended; the mic button switches to typing', () => {
    const b = box();
    b.input.value = '';
    b.open(anchor, target);
    expect(host.set).toHaveBeenLastCalledWith(target, true);
    expect(b.mic.hidden).toBe(false);
    expect(b.mic.getAttribute('aria-pressed')).toBe('true');
    receiveDictation({ target, text: 'make this', final: false });
    expect(b.caption.textContent).toBe('make this');
    expect(b.input.value).toBe('');
    receiveDictation({ target, text: 'make this roomier', final: true });
    expect(b.input.value).toBe('make this roomier');
    // Words for another box (closed since) go nowhere.
    receiveDictation({ target: { comment_id: 'c9' }, text: 'stray', final: true });
    expect(b.input.value).toBe('make this roomier');
    b.mic.click();
    expect(host.set).toHaveBeenLastCalledWith(target, false);
    expect(b.caption.hidden).toBe(true);
    receiveDictation({ target, text: 'late', final: true });
    expect(b.input.value).toBe('make this roomier');
  });

  it('push: nothing until the mic button is on; closing turns it off', () => {
    mode = 'push';
    const b = box();
    b.open(anchor, target);
    expect(host.set).not.toHaveBeenCalled();
    receiveDictation({ target, text: 'ignored', final: true });
    expect(b.input.value).toBe('');
    b.mic.click();
    expect(host.set).toHaveBeenLastCalledWith(target, true);
    receiveDictation({ target, text: 'say Pricing plans', final: true });
    expect(b.input.value).toBe('say Pricing plans');
    b.close();
    expect(host.set).toHaveBeenLastCalledWith(target, false);
    expect(b.isDictating).toBe(false);
  });

  it('without voice, or without a target, there is no mic button', () => {
    mode = null;
    const b = box();
    b.open(anchor, target);
    expect(b.mic.hidden).toBe(true);
    b.close();
    mode = 'auto';
    b.open(anchor);
    expect(b.mic.hidden).toBe(true);
    expect(host.set).not.toHaveBeenCalled();
  });

  it('one box dictates at a time', () => {
    const a = box();
    const b = box();
    a.open(anchor, target);
    b.open(anchor, { comment_id: 'c1' });
    expect(a.isDictating).toBe(false);
    expect(b.isDictating).toBe(true);
    expect(host.set.mock.calls).toEqual([
      [target, true],
      [target, false],
      [{ comment_id: 'c1' }, true],
    ]);
  });
});

// A box is placed as it opens, not on the next animation frame: until then it would show where it last was, or at the
// top left of the page.
describe('CommentBox placement', () => {
  it('sits under its anchor as soon as it opens', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const b = new CommentBox(container, {
      testid: 'b',
      inputTestid: 'b-input',
      label: 'x',
      placeholder: 'x',
      hint: 'x',
      onSave: vi.fn(),
      onCancel: vi.fn(),
    });
    b.open(() => ({ rect: new DOMRect(40, 100, 120, 30), align: 'start' }));
    expect(b.box.style.left).toBe('40px');
    expect(b.box.style.top).toBe('136px');
    container.remove();
  });
});
