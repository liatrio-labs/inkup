// #22: a pick dropped after its screenshot was taken hands that screenshot back to be discarded (`discard`), whether
// Esc comes after the pick's start was recorded or while it is still being recorded. A pick ended (not dropped) while
// its start is in flight is recorded once it lands, even if a later pick is dropped meanwhile.
import { mountSurfaces, type Surfaces } from '@inkup/ui/toolbar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectSelect, type ObjectSelectCallbacks } from '@/content/object-select';

describe('Object Select drops', () => {
  let host: HTMLElement;
  let page: HTMLElement;
  let other: HTMLElement;
  let cb: { pick: ReturnType<typeof vi.fn>; record: ReturnType<typeof vi.fn>; discard: ReturnType<typeof vi.fn> };
  let select: ObjectSelect<string>;
  let surfaces: Surfaces;
  let answers: ((token: string) => void)[];

  const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  const input = () => host.querySelector<HTMLInputElement>('[data-testid="object-select-input"]')!;
  const press = (key: string) => input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  const settle = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    host = document.createElement('div');
    page = document.createElement('button');
    other = document.createElement('p');
    document.body.append(host, page, other);
    answers = [];
    cb = {
      pick: vi.fn(() => new Promise<string>((r) => answers.push(r))),
      record: vi.fn(async () => {}),
      discard: vi.fn(),
    };
    surfaces = mountSurfaces(host);
    select = new ObjectSelect(host, cb as unknown as ObjectSelectCallbacks<string>, surfaces);
    select.start();
  });
  afterEach(() => {
    select.destroy();
    surfaces.unmount();
    document.body.replaceChildren();
  });

  it('Esc in the comment box discards the pick it had started', async () => {
    click(page);
    answers[0]!('shot-1');
    await settle();
    press('Escape');
    expect(cb.discard).toHaveBeenCalledWith('shot-1');
    await select.flush();
    expect(cb.record).not.toHaveBeenCalled();
  });

  it('a pick dropped (Clear all) while its start is still being recorded is discarded once it lands', async () => {
    click(page);
    expect(select.clear()).toBe(1);
    answers[0]!('shot-1');
    await settle();
    expect(cb.discard).toHaveBeenCalledWith('shot-1');
    expect(cb.record).not.toHaveBeenCalled();
  });

  it('Enter records the pick and discards nothing', async () => {
    click(page);
    answers[0]!('shot-1');
    await settle();
    input().value = 'bigger';
    press('Enter');
    await select.flush();
    expect(cb.record).toHaveBeenCalledWith('shot-1', 'bigger');
    expect(cb.discard).not.toHaveBeenCalled();
  });

  it('a pick ended while in flight is still recorded when a later pick is dropped before it lands', async () => {
    click(page);
    // A click on the page ends the first pick before its start is recorded.
    click(other);
    // The next click picks again; that pick is dropped.
    click(other);
    select.clear();
    answers[0]!('shot-1');
    answers[1]!('shot-2');
    await settle();
    await select.flush();
    expect(cb.record).toHaveBeenCalledWith('shot-1', null);
    expect(cb.discard).toHaveBeenCalledWith('shot-2');
    expect(cb.discard).not.toHaveBeenCalledWith('shot-1');
  });
});

// The highlight is @inkup/ui's (packages/ui/tests/highlight.test.tsx covers it); here the logic layer drives it: the
// outline follows the pointer, the picked state shows, ↑ moves it to the parent, and stopping takes it away.
describe('Object Select highlight', () => {
  let host: HTMLElement;
  let wrap: HTMLElement;
  let page: HTMLElement;
  let select: ObjectSelect<string>;
  let surfaces: Surfaces;

  const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
  const outline = () => host.querySelector<HTMLElement>('[data-testid="object-select-highlight"]');
  const label = () => host.querySelector<HTMLElement>('[data-testid="object-select-label"]');
  const move = (el: Element) =>
    el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, composed: true, cancelable: true }));

  beforeEach(() => {
    host = document.createElement('div');
    wrap = document.createElement('section');
    wrap.className = 'hero';
    page = document.createElement('button');
    page.className = 'cta';
    wrap.append(page);
    document.body.append(host, wrap);
    surfaces = mountSurfaces(host);
    const cb = { pick: vi.fn(async () => 'shot'), record: vi.fn(async () => {}), discard: vi.fn() };
    select = new ObjectSelect(host, cb as unknown as ObjectSelectCallbacks<string>, surfaces);
  });
  afterEach(() => {
    select.destroy();
    surfaces.unmount();
    document.body.replaceChildren();
  });

  it('is not drawn until the pointer is over something, and leaves no <style> behind', async () => {
    select.start();
    await frame();
    expect(outline()).toBeNull();
    move(page);
    await frame();
    expect(outline()).toBeTruthy();
    expect(label()?.textContent).toMatch(/^button\.cta · \d+×\d+$/);
    expect(document.querySelector('style')).toBeNull();
    expect(host.querySelector('style')).toBeNull();
  });

  it('↑ moves it to the parent, ↓ back, a pick marks it picked, and stopping takes it away', async () => {
    select.start();
    move(page);
    await frame();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await frame();
    expect(label()?.textContent).toMatch(/^section\.hero · /);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await frame();
    expect(label()?.textContent).toMatch(/^button\.cta · /);
    expect(outline()?.hasAttribute('data-picked')).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await frame();
    expect(outline()?.hasAttribute('data-picked')).toBe(true);
    select.stop();
    expect(outline()).toBeNull();
  });
});
