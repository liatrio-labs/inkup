// The Undo for a cancelled Session (E10), shown by the panel and the Sessions page until its deadline, like the
// toolbar's toast: @inkup/ui's DiscardUndo, fed from the pending discards in storage. The service worker deletes the
// Session at the deadline; Undo keeps it as a stopped Session.

import { DiscardUndo as DiscardUndoView } from '@inkup/ui';
import { useState } from 'react';
import { useNow, useStorageItem } from '@/lib/use-storage-item';
import { sendMessage } from '@/messaging';
import { discardPending } from '@/settings';

export function DiscardUndo() {
  const pending = useStorageItem(discardPending) ?? [];
  const now = useNow(pending.length > 0, 500);
  const [error, setError] = useState<string | null>(null);
  return (
    <DiscardUndoView
      pending={pending}
      now={now}
      error={error}
      onUndo={(id) =>
        void sendMessage('undoDiscard', id).then(
          (r) => setError(r.ok ? null : 'Too late: the Session was already discarded.'),
          (e: unknown) => setError(String(e)),
        )
      }
    />
  );
}
