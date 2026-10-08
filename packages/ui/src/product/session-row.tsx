// One stored Session in a list (PRD P0-14), drawn from props alone (R1.2): what it recorded, a link to its review,
// and delete after an inline confirmation. The Sessions page shows the full row; the side panel's idle state the
// compact one. The caller deletes (`onDelete`) and opens the review: through `renderReviewLink` when the link needs
// the app's own behaviour (the extension focuses an open review tab), else `onOpen` on a plain button.
//
// The confirmation stays inside the row, a group named "Confirm delete", so the row's own locators reach it.
import { formatElapsed } from '@inkup/core/clock';
import { formatBytes } from '@inkup/core/session-list';
import { type ReactNode, useState } from 'react';
import { Button } from '../components/button';
import { cn } from '../lib/utils';
import { RESOLUTION_TEXT } from './resolution-style';

/** How a processed Session's Change Items stand, by their latest Resolution. */
export interface SessionItemCounts {
  total: number;
  open: number;
  in_progress: number;
  done: number;
  needs_info: number;
}

/** What a row shows of a stored Session. */
export interface SessionRowSummary {
  id: string;
  /** The name the reviewer gave it, else the start page's title or address. */
  name: string;
  start_url: string;
  /** ISO time. */
  started_at: string;
  /** Null while recording, or when it was interrupted. */
  duration_ms: number | null;
  /** Null before Process. */
  items: SessionItemCounts | null;
  bytes: number;
}

/** What the caller's review link renders with. */
export interface SessionReviewLinkProps {
  sessionId: string;
  className: string;
  'data-testid': 'open-review';
  children: ReactNode;
}

export interface SessionRowProps {
  session: SessionRowSummary;
  /** It is the Session recording now: delete waits for Stop. */
  recording: boolean;
  /** The side panel's row: the origin on its own line, no size. */
  compact?: boolean;
  /** The start page's origin as the reviewer knows it, for the compact row. */
  originLabel?: string;
  onDelete: (sessionId: string) => unknown;
  onOpen?: (sessionId: string) => void;
  renderReviewLink?: (props: SessionReviewLinkProps) => ReactNode;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function SessionRow({
  session: s,
  recording,
  compact = false,
  originLabel,
  onDelete,
  onOpen,
  renderReviewLink,
}: SessionRowProps) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const length = s.duration_ms !== null ? formatElapsed(s.duration_ms) : recording ? 'recording' : 'interrupted';
  async function remove() {
    setDeleting(true);
    try {
      await onDelete(s.id);
    } catch (e) {
      setDeleting(false);
      throw e;
    }
  }
  const link = {
    sessionId: s.id,
    className: 'font-medium text-primary underline underline-offset-2',
    'data-testid': 'open-review',
    children: 'Open review',
  } as const;
  return (
    <li
      className={cn('flex flex-wrap items-center gap-x-4 gap-y-2', compact ? 'gap-x-3 px-3 py-2.5' : 'p-3')}
      data-testid="session-row"
      data-session={s.id}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium" title={s.start_url}>
          {s.name}
        </p>
        {compact && originLabel !== undefined && (
          <p className="truncate text-xs text-muted-foreground">{originLabel}</p>
        )}
        <p className={cn('text-muted-foreground', compact && 'text-xs')}>
          <span data-testid="session-date">{dateFmt.format(new Date(s.started_at))}</span> ·{' '}
          <span className="tabular-nums" data-testid="session-length">
            {length}
          </span>{' '}
          · <ItemCounts items={s.items} />
          {!compact && (
            <>
              {' '}
              · <span data-testid="session-size">{formatBytes(s.bytes)}</span>
            </>
          )}
        </p>
      </div>
      {renderReviewLink ? (
        renderReviewLink(link)
      ) : (
        <Button
          variant="link"
          size="sm"
          className={cn('h-auto p-0', link.className)}
          data-testid={link['data-testid']}
          onClick={() => onOpen?.(s.id)}
        >
          {link.children}
        </Button>
      )}
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

/** "7 Change Items", then how they stand once an agent has acted on any: open, in work, done, needs info. */
export function ItemCounts({ items }: { items: SessionItemCounts | null }) {
  if (items === null) return <span data-testid="session-items">not processed</span>;
  const total = `${items.total} ${items.total === 1 ? 'Change Item' : 'Change Items'}`;
  const acted = items.open < items.total;
  return (
    <span
      data-testid="session-items"
      data-total={items.total}
      data-open={items.open}
      data-in-progress={items.in_progress}
      data-done={items.done}
      data-needs-info={items.needs_info}
    >
      {acted ? (
        <>
          {total}: {items.open} open · <span className={RESOLUTION_TEXT.in_progress}>{items.in_progress} in work</span>{' '}
          · <span className={RESOLUTION_TEXT.resolved}>{items.done} done</span>
          {items.needs_info > 0 && (
            <>
              {' '}
              · <span className={RESOLUTION_TEXT.needs_info}>{items.needs_info} needs info</span>
            </>
          )}
        </>
      ) : (
        total
      )}
    </span>
  );
}
