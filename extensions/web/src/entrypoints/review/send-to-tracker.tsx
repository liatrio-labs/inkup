// Review page: send one Change Item to GitHub as an issue (ADR 0028). Self-contained, so a card mounts it with one
// line next to "Copy agent prompt": it reads the Session, its latest done run and its `tracker_link` events itself.
//
// - No token or no default repo: a link to the Trackers settings.
// - Not sent yet: "Send to GitHub", then "Sending to GitHub…" while the images and the issue go up.
// - Sent: the link ("GitHub #142") and the issue's status, read live from GitHub when the page opens (open, closed
//   (completed), closed (not planned), or "status unavailable" when the read fails). Statuses are never stored or
//   logged. Sending again is in the menu, behind a confirm, because it makes a second issue.
// - A failed send says what went wrong in plain words, with Retry.
import type { ChangeItem } from '@inkup/core/process/change-item';
import { latestLinks, sessionName, trackerLinksFor } from '@inkup/core/review-edits';
import { sortTimeline } from '@inkup/core/timeline';
import { type IssueStatus, statusLabel, type TrackerLink } from '@inkup/core/trackers';
import { useLiveQuery } from 'dexie-react-hooks';
import { MoreHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { TONE } from '@/components/tone';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { db } from '@/db';
import { githubHere, sendToGithub } from '@/lib/trackers';
import { useStorageItem } from '@/lib/use-storage-item';
import { cn } from '@/lib/utils';
import { githubToken, trackerSettings } from '@/settings';

const sessionId = new URLSearchParams(location.search).get('session') ?? '';

/** Each issue's status, read once per page load (a reload reads it again). */
const statuses = new Map<string, Promise<IssueStatus>>();
function readStatus(link: TrackerLink): Promise<IssueStatus> {
  let status = statuses.get(link.url);
  if (!status) {
    status = (async () => {
      const token = (await githubToken.getValue()).trim();
      if (!token) throw new Error('no token');
      return (await githubHere()).getStatus({ token }, link);
    })();
    statuses.set(link.url, status);
  }
  return status;
}

const BADGE: Record<string, string> = {
  open: TONE.vetCheckedBadge,
  'closed (completed)': 'bg-muted',
  'closed (not planned)': 'bg-muted',
  closed: 'bg-muted',
  'status unavailable': 'bg-muted text-muted-foreground',
};

function StatusBadge({ link }: { link: TrackerLink }) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setLabel(null);
    readStatus(link).then(
      (s) => alive && setLabel(statusLabel(s)),
      () => alive && setLabel('status unavailable'),
    );
    return () => {
      alive = false;
    };
  }, [link]);
  if (label === null)
    return (
      <span className="text-xs text-muted-foreground" data-testid="tracker-status" data-state="loading">
        checking…
      </span>
    );
  return (
    <span
      className={cn('rounded-full px-2 py-0.5 text-xs', BADGE[label] ?? 'bg-muted')}
      data-testid="tracker-status"
      data-state={label}
    >
      {label}
    </span>
  );
}

export function SendToTracker({ item }: { item: ChangeItem }) {
  const token = useStorageItem(githubToken);
  const settings = useStorageItem(trackerSettings);
  const session = useLiveQuery(() => db.sessions.get(sessionId), []);
  const run = useLiveQuery(() => db.latestRun(sessionId, 'done'), []);
  const linkRows = useLiveQuery(() => db.eventsOfType(sessionId, 'tracker_link').toArray(), []);
  const renames = useLiveQuery(() => db.eventsOfType(sessionId, 'session_rename').toArray(), []);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);

  if (token === undefined || settings === undefined || !run || !linkRows || !session) return null;
  const link = latestLinks(trackerLinksFor(linkRows, run.id).get(item.id)).find((l) => l.tracker === 'github');
  const repo = settings.github.repo.trim();
  const configured = !!token.trim() && !!repo;

  async function send() {
    if (!session || !run) return;
    setSending(true);
    setError(null);
    setMenu(false);
    try {
      await sendToGithub({
        sessionId,
        sessionName: sessionName(session, sortTimeline(renames ?? [])),
        runId: run.id,
        item,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  if (!configured && !link)
    return (
      <a
        href="/options.html#trackers"
        target="_blank"
        rel="noreferrer"
        className="self-center text-xs text-primary underline"
        data-testid="tracker-settings-link"
      >
        Set up GitHub to send this item
      </a>
    );

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="send-to-tracker">
      {link ? (
        <>
          <span className="flex items-center gap-1.5 text-xs" data-testid="tracker-line">
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-primary underline"
              data-testid="tracker-link"
              title={`${link.destination}${link.key}`}
            >
              GitHub {link.key}
            </a>
            <span aria-hidden="true"> · </span>
            <StatusBadge link={link} />
          </span>
          {configured && (
            <span className="relative">
              <Button
                variant="ghost"
                size="sm"
                aria-label="More GitHub actions"
                aria-haspopup="menu"
                aria-expanded={menu}
                onClick={() => setMenu((m) => !m)}
                disabled={sending}
                data-testid="tracker-menu"
              >
                {sending ? 'Sending to GitHub…' : <MoreHorizontal aria-hidden="true" />}
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
        <Button variant="outline" size="sm" onClick={send} disabled={sending} data-testid="send-to-github">
          {sending ? 'Sending to GitHub…' : 'Send to GitHub'}
        </Button>
      )}
      {error && !sending && (
        <span className="flex basis-full flex-wrap items-center gap-2">
          <span role="alert" className="text-destructive" data-testid="tracker-error">
            {error}
          </span>
          <Button variant="outline" size="sm" onClick={send} data-testid="tracker-retry">
            Retry
          </Button>
        </span>
      )}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent data-testid="tracker-confirm">
          <DialogTitle>Send this item to GitHub again?</DialogTitle>
          <DialogDescription>
            It is already GitHub {link?.key} in {link?.destination}. Sending again makes a second issue in {repo}.
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(false)} data-testid="tracker-confirm-cancel">
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirm(false);
                void send();
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
