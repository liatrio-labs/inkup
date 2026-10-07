// Review page: send every unsent Change Item to one tracker (ADR 0028). Self-contained, so the list's actions mount it
// with one line: it is given the run's items (deleted ones are already gone) and reads the Session, its latest done
// run and its `tracker_link` events itself. Like SendToTracker, it knows no tracker by name.
//
// - One "Send all to <tracker>" button for each tracker that is set up and has items not yet linked to it. An item
//   linked to another tracker is still unsent for this one.
// - Items go one at a time, in review order, each with its images and its own issue. Progress reads "Sending 4 of 12",
//   counting only the items that will be sent.
// - A failure does not stop the rest. When the list is done, the failed items are listed with the tracker's message
//   and a Retry for each.
// - A rate limit (a 403 or 429 with a retry-after) pauses the send for that long and tries the same item again,
//   rather than failing it.
import type { ChangeItem } from '@inkup/core/process/change-item';
import { latestLinks, sessionName, trackerLinksFor } from '@inkup/core/review-edits';
import { sortTimeline } from '@inkup/core/timeline';
import type { TrackerError, TrackerName } from '@inkup/core/trackers';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { db } from '@/db';
import { KNOWN_TRACKERS, sendToTracker, useTrackerSetups } from '@/lib/trackers';

const sessionId = new URLSearchParams(location.search).get('session') ?? '';

/** The longest a send waits for a rate limit to lift, and how many times it waits for one item. */
const MAX_WAIT_MS = 120_000;
const MAX_PAUSES = 3;

interface Failure {
  item: ChangeItem;
  error: string;
}

/** The send in progress, or the last one's result. */
interface Run {
  tracker: TrackerName;
  /** How many items this send covers. */
  total: number;
  /** The 1-based place of the item being sent now. */
  at: number;
  /** Whole seconds left of a rate-limit pause; null when not paused. */
  waiting: number | null;
  running: boolean;
  sent: number;
}

const isRateLimit = (e: unknown): e is TrackerError =>
  e instanceof Error && e.name === 'TrackerError' && (e as TrackerError).kind === 'rate_limit';

export function SendToTrackerBulk({ items }: { items: readonly ChangeItem[] }) {
  const setups = useTrackerSetups();
  const session = useLiveQuery(() => db.sessions.get(sessionId), []);
  const run = useLiveQuery(() => db.latestRun(sessionId, 'done'), []);
  const linkRows = useLiveQuery(() => db.eventsOfType(sessionId, 'tracker_link').toArray(), []);
  const renames = useLiveQuery(() => db.eventsOfType(sessionId, 'session_rename').toArray(), []);
  const [progress, setProgress] = useState<Run | null>(null);
  const [failed, setFailed] = useState<Failure[]>([]);
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());
  const [failedTracker, setFailedTracker] = useState<TrackerName | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  if (!setups || !session || !run || !linkRows) return null;
  const links = trackerLinksFor(linkRows, run.id);
  const unsentFor = (tracker: TrackerName) =>
    items.filter((i) => !latestLinks(links.get(i.id)).some((l) => l.tracker === tracker));
  const running = progress?.running === true;

  /** Sends one item, waiting out a rate limit the tracker says how long to wait for. */
  async function sendOne(tracker: TrackerName, item: ChangeItem, onWait: (seconds: number | null) => void) {
    if (!session || !run) return;
    for (let pauses = 0; ; pauses++) {
      try {
        await sendToTracker(tracker, {
          sessionId,
          sessionName: sessionName(session, sortTimeline(renames ?? [])),
          runId: run.id,
          item,
        });
        return;
      } catch (e) {
        const wait = isRateLimit(e) ? e.retryAfterMs : null;
        if (wait === null || wait > MAX_WAIT_MS || pauses >= MAX_PAUSES || !alive.current) throw e;
        for (let left = Math.max(1, Math.ceil(wait / 1000)); left > 0; left--) {
          onWait(left);
          await new Promise((r) => setTimeout(r, Math.min(1000, wait)));
        }
        onWait(null);
      }
    }
  }

  async function sendAll(tracker: TrackerName) {
    const todo = unsentFor(tracker);
    if (!todo.length) return;
    const failures: Failure[] = [];
    let sent = 0;
    setFailed([]);
    setFailedTracker(tracker);
    const update = (patch: Partial<Run>) =>
      alive.current &&
      setProgress((p) => ({ tracker, total: todo.length, at: 1, waiting: null, running: true, sent, ...p, ...patch }));
    setProgress({ tracker, total: todo.length, at: 1, waiting: null, running: true, sent: 0 });
    for (const [index, item] of todo.entries()) {
      update({ at: index + 1, waiting: null, sent });
      try {
        await sendOne(tracker, item, (waiting) => update({ waiting }));
        sent++;
      } catch (e) {
        failures.push({ item, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (!alive.current) return;
    update({ running: false, waiting: null, sent });
    setFailed(failures);
  }

  async function retryOne(failure: Failure) {
    if (!failedTracker) return;
    const id = failure.item.id;
    setRetrying((s) => new Set(s).add(id));
    try {
      await sendOne(failedTracker, failure.item, () => {});
      setFailed((f) => f.filter((x) => x.item.id !== id));
      setProgress((p) => (p ? { ...p, sent: p.sent + 1 } : p));
    } catch (e) {
      setFailed((f) =>
        f.map((x) => (x.item.id === id ? { ...x, error: e instanceof Error ? e.message : String(e) } : x)),
      );
    } finally {
      setRetrying((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  const buttons = KNOWN_TRACKERS.flatMap(({ def }) => {
    if (!setups.has(def.tracker)) return [];
    const count = unsentFor(def.tracker).length;
    return count ? [{ def, count }] : [];
  });
  const label = progress ? KNOWN_TRACKERS.find((t) => t.def.tracker === progress.tracker)?.def.label : undefined;

  return (
    <>
      {buttons.map(({ def, count }) => (
        <Button
          key={def.tracker}
          size="sm"
          variant="outline"
          disabled={running}
          title={`Sends the ${count} item${count === 1 ? '' : 's'} not yet in ${def.label}, one at a time`}
          onClick={() => void sendAll(def.tracker)}
          data-testid={`bulk-send-${def.tracker}`}
        >
          Send all to {def.label}
        </Button>
      ))}
      {progress && (
        <div className="flex basis-full flex-col gap-1 text-foreground" data-testid="bulk-send" role="status">
          {progress.running ? (
            <span data-testid="bulk-progress">
              Sending {progress.at} of {progress.total}
              {progress.waiting !== null && ` · ${label} asked to wait, trying again in ${progress.waiting}s`}
            </span>
          ) : (
            <span data-testid="bulk-progress">
              Sent {progress.sent} of {progress.total} to {label}
              {failed.length > 0 && `. ${failed.length} failed.`}
            </span>
          )}
          {failed.length > 0 && !progress.running && (
            <ul className="flex flex-col gap-1" data-testid="bulk-failed">
              {failed.map((f) => (
                <li key={f.item.id} className="flex flex-wrap items-center gap-2" data-item-id={f.item.id}>
                  <span className="font-medium">{f.item.title}</span>
                  <span className="text-destructive">{f.error}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={retrying.has(f.item.id)}
                    onClick={() => void retryOne(f)}
                    data-testid="bulk-retry"
                  >
                    {retrying.has(f.item.id) ? 'Retrying…' : 'Retry'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
