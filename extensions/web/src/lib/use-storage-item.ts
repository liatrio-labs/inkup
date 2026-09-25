import type { WxtStorageItem } from '@wxt-dev/storage';
import { useEffect, useState } from 'react';

/**
 * Current value of a @wxt-dev/storage item, kept live across contexts. `undefined` until first read. A change heard
 * while the first read is still out is newer than what that read returns, so the read's answer is then dropped (a
 * component mounted as the Host paired read "pairing" after hearing "connected", and kept it).
 */
export function useStorageItem<T>(item: WxtStorageItem<T, Record<string, unknown>>): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    let heard = false;
    void item.getValue().then((v) => alive && !heard && setValue(v));
    const unwatch = item.watch((v) => {
      heard = true;
      setValue(v);
    });
    return () => {
      alive = false;
      unwatch();
    };
  }, [item]);
  return value;
}

/** Re-renders every `ms` while `active`. */
export function useNow(active: boolean, ms = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}
