// #22: a pick dropped after its screenshot was taken hands that screenshot back to be discarded (`discard`), whether
// Esc comes after the pick's start was recorded or while it is still being recorded. A pick ended (not dropped) while
// its start is in flight is recorded once it lands, even if a later pick is dropped meanwhile.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectSelect, type ObjectSelectCallbacks } from '@/content/object-select';

describe('Object Select drops', () => {
  let host: HTMLElement;
  let page: HTMLElement;
  let other: HTMLElement;
  let cb: { pick: ReturnType<typeof vi.fn>; record: ReturnType<typeof vi.fn>; discard: ReturnType<typeof vi.fn> };
  let select: ObjectSelect<string>;
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
    select = new ObjectSelect(host, host, cb as unknown as ObjectSelectCallbacks<string>);
    select.start();
  });
  afterEach(() => {
    select.destroy();
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
