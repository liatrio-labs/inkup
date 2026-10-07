// Items view: send Change Items to the reviewer's trackers (ADR 0028), with the extension's rules. Self-contained:
// ItemsView mounts `<TrackerScope>` around its table, `<BulkSend>` above it and `<SendToTracker>` in each row, one
// line each.
//
// - A send reads the item in full and its screenshots from the host, runs the packages/core adapter here (pushItem:
//   images, then the issue), then records the link on the host. The token comes from the OS keychain at that moment.
// - A sent item shows its link ("GitHub #142") and the issue's status, read when the Items view opens: open, closed
//   (completed), closed (not planned), the tracker's own state name, or "status unavailable" when the read fails,
//   which blocks nothing. A status is never stored.
// - Sending again is behind a menu and a confirm, because it makes a second issue.
// - Bulk send sends every item not yet linked to that tracker, one at a time, keeps going after a failure, then
//   lists the failed items with Retry. Before each item it reads the item from the host again and skips it when it
//   is already linked to that tracker, or is being sent from its row right now, so a hand send during a bulk send
//   never makes a second issue.
// - An issue made whose link the host then failed to record is kept here: Retry records the link, and makes no
//   second issue.
// - A send that failed after its issue was made (Jira, when a screenshot didn't go on) records the link and offers
//   Open issue instead of Retry, because sending again would make a second issue.
import {
  createdIssue,
  type IssueItem,
  type IssueStatus,
  itemImageIds,
  pushItem,
  statusLabel,
  type TrackerDefinition,
  type TrackerName,
  trackerDefinition,
} from '@inkup/core/trackers';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
} from '@inkup/ui';
import { openUrl } from '@tauri-apps/plugin-opener';
import { MoreHorizontal, Send } from 'lucide-react';
import { createContext, type ReactNode, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { type FullItem, hostItem, hostScreenshot, type ItemView, recordTrackerLink, type TrackerLink } from './host';
import { type TrackerSetup, trackerClient, trackerValues, useTrackerSetups } from './trackers';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// What is being sent, what failed, and links recorded since the host state was last read: shared by the rows and
// the bulk bar, so a bulk send shows on each row too.
interface Sends {
  /** item id → the tracker it is being sent to. */
  sending: Map<string, TrackerName>;
  /** `${item}|${tracker}` → why the last send failed, and the issue when it was made anyway. */
  failed: Map<string, Failure>;
  /** `${item}|${tracker}` → an issue made whose link the host did not record yet. */
  unrecorded: Map<string, TrackerLink>;
  /** item id → its links as the host answered the last record. */
  recorded: Map<string, TrackerLink[]>;
}
let sends: Sends = { sending: new Map(), failed: new Map(), unrecorded: new Map(), recorded: new Map() };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function change(update: (draft: Sends) => void) {
  const next: Sends = {
    sending: new Map(sends.sending),
    failed: new Map(sends.failed),
    unrecorded: new Map(sends.unrecorded),
    recorded: new Map(sends.recorded),
  };
  update(next);
  sends = next;
  for (const listener of listeners) listener();
}
const useSends = () => useSyncExternalStore(subscribe, () => sends);

/** Forgets every send: a new window starts with none (tests render one per case). */
export function resetTrackerSends() {
  sends = { sending: new Map(), failed: new Map(), unrecorded: new Map(), recorded: new Map() };
  for (const listener of listeners) listener();
}
const key = (item: string, tracker: TrackerName) => `${item}|${tracker}`;

/** Why a send failed. `url` when its issue was made before it failed: open that, rather than send again. */
interface Failure {
  message: string;
  url?: string;
}

/** A send failed after its issue was made. The link is recorded; `url` is the issue, to open and finish by hand. */
class IssueMadeError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
  }
}

/** An item's links: the host's, and any recorded since the host state was read. */
function linksOf(item: ItemView, recorded: Map<string, TrackerLink[]>): TrackerLink[] {
  const links = [...(item.tracker_links ?? [])];
  for (const link of recorded.get(item.id) ?? []) if (!links.some((l) => l.url === link.url)) links.push(link);
  return links;
}

/** The newest link of an item to a tracker. */
const linkTo = (links: TrackerLink[], tracker: TrackerName) => links.filter((l) => l.tracker === tracker).at(-1);

