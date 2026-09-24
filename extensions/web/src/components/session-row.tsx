// One stored Session in a list (PRD P0-14): what it recorded, a link to its review, and delete after a
// confirmation. The Sessions page shows the full row; the side panel's idle state the compact one.

import { formatElapsed } from '@inkup/core/clock';
import { formatBytes, originOf } from '@inkup/core/session-list';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { db } from '@/db';
import { deleteSession, type SessionSummary } from '@/db/sessions';
import { useOriginLabel } from '@/lib/use-origin-label';
import { cn } from '@/lib/utils';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function SessionRow({
  s,
  recording,
  compact = false,
}: {
  s: SessionSummary;
  recording: boolean;
  compact?: boolean;
}) {
  const label = useOriginLabel();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const length = s.duration_ms !== null ? formatElapsed(s.duration_ms) : recording ? 'recording' : 'interrupted';
  async function remove() {
    setDeleting(true);
    await deleteSession(db, s.id);
  }
  return (
    <li
      className={cn('flex flex-wrap items-center gap-x-4 gap-y-2', compact ? 'gap-x-3 p-2' : 'p-3')}
      data-testid="session-row"
      data-session={s.id}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium" title={s.start_url}>
          {s.start_title || s.start_url}
        </p>
        {compact && <p className="truncate text-xs text-muted-foreground">{label(originOf(s.start_url))}</p>}
        <p className={cn('text-muted-foreground', compact && 'text-xs')}>
          <span data-testid="session-date">{dateFmt.format(new Date(s.started_at))}</span> ·{' '}
          <span data-testid="session-length">{length}</span> ·{' '}
          <span data-testid="session-items">
            {s.items === null ? 'not processed' : `${s.items} ${s.items === 1 ? 'Change Item' : 'Change Items'}`}
          </span>
          {!compact && (
            <>
              {' '}
              · <span data-testid="session-size">{formatBytes(s.bytes)}</span>
            </>
          )}
        </p>
      </div>
      <a
        className="text-primary underline"
        href={`/review.html?session=${encodeURIComponent(s.id)}`}
        target="_blank"
        data-testid="open-review"
        rel="noopener"
      >
        Open review
      </a>
      {confirming ? (
        // biome-ignore lint/a11y/useSemanticElements: an inline part of the row's flex layout; a fieldset brings its own block and min-content sizing
        <span className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm delete">
          <span>
            {compact
              ? 'Delete it and its recordings? This cannot be undone.'
              : 'Delete this Session and its recordings? This cannot be undone.'}
          </span>
          <Button size="sm" variant="destructive" onClick={remove} disabled={deleting} data-testid="confirm-delete">
            Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={deleting}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setConfirming(true)}
          disabled={recording}
          title={recording ? 'Stop the Session first' : undefined}
          data-testid="delete-session"
        >
          Delete
        </Button>
      )}
    </li>
  );
}
