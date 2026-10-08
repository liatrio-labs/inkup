// The Undo for a cancelled Session (E10), shown by the panel and the Sessions page until its deadline, like the
// toolbar's toast. Drawn from props alone (R1.2): the caller passes the pending discards, the clock and the last
// error, and undoes through `onUndo`. Nothing renders once every deadline has passed and there is no error.

import { Button } from '../components/button';

export interface PendingDiscard {
  session_id: string;
  /** Epoch ms when the Session is deleted for good. */
  deadline: number;
}

export interface DiscardUndoProps {
  pending: readonly PendingDiscard[];
  /** Epoch ms; the caller ticks it while anything is pending. */
  now: number;
  error?: string | null;
  onUndo: (sessionId: string) => void;
}

export function DiscardUndo({ pending, now, error = null, onUndo }: DiscardUndoProps) {
  const live = pending.filter((p) => p.deadline > now);
  if (live.length === 0 && !error) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="discard-undo">
      {live.map((p) => (
        <p
          key={p.session_id}
          role="status"
          className="flex items-center justify-between gap-2 rounded-md border bg-muted py-1.5 pr-1.5 pl-3"
          data-session={p.session_id}
        >
          <span>
            Session discarded ·{' '}
            <span className="tabular-nums text-muted-foreground">{Math.ceil((p.deadline - now) / 1000)} s</span>
          </span>
          <Button size="sm" variant="outline" data-testid="undo-discard" onClick={() => onUndo(p.session_id)}>
            Undo
          </Button>
        </p>
      ))}
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}