/**
 * Sends one item to a tracker as an issue with its screenshots, and records the link on the host. With `unlessSent`
 * (a bulk send), an item the host already has linked to the tracker is skipped: answers null.
 */
async function sendItem(definition: TrackerDefinition, id: string, unlessSent: boolean): Promise<FullItem | null> {
  const tracker = definition.tracker;
  const made = sends.unrecorded.get(key(id, tracker));
  if (made) return record(id, tracker, made);
  const values = await trackerValues(definition);
  const destination = values.destination?.trim();
  if (!destination) throw new Error(`Pick a ${definition.destinationLabel.toLowerCase()} in Trackers first.`);
  const full = await hostItem(id);
  const linked = full.item.tracker_links ?? [];
  if (unlessSent && linked.some((l) => l.tracker === tracker)) {
    // Sent since the bulk send started (from its row): show the link, and send nothing.
    change((s) => s.recorded.set(id, linked));
    return null;
  }
  const item = {
    category: '',
    intent: '',
    transcript: '',
    agent_prompt: '',
    ...full.item,
  } as unknown as IssueItem;
  const images = [];
  // A screenshot the host no longer has is left out of the issue.
  for (const image of itemImageIds(item)) {
    const bytes = await hostScreenshot(image).catch(() => null);
    if (bytes) images.push({ id: image, bytes: new Uint8Array(bytes) });
  }
  const { adapter, credentials } = trackerClient(definition, values);
  let link: TrackerLink;
  try {
    link = await pushItem({
      adapter,
      credentials,
      destination,
      item,
      session: { id: full.session_id, name: full.session_name },
      images,
    });
  } catch (error) {
    // The send made its issue before it failed: record it, so neither Retry nor a bulk send makes a second one.
    const issue = createdIssue(error);
    if (!issue) throw error;
    await record(id, tracker, { ...issue, created_at: new Date().toISOString() }).catch(() => {});
    throw new IssueMadeError(errorText(error), issue.url);
  }
  return record(id, tracker, link);
}

/** Records a made issue on the host. On failure the issue is kept, so Retry records it and makes no second one. */
async function record(id: string, tracker: TrackerName, link: TrackerLink): Promise<FullItem> {
  try {
    const full = await recordTrackerLink(id, link);
    change((s) => {
      s.unrecorded.delete(key(id, tracker));
      s.recorded.set(id, full.item.tracker_links);
    });
    return full;
  } catch (error) {
    change((s) => {
      s.unrecorded.set(key(id, tracker), link);
      // Shown until it is recorded.
      s.recorded.set(id, [...(s.recorded.get(id) ?? []), link]);
    });
    throw new Error(
      `The issue was made (${link.url}), but the InkUp host didn't record the link: ${errorText(error)} Retry records it without making another issue.`,
    );
  }
}

/**
 * Sends with the shared state: sending while it runs, the failure after. Resolves false when it failed. An item
 * already being sent to this tracker is skipped (it is checked and marked before the first await, so a row and a bulk
 * send can't both send it); one being sent to another tracker fails, to be retried once that send is done.
 */
async function send(definition: TrackerDefinition, id: string, unlessSent = false): Promise<boolean> {
  const at = key(id, definition.tracker);
  const busy = sends.sending.get(id);
  if (busy === definition.tracker) return true;
  if (busy) {
    const other = trackerDefinition(busy)?.label ?? busy;
    change((s) =>
      s.failed.set(at, {
        message: `This item was being sent to ${other}, so it wasn't sent to ${definition.label}. Retry once that send is done.`,
      }),
    );
    return false;
  }
  change((s) => {
    s.sending.set(id, definition.tracker);
    s.failed.delete(at);
  });
  try {
    await sendItem(definition, id, unlessSent);
    return true;
  } catch (error) {
    change((s) =>
      s.failed.set(at, {
        message: errorText(error),
        ...(error instanceof IssueMadeError ? { url: error.url } : {}),
      }),
    );
    return false;
  } finally {
    change((s) => s.sending.delete(id));
  }
}

/** Statuses read while the Items view is open: each issue's once, read again when the view opens again. */
interface Scope {
  status(definition: TrackerDefinition, link: TrackerLink): Promise<IssueStatus>;
}
const ScopeContext = createContext<Scope | null>(null);

