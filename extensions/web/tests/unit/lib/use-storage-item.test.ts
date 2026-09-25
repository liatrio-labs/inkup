// useStorageItem (src/lib/use-storage-item.ts): its first read and its watch race, and a change heard while the read
// is still out is the newer value. The options page's "Upload 1 earlier Session" offer mounted as the Host paired,
// read the status "pairing", heard "connected", then took the late read's "pairing" and never offered (host-sync e2e).
import type { WxtStorageItem } from '@wxt-dev/storage';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useStorageItem } from '@/lib/use-storage-item';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** A storage item whose first read answers only when told to, and whose changes the test sends. */
function slowItem<T>() {
  let answer!: (v: T) => void;
  let listener: ((v: T) => void) | null = null;
  const item = {
    getValue: () => new Promise<T>((r) => (answer = r)),
    watch: (cb: (v: T) => void) => {
      listener = cb;
      return () => (listener = null);
    },
  } as unknown as WxtStorageItem<T, Record<string, unknown>>;
  return { item, answer: (v: T) => answer(v), change: (v: T) => listener?.(v) };
}

let unmount: (() => void) | null = null;
afterEach(() => {
  act(() => unmount?.());
  unmount = null;
});

function mount<T>(item: WxtStorageItem<T, Record<string, unknown>>) {
  const seen: (T | undefined)[] = [];
  function Probe() {
    seen.push(useStorageItem(item));
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe)));
  unmount = () => root.unmount();
  return () => seen.at(-1);
}

describe('useStorageItem', () => {
  it('is undefined until the first read, then its value', async () => {
    const { item, answer } = slowItem<string>();
    const value = mount(item);
    expect(value()).toBeUndefined();
    await act(async () => answer('connected'));
    expect(value()).toBe('connected');
  });

  it('keeps a change heard while the first read is out over that late read', async () => {
    const { item, answer, change } = slowItem<string>();
    const value = mount(item);
    act(() => change('connected'));
    await act(async () => answer('pairing'));
    expect(value()).toBe('connected');
  });

  it('follows every change after the first read', async () => {
    const { item, answer, change } = slowItem<string>();
    const value = mount(item);
    await act(async () => answer('pairing'));
    act(() => change('connected'));
    expect(value()).toBe('connected');
    act(() => change('offline'));
    expect(value()).toBe('offline');
  });
});
