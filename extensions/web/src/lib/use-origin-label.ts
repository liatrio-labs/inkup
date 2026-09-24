// Names origins in the Session list (packages/core/src/session-list.ts originLabel). Other extensions are named only
// when `chrome.management` is already available, which needs the `management` permission this extension does
// not request; without it they keep their raw chrome-extension:// origin.

import { originLabel } from '@inkup/core/session-list';
import { useEffect, useState } from 'react';

const ownOrigin = () => chrome.runtime.getURL('').replace(/\/$/, '');

export function useOriginLabel(): (origin: string) => string {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (typeof chrome.management?.getAll !== 'function') return;
    chrome.management
      .getAll()
      .then((all) => setNames(new Map(all.map((e) => [e.id, e.name]))))
      .catch(() => {});
  }, []);
  return (origin) => originLabel(origin, ownOrigin(), names);
}
