// Review page: send one Change Item to a tracker as an issue (ADR 0028). Self-contained, so a card mounts it with one
// line next to "Copy agent prompt": it reads the Session, its latest done run and its `tracker_link` events itself.
// It knows no tracker by name: it shows one row for each tracker in core's registry that is set up, or that the item
// is already linked to.
//
// - No tracker set up: a link to the Trackers settings.
// - Not sent to a tracker yet: "Send to GitHub" (or Linear, ...), then "Sending to GitHub…" while the images and the
//   issue go up. The saved destination is used; the small arrow beside the button opens a picker with the others
//   from listDestinations, and a choice there applies to that send only.
// - Sent: the link ("GitHub #142") and the issue's status, read live from the tracker when the page opens (the
//   tracker's own state name, or "open" / "closed (completed)" / "closed (not planned)", or "status unavailable" when
//   the read fails). Statuses are never stored or logged. Sending again is in the menu, behind a confirm, because it
//   makes a second issue.
// - An item can hold one link per tracker.
// - A failed send says what went wrong in plain words, with Retry. When the issue was made before the send failed
//   (Jira, when a screenshot didn't go on), the link is recorded and the row offers Open issue instead of Retry,
//   because sending again would make a second issue.
// - While the item is being sent to a tracker, from this card or by "Send all", its row shows it sending and can't
//   send it again.
import type { ChangeItem } from '@inkup/core/process/change-item';
import { latestLinks, sessionName, trackerLinksFor } from '@inkup/core/review-edits';
import { sortTimeline } from '@inkup/core/timeline';
import {
  type Destination,
  type IssueStatus,
  statusLabel,
  type TrackerDefinition,
  type TrackerLink,
  type TrackerName,
} from '@inkup/core/trackers';
import { Button, cn, Dialog, DialogContent, DialogDescription, DialogTitle } from '@inkup/ui';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronDown, MoreHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { TONE } from '@/components/tone';
import { db } from '@/db';
import {
  destinationsFor,
  IssueMadeError,
  KNOWN_TRACKERS,
  sendKey,
  sendToTracker,
  type TrackerSetup,
  trackerAdapter,
  trackerCredentials,
  useSendsInFlight,
  useTrackerSetups,
} from '@/lib/trackers';

const sessionId = new URLSearchParams(location.search).get('session') ?? '';

/** Each issue's status, read once per page load (a reload reads it again). */
const statuses = new Map<string, Promise<IssueStatus>>();
function readStatus(link: TrackerLink): Promise<IssueStatus> {
  let status = statuses.get(link.url);
  if (!status) {
    status = (async () => {
      const credentials = await trackerCredentials(link.tracker);
      if (!credentials) throw new Error('not set up');
      return (await trackerAdapter(link.tracker)).getStatus(credentials, link);
    })();
    statuses.set(link.url, status);
  }
  return status;
}

/** What a badge shows, and whether the issue is still open. */
interface Badge {
  label: string;
  open: boolean;
  /** Jira's status category, which sets the colour: to do (new), in progress (indeterminate), done. */
  category?: IssueStatus['category'];
}

/** A Jira status category's badge colour; the others colour by open or closed. */
const CATEGORY_TONE = {
  new: 'bg-muted',
  indeterminate: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  done: TONE.vetCheckedBadge,
} as const;

function StatusBadge({ link }: { link: TrackerLink }) {
  const [badge, setBadge] = useState<Badge | null>(null);
  useEffect(() => {
    let alive = true;
    setBadge(null);
    readStatus(link).then(
      (s) => alive && setBadge({ label: statusLabel(s), open: s.state === 'open', category: s.category }),
      () => alive && setBadge({ label: 'status unavailable', open: false }),
    );
    return () => {
      alive = false;
    };
  }, [link]);
  if (badge === null)
    return (
      <span className="text-xs text-muted-foreground" data-testid="tracker-status" data-state="loading">
        checking…
      </span>
    );
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-xs',
        badge.category ? CATEGORY_TONE[badge.category] : badge.open ? TONE.vetCheckedBadge : 'bg-muted',
        badge.label === 'status unavailable' && 'text-muted-foreground',
      )}
      data-testid="tracker-status"
      data-state={badge.label}
      data-category={badge.category}
    >
      {badge.label}
    </span>
  );
}

/** What the picker offers: the saved destination first, then the others the credentials can see. */
type Choices = Destination[] | 'loading' | { error: string };

