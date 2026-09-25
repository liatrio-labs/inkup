// Session list (PRD P0-14, P0-15 "Sessions live in IndexedDB until the user deletes them"): every stored Session,
// grouped by the origin it started on, with its date, length, Change Item count and size; a link to its review;
// delete with a confirmation; restore from an export file; and total storage against the quota, with a warning at 80%.

import { formatBytes, groupByOrigin } from '@inkup/core/session-list';
import { useLiveQuery } from 'dexie-react-hooks';
import { DiscardUndo } from '@/components/discard-undo';
import { HostBackfill } from '@/components/host-backfill';
import { RestoreSession } from '@/components/restore-session';
import { SessionRow } from '@/components/session-row';
import { TONE } from '@/components/tone';
import { db } from '@/db';
import { sessionSummaries } from '@/db/sessions';
import { useOriginLabel } from '@/lib/use-origin-label';
import { useStorageEstimate } from '@/lib/use-storage-estimate';
import { useStorageItem } from '@/lib/use-storage-item';
import { cn } from '@/lib/utils';
import { activeSession } from '@/session-state';

export function App() {
  const summaries = useLiveQuery(() => sessionSummaries(db), []);
  const active = useStorageItem(activeSession);
  const storage = useStorageEstimate(30_000, [summaries?.length]);
  const groups = groupByOrigin(summaries ?? []);
  const label = useOriginLabel();
  const total = (summaries ?? []).reduce((n, s) => n + s.bytes, 0);

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8 text-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold">Sessions</h1>
        <p className="text-muted-foreground" data-testid="storage-total">
          {summaries
            ? `${summaries.length} ${summaries.length === 1 ? 'Session' : 'Sessions'}, ${formatBytes(total)} of recordings and screenshots`
            : 'Loading…'}
          {storage &&
            storage.quota > 0 &&
            ` · extension storage ${formatBytes(storage.usage)} of ${formatBytes(storage.quota)} (${Math.round(storage.ratio * 100)}%)`}
        </p>
      </header>

      <DiscardUndo />
      <HostBackfill variant="notice" />

      <div className="self-start">
        <RestoreSession />
      </div>

      {storage?.warn && (
        <p
          role="alert"
          className={cn('rounded-md border p-3', TONE.noteBorder, TONE.note)}
          data-testid="storage-warning"
        >
          Storage is {Math.round(storage.ratio * 100)}% full. Delete Sessions you no longer need, or delete their video
          and audio from the review page after exporting.
        </p>
      )}

      {summaries && summaries.length === 0 && (
        <p className="text-muted-foreground" data-testid="no-sessions">
          No Sessions yet. Start one from the side panel, or restore an export.
        </p>
      )}

      {groups.map((g) => (
        <section
          key={g.origin}
          aria-label={g.origin}
          data-testid="origin-group"
          data-origin={g.origin}
          className="flex flex-col gap-2"
        >
          <h2 className="text-base font-semibold" data-testid="origin-label">
            {label(g.origin)}
          </h2>
          <ul className="flex flex-col divide-y rounded-lg border">
            {g.sessions.map((s) => (
              <SessionRow key={s.id} s={s} recording={active?.id === s.id} />
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
