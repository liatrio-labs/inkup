// The side panel's idle state lists earlier Sessions (newest first) so a review is one click away, and restores an
// exported one from a file. The rows are @inkup/ui's SessionRow, fed from Dexie.
import { Skeleton } from '@inkup/ui';
import { useLiveQuery } from 'dexie-react-hooks';
import { HostBackfill } from '@/components/host-backfill';
import { RestoreSession } from '@/components/restore-session';
import { SessionRow } from '@/components/session-row';
import { db } from '@/db';
import { sessionSummaries } from '@/db/sessions';
import { useStorageItem } from '@/lib/use-storage-item';
import { activeSession } from '@/session-state';

export function PreviousSessions() {
  const summaries = useLiveQuery(() => sessionSummaries(db), []);
  // Delete stays disabled for a Session that is recording, as on the Sessions page.
  const recordingId = useStorageItem(activeSession)?.id ?? null;
  // A placeholder the height of a short list, so the panel does not jump when Dexie answers.
  if (!summaries) return <Skeleton className="h-24 w-full rounded-lg" aria-hidden />;
  const newestFirst = [...summaries].sort(
    (a, b) => b.started_at.localeCompare(a.started_at) || a.id.localeCompare(b.id),
  );
  return (
    <section className="flex flex-col gap-2" aria-label="Previous Sessions" data-testid="previous-sessions">
      <h2 className="font-semibold">Previous Sessions</h2>
      <HostBackfill variant="notice" />
      <RestoreSession size="sm" />
      {newestFirst.length === 0 ? (
        <p className="text-muted-foreground" data-testid="no-sessions">
          No Sessions yet.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {newestFirst.map((s) => (
            <SessionRow key={s.id} s={s} recording={recordingId === s.id} compact />
          ))}
        </ul>
      )}
    </section>
  );
}
