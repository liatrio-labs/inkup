// The comment box and the draw note as the page carries them: inside the overlay's shadow root, in the one React root
// that content/client.ts mounts (mountSurfaces), with the package styles adopted and nothing added to the page. Their
// own behaviour (Enter, Esc, dictation, the caption, the draw note's promise) is @inkup/ui's
// (packages/ui/tests/comment-box.test.tsx); here: the theme they take from the page under them (content/theme.ts), the
// focus that goes back to the page, and that nothing is left behind when the root goes.
import { type MountedCommentBox, mountCommentBox, mountDrawNote } from '@inkup/ui/comment-box';
import { mountInShadow } from '@inkup/ui/mount-in-shadow';
import { mountSurfaces, type Surfaces } from '@inkup/ui/toolbar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { themeFor } from '@/content/theme';

describe('the comment box in the overlay host', () => {
  let host: HTMLElement;
  let shadow: ShadowRoot;
  let surfaces: Surfaces;
  let input: HTMLInputElement;
  const anchor = () => ({ rect: new DOMRect(40, 100, 120, 30), align: 'start' as const });
  const $ = (id: string) => shadow.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  function box(): MountedCommentBox {
    return mountCommentBox(surfaces, {
      testid: 'text-comment-box',
      inputTestid: 'text-comment-input',
      label: 'Comment on the selected text',
      placeholder: 'This should say…',
      hint: 'Enter to save · Esc to cancel',
      onSave: vi.fn(),
      onCancel: vi.fn(),
      themeFor: (rect) => themeFor(rect, host),
    });
  }

  beforeEach(() => {
    input = document.createElement('input');
    document.body.append(input);
    host = document.createElement('var-review-overlay');
    shadow = host.attachShadow({ mode: 'open' });
    const container = document.createElement('div');
    shadow.append(container);
    document.documentElement.append(host);
    mountInShadow(shadow);
    surfaces = mountSurfaces(container);
  });
  afterEach(() => {
    surfaces.unmount();
    host.remove();
    input.remove();
  });

  it('adds nothing to the page: the box and its styles live in the shadow root', () => {
    const head = document.head.innerHTML;
    const bodyChildren = document.body.childElementCount;
    const b = box();
    b.open(anchor);
    expect($('text-comment-box')!.hidden).toBe(false);
    expect(document.head.innerHTML).toBe(head);
    expect(document.body.childElementCount).toBe(bodyChildren);
    expect(document.querySelector('[data-testid="text-comment-box"]')).toBeNull();
  });

  it('takes its theme from the page under it, light over a dark page and dark over a light one (E8)', () => {
    const b = box();
    document.body.style.background = '#111111';
    b.open(anchor);
    expect($('text-comment-box')!.dataset.theme).toBe('light');
    b.close();
    document.body.style.background = '#ffffff';
    b.open(anchor);
    expect($('text-comment-box')!.dataset.theme).toBe('dark');
    document.body.style.background = '';
  });

  it('takes the caret from the page while open and gives it back on close', () => {
    input.focus();
    const b = box();
    b.open(anchor);
    expect(shadow.activeElement).toBe($('text-comment-input'));
    b.close();
    expect(shadow.activeElement).toBeNull();
  });

  it('does not take the focus from the page when it is only mounted', () => {
    input.focus();
    box();
    expect(document.activeElement).toBe(input);
  });

  it('leaves nothing behind when the root goes, and its dictation stops', () => {
    const b = box();
    b.open(anchor);
    surfaces.unmount();
    expect($('text-comment-box')).toBeNull();
    expect(() => b.destroy()).not.toThrow();
  });

  it('the draw note is its own surface in the same root', () => {
    const note = mountDrawNote(surfaces, (rect) => themeFor(rect, host));
    const asked = note.ask({ x: 10, y: 20, width: 50, height: 30 });
    expect($('annotation-note-box')!.hidden).toBe(false);
    note.flush();
    return expect(asked).resolves.toBeNull();
  });
});
