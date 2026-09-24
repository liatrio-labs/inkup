// F1 check (a): the Text Comment box opens a turn after the release (setTimeout(open, 0)) and its input takes focus,
// which takes the page's selection away. What is recorded is still the selected heading: the anchor's `exact`, the
// selected text, and the selection put back on the page for the screenshot while the record goes out. A selection
// that changes between the release and the box opening is the one the box records. (In real Chrome,
// tests/e2e/text-comment.spec.ts asserts the same anchor on the recorded event.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextCommentUi } from '@/content/text-comment';
import type { ContentSessionState, TextCommentInput } from '@/messaging';

const HEADING = 'Ship reviews in minutes';

describe('Text Comment focus race', () => {
  let host: HTMLElement;
  let heading: HTMLElement;
  let ui: TextCommentUi;
  let recorded: { input: TextCommentInput; selection: string }[];

  const state: ContentSessionState = {
    session_id: 's1',
    t0: Date.now() - 10_000,
    draw_mode: false,
    select_mode: 'text',
    fade_ms: 1500,
    paused: false,
    muted: false,
    voice: true,
    box_dictation: null,
  };
  const input = () => host.querySelector<HTMLInputElement>('[data-testid="text-comment-input"]')!;
  const tick = () => new Promise((r) => setTimeout(r, 0));

  function selectHeading() {
    const range = document.createRange();
    range.selectNodeContents(heading);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }

  beforeEach(() => {
    document.body.innerHTML = `<main><h1 id="hero-title">${HEADING}</h1><p>Pricing that scales with your team, from one reviewer to a whole studio of them.</p></main>`;
    heading = document.querySelector('#hero-title')!;
    host = document.createElement('div');
    document.body.append(host);
    recorded = [];
    ui = new TextCommentUi(host, host, state, {
      closeAnnotation: vi.fn(async () => {}),
      record: vi.fn(async (i: TextCommentInput) => {
        recorded.push({ input: i, selection: document.getSelection()?.toString() ?? '' });
      }),
    });
  });
  afterEach(() => {
    ui.destroy();
    document.body.replaceChildren();
  });

  it('the box opens a turn after the release with its input focused, and records the selected heading', async () => {
    selectHeading();
    heading.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }));
    // Not yet: the box opens once the browser has settled the selection for this release.
    expect(input()?.isConnected && document.activeElement === input()).toBe(false);
    await tick();
    expect(host.querySelector('[data-testid="text-comment-box"]')).not.toBeNull();
    expect(document.activeElement === input() || host.contains(document.activeElement)).toBe(true);
    // Focus took the page's selection (as it does in Chrome): nothing is selected on the page any more.
    document.getSelection()!.removeAllRanges();
    input().value = 'Should say ship in seconds';
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    const { input: got, selection } = recorded[0]!;
    expect(got.anchor.exact).toBe(HEADING);
    expect(got.selected_text).toBe(HEADING);
    expect(got.element.tag).toBe('h1');
    expect(got.comment).toBe('Should say ship in seconds');
    // The heading was put back as the page's selection for the screenshot, and cleared after.
    expect(selection).toBe(HEADING);
    expect(document.getSelection()?.toString() ?? '').toBe('');
  });

  it('a selection changed between the release and the box opening is what the box is for', async () => {
    const para = document.querySelector('p')!;
    selectHeading();
    heading.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }));
    // Another release lands before the box opens: the box takes the selection as it is when it opens.
    const range = document.createRange();
    range.setStart(para.firstChild!, 0);
    range.setEnd(para.firstChild!, 'Pricing that scales'.length);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    await tick();
    input().value = 'x';
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0]!.input.anchor.exact).toBe('Pricing that scales');
    expect(recorded[0]!.selection).toBe('Pricing that scales');
  });
});