function DestinationPicker({
  tracker,
  setup,
  value,
  onChange,
}: {
  tracker: TrackerName;
  setup: TrackerSetup;
  value: string;
  onChange: (destination: string) => void;
}) {
  const [choices, setChoices] = useState<Choices>('loading');
  useEffect(() => {
    let alive = true;
    destinationsFor(tracker, setup.credentials).then(
      (list) => alive && setChoices(list),
      (e: unknown) => alive && setChoices({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      alive = false;
    };
  }, [tracker, setup.credentials]);
  if (choices === 'loading') return <span className="text-xs text-muted-foreground">Loading…</span>;
  if ('error' in choices)
    return (
      <span role="alert" className="text-xs text-destructive" data-testid="tracker-destination-error">
        {choices.error}
      </span>
    );
  const known = choices.some((d) => d.id === setup.destination);
  return (
    <select
      aria-label="Send to"
      className="max-w-48 rounded-md border bg-background px-2 py-1 text-xs"
      data-testid="tracker-destination"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {!known && <option value={setup.destination}>{setup.destination}</option>}
      {choices.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
    </select>
  );
}

function TrackerRow({
  def,
  setup,
  link,
  inFlight,
  send,
}: {
  def: TrackerDefinition;
  /** Null when the tracker is not set up (the item is linked to it from before). */
  setup: TrackerSetup | null;
  link: TrackerLink | undefined;
  /** Whether the item is being sent to this tracker now, from here or by a bulk send. */
  inFlight: boolean;
  send: (tracker: TrackerName, destination?: string) => Promise<void>;
}) {
  const id = def.tracker;
  const [mine, setSending] = useState(false);
  const sending = mine || inFlight;
  // `url` when the issue was made before the send failed: open it, rather than send again.
  const [error, setError] = useState<{ message: string; url?: string } | null>(null);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [picking, setPicking] = useState(false);
  // A destination chosen in the picker: for the next send only.
  const [chosen, setChosen] = useState<string | null>(null);

  async function go(destination?: string) {
    setSending(true);
    setError(null);
    setMenu(false);
    try {
      await send(id, destination);
      setChosen(null);
      setPicking(false);
    } catch (e) {
      setError({
        message: e instanceof Error ? e.message : String(e),
        ...(e instanceof IssueMadeError ? { url: e.url } : {}),
      });
    } finally {
      setSending(false);
    }
  }
  const sendChosen = () => go(chosen ?? undefined);

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="send-to-tracker" data-tracker={id}>
      {link ? (
        <>
          <span className="flex items-center gap-1.5 text-xs" data-testid="tracker-line">
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-primary underline"
              data-testid="tracker-link"
              title={link.url}
            >
              {def.label} {link.key}
            </a>
            <span aria-hidden="true"> · </span>
            <StatusBadge link={link} />
          </span>
          {setup && (
            <span className="relative">
              <Button
                variant="ghost"
                size="sm"
                aria-label={`More ${def.label} actions`}
                aria-haspopup="menu"
                aria-expanded={menu}
                onClick={() => setMenu((m) => !m)}
                disabled={sending}
                data-testid="tracker-menu"
              >
                {sending ? `Sending to ${def.label}…` : <MoreHorizontal aria-hidden="true" />}
              </Button>
              {menu && (
                <div
                  role="menu"
                  className="absolute left-0 z-10 mt-1 min-w-40 rounded-md border bg-background p-1 shadow-md"
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      setMenu(false);
                      setConfirm(true);
                    }}
                    data-testid="tracker-send-again"
                  >
                    Send again
                  </button>
                </div>
              )}
            </span>
          )}
        </>
      ) : (
        setup && (
          <>
            <Button variant="outline" size="sm" onClick={sendChosen} disabled={sending} data-testid={`send-to-${id}`}>
              {sending ? `Sending to ${def.label}…` : `Send to ${def.label}`}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Choose where in ${def.label} to send`}
              aria-expanded={picking}
              onClick={() => setPicking((p) => !p)}
              disabled={sending}
              data-testid="tracker-destination-toggle"
            >
              <ChevronDown aria-hidden="true" />
            </Button>
            {picking && (
              <DestinationPicker tracker={id} setup={setup} value={chosen ?? setup.destination} onChange={setChosen} />
            )}
          </>
        )
      )}
      {error && !sending && (
        <span className="flex basis-full flex-wrap items-center gap-2">
          <span role="alert" className="text-destructive" data-testid="tracker-error">
            {error.message}
          </span>
          {error.url ? (
            <Button variant="outline" size="sm" asChild>
              <a href={error.url} target="_blank" rel="noreferrer" data-testid="tracker-open-issue">
                Open issue
              </a>
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={sendChosen} data-testid="tracker-retry">
              Retry
            </Button>
          )}
        </span>
      )}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent data-testid="tracker-confirm">
          <DialogTitle>Send this item to {def.label} again?</DialogTitle>
          <DialogDescription>
            It is already {def.label} {link?.key}. Sending again makes a second issue.
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(false)} data-testid="tracker-confirm-cancel">
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirm(false);
                void go();
              }}
              data-testid="tracker-confirm-send"
            >
              Send again
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function SendToTracker({ item }: { item: ChangeItem }) {
  const setups = useTrackerSetups();
  const inFlight = useSendsInFlight();
  const session = useLiveQuery(() => db.sessions.get(sessionId), []);
  const run = useLiveQuery(() => db.latestRun(sessionId, 'done'), []);
  const linkRows = useLiveQuery(() => db.eventsOfType(sessionId, 'tracker_link').toArray(), []);
  const renames = useLiveQuery(() => db.eventsOfType(sessionId, 'session_rename').toArray(), []);

  if (!setups || !run || !linkRows || !session) return null;
  const links = latestLinks(trackerLinksFor(linkRows, run.id).get(item.id));
  const rows = KNOWN_TRACKERS.flatMap(({ def }) => {
    const setup = setups.get(def.tracker) ?? null;
    const link = links.find((l) => l.tracker === def.tracker);
    return setup || link ? [{ def, setup, link }] : [];
  });

  if (!rows.length)
    return (
      <a
        href="/options.html#trackers"
        target="_blank"
        rel="noreferrer"
        className="self-center text-xs text-primary underline"
        data-testid="tracker-settings-link"
      >
        Set up a tracker to send this item
      </a>
    );

  async function send(tracker: TrackerName, destination?: string) {
    if (!session || !run) return;
    await sendToTracker(
      tracker,
      { sessionId, sessionName: sessionName(session, sortTimeline(renames ?? [])), runId: run.id, item },
      { destination },
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1" data-testid="send-to-trackers">
      {rows.map(({ def, setup, link }) => (
        <TrackerRow
          key={def.tracker}
          def={def}
          setup={setup}
          link={link}
          inFlight={inFlight.has(sendKey(run.id, item.id, def.tracker))}
          send={send}
        />
      ))}
    </div>
  );
}