function makeScope(): Scope {
  const statuses = new Map<string, Promise<IssueStatus>>();
  const values = new Map<TrackerName, ReturnType<typeof trackerValues>>();
  return {
    status(definition, link) {
      let status = statuses.get(link.url);
      if (!status) {
        let read = values.get(definition.tracker);
        if (!read) {
          read = trackerValues(definition);
          values.set(definition.tracker, read);
        }
        status = read.then((v) => {
          const { adapter, credentials } = trackerClient(definition, v);
          return adapter.getStatus(credentials, link);
        });
        statuses.set(link.url, status);
      }
      return status;
    },
  };
}

/** Around the Items view's table: its statuses are read once per opening of the view. */
export function TrackerScope({ children }: { children: ReactNode }) {
  const [scope] = useState(makeScope);
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>;
}

/** What a badge shows: the status's words, whether the issue is open, and Jira's status category. */
interface StatusView {
  label: string;
  open: boolean;
  category?: IssueStatus['category'];
}

const UNAVAILABLE: StatusView = { label: 'status unavailable', open: false };

/** Jira's category sets the look when there is one (in progress stands out); otherwise open or closed does. */
function badgeVariant(s: StatusView): 'default' | 'secondary' | 'outline' {
  if (s.category === 'indeterminate') return 'secondary';
  if (s.category) return s.category === 'new' ? 'default' : 'outline';
  return s.open ? 'default' : 'outline';
}

function StatusBadge({ definition, link }: { definition: TrackerDefinition; link: TrackerLink }) {
  const scope = useContext(ScopeContext);
  const [status, setStatus] = useState<StatusView | null>(null);
  // A host refresh brings the same link as a new object: read it again only when it is another issue.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the issue's url
  useEffect(() => {
    let alive = true;
    setStatus(null);
    if (!scope) {
      setStatus(UNAVAILABLE);
      return;
    }
    scope.status(definition, link).then(
      (s) => alive && setStatus({ label: statusLabel(s), open: s.state === 'open', category: s.category }),
      () => alive && setStatus(UNAVAILABLE),
    );
    return () => {
      alive = false;
    };
  }, [scope, definition, link.url]);
  if (status === null)
    return (
      <span className="text-muted-foreground text-xs" data-testid="tracker-status" data-state="loading">
        checking…
      </span>
    );
  return (
    <Badge
      variant={badgeVariant(status)}
      className={status === UNAVAILABLE ? 'text-muted-foreground' : undefined}
      data-testid="tracker-status"
      data-state={status.label}
      data-category={status.category}
    >
      {status.label}
    </Badge>
  );
}

/** One row's trackers: each link with its status, Send for a ready tracker it is not linked to yet. */
export function SendToTracker({ item }: { item: ItemView }) {
  const setups = useTrackerSetups();
  const state = useSends();
  if (!setups) return null;
  const links = linksOf(item, state.recorded);
  const ready = setups.filter((s) => s.ready);
  const shown = setups.filter((s) => s.ready || linkTo(links, s.definition.tracker));
  if (shown.length === 0)
    return (
      <span className="text-muted-foreground text-xs" data-testid="tracker-setup-hint">
        Set up a tracker in Trackers to send this item.
      </span>
    );
  return (
    <div className="flex flex-col items-start gap-1.5" data-testid="send-to-tracker">
      {shown.map((setup) => (
        <TrackerLine
          key={setup.definition.tracker}
          item={item}
          setup={setup}
          link={linkTo(links, setup.definition.tracker)}
          sending={state.sending.get(item.id) === setup.definition.tracker}
          busy={state.sending.has(item.id)}
          failed={state.failed.get(key(item.id, setup.definition.tracker))}
          canSend={ready.includes(setup)}
        />
      ))}
    </div>
  );
}

