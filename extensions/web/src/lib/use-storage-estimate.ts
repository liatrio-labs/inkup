// Total extension storage against the quota (PRD P0-14), for the Session list and the panel's 80% warning.

import { type StorageLevel, storageLevel } from '@inkup/core/session-list';
import { useEffect, useState } from 'react';

export function useStorageEstimate(refreshMs = 30_000, deps: readonly unknown[] = []): StorageLevel | null {
  const [level, setLevel] = useState<StorageLevel | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () =>
      navigator.storage
        ?.estimate()
        .then((e) => alive && setLevel(storageLevel(e.usage, e.quota)))
        .catch(() => {});
    void read();
    const id = setInterval(read, refreshMs);
    addEventListener('focus', read);
    return () => {
      alive = false;
      clearInterval(id);
      removeEventListener('focus', read);
    };
    // The caller's deps re-read the estimate when they change.
  }, [refreshMs, ...deps]);
  return level;
}
