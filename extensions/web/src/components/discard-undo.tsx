// The Undo for a cancelled Session (E10), shown by the panel and the Sessions page until its deadline, like the
// toolbar's toast. The service worker deletes the Session at the deadline; Undo keeps it as a stopped Session.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useNow, useStorageItem } from '@/lib/use-storage-item';
import { sendMessage } from '@/messaging';
import { discardPending } from '@/settings';

export function DiscardUndo() {
  const pending = useStorageItem(discardPending) ?? [];
  const now = useNow(pending.length > 0, 500);
  const [error, setError] = useState<string | null>(null);
  const live = pending.filter((p) => p.deadline > now);
  if (live.length === 0 && !error) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="discard-undo">
      {live.map((p) => (
        <p
          key={p.session_id}
          role="status"
          className="flex items-center justify-between gap-2 rounded-md bg-muted p-2"
          data-session={p.session_id}
        >
          <span>
            Session discarded ·{' '}
            <span className="tabular-nums text-muted-foreground">{Math.ceil((p.deadline - now) / 1000)} s</span>
          </span>
          <Button
            size="sm"
            variant="outline"
            data-testid="undo-discard"
            onClick={() =>
              void sendMessage('undoDiscard', p.session_id).then(
                (r) => setError(r.ok ? null : 'Too late: the Session was already discarded.'),
                (e: unknown) => setError(String(e)),
              )
            }
          >
            Undo
          </Button>
        </p>
      ))}
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}