function TrackerLine({
  item,
  setup,
  link,
  sending,
  busy,
  failed,
  canSend,
}: {
  item: ItemView;
  setup: TrackerSetup;
  link: TrackerLink | undefined;
  sending: boolean;
  busy: boolean;
  failed: Failure | undefined;
  canSend: boolean;
}) {
  const { definition } = setup;
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const go = () => void send(definition, item.id);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {link ? (
        <>
          <span className="flex items-center gap-1.5 text-xs" data-testid="tracker-line">
            <a
              href={link.url}
              className="text-primary font-medium underline"
              data-testid="tracker-link"
              title={`${link.destination} ${link.key}`}
              onClick={(e) => {
                e.preventDefault();
                void openUrl(link.url);
              }}
            >
              {definition.label} {link.key}
            </a>
            <StatusBadge definition={definition} link={link} />
          </span>
          {canSend &&
            (sending ? (
              <span className="text-muted-foreground text-xs">Sending to {definition.label}…</span>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`More ${definition.label} actions for ${item.id}`}
                  aria-expanded={menu}
                  disabled={busy}
                  onClick={() => setMenu((m) => !m)}
                  data-testid="tracker-menu"
                >
                  <MoreHorizontal />
                </Button>
                {menu && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setMenu(false);
                      setConfirm(true);
                    }}
                    data-testid="tracker-send-again"
                  >
                    Send again…
                  </Button>
                )}
              </>
            ))}
        </>
      ) : (
        <Button size="sm" variant="outline" disabled={busy} onClick={go} data-testid={`send-to-${definition.tracker}`}>
          <Send />
          {sending ? `Sending to ${definition.label}…` : `Send to ${definition.label}`}
        </Button>
      )}
      {failed && !sending && (
        <span className="flex basis-full flex-wrap items-center gap-2 text-xs">
          <span role="alert" className="text-destructive whitespace-normal" data-testid="tracker-error">
            {failed.message}
          </span>
          {failed.url ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void openUrl(failed.url as string)}
              data-testid="tracker-open-issue"
            >
              Open issue
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={go} data-testid="tracker-retry">
              Retry
            </Button>
          )}
        </span>
      )}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent data-testid="tracker-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Send this item to {definition.label} again?</AlertDialogTitle>
            <AlertDialogDescription>
              It is already {definition.label} {link?.key} in {link?.destination}. Sending again makes a second issue in{' '}
              {setup.plain.destination}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={go}>Send again</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Above the Items view: send every item not yet linked to a tracker, one at a time. */
export function BulkSend({ items }: { items: ItemView[] }) {
  const setups = useTrackerSetups();
  const state = useSends();
  const [run, setRun] = useState<{ tracker: TrackerName; at: number; of: number } | null>(null);
  const [failed, setFailed] = useState<{ tracker: TrackerName; ids: string[] } | null>(null);
  const ready = setups?.filter((s) => s.ready) ?? [];
  if (ready.length === 0) return null;

  async function sendAll(definition: TrackerDefinition, ids: string[]) {
    setFailed(null);
    const missed: string[] = [];
    for (const [i, id] of ids.entries()) {
      setRun({ tracker: definition.tracker, at: i + 1, of: ids.length });
      if (!(await send(definition, id, true))) missed.push(id);
    }
    setRun(null);
    setFailed(missed.length > 0 ? { tracker: definition.tracker, ids: missed } : null);
  }

  return (
    <div className="flex flex-col gap-2" data-testid="bulk-send">
      <div className="flex flex-wrap items-center gap-2">
        {ready.map(({ definition }) => {
          const unsent = items
            .filter((item) => !linkTo(linksOf(item, state.recorded), definition.tracker))
            .map((item) => item.id);
          return (
            <Button
              key={definition.tracker}
              size="sm"
              variant="outline"
              disabled={run !== null || unsent.length === 0}
              onClick={() => void sendAll(definition, unsent)}
              data-testid={`bulk-send-${definition.tracker}`}
            >
              <Send />
              Send {unsent.length} unsent to {definition.label}
            </Button>
          );
        })}
        {run && (
          <span className="text-muted-foreground text-sm" role="status" data-testid="bulk-progress">
            Sending {run.at} of {run.of}
          </span>
        )}
      </div>
      {failed && (
        <div className="flex flex-wrap items-center gap-2 text-sm" role="alert" data-testid="bulk-failed">
          <span className="text-destructive">
            {failed.ids.length === 1 ? "1 item wasn't sent" : `${failed.ids.length} items weren't sent`}:{' '}
            {failed.ids.join(', ')}. Each row says why.
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={run !== null}
            onClick={() => {
              const definition = ready.find((s) => s.definition.tracker === failed.tracker)?.definition;
              if (definition) void sendAll(definition, failed.ids);
            }}
            data-testid="bulk-retry"
          >
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
