// The six views, as the TUI has them (host/crates/tui/src/ui.rs): Clients, Sessions, Timeline, Items, Agents,
// Tokens. Each is a table of the host's state; the actions are the TUI's keys as buttons. Off-the-shelf shadcn only.
import { Copy, KeyRound, Pause, Pencil, Play, Plus, Square, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  ago,
  type ClientView,
  type CommandRequest,
  type ControlState,
  clientState,
  clock,
  liveSessionOf,
  type NewToken,
  resolutionLine,
  type SessionOverview,
  STATUS_LABEL,
  sessionPage,
  sessionState,
} from './host';

/** A table with a header row, or one muted line when there are no rows. */
function View({ head, empty, rows }: { head: ReactNode[]; empty: string; rows: ReactNode[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {head.map((h, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed header row
            <TableHead key={i}>{h}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={head.length} className="text-muted-foreground whitespace-normal">
              {empty}
            </TableCell>
          </TableRow>
        ) : (
          rows
        )}
      </TableBody>
    </Table>
  );
}

export type Command = Omit<CommandRequest, 'client_id'>;

export function ClientsView({
  host,
  now,
  drawing,
  onCommand,
}: {
  host: ControlState;
  now: number;
  /** Draw mode per Session, as this window last set it: the Client does not report it. */
  drawing: Record<string, boolean>;
  onCommand: (client: ClientView, command: Command) => void;
}) {
  const { clients, sessions } = host.state;
  return (
    <View
      head={[
        'Name',
        'Kind',
        'State',
        'Last seen',
        <span key="a" className="sr-only">
          Actions
        </span>,
      ]}
      empty="No paired clients. Pair from the extension's Settings; the request shows here."
      rows={clients.map((c) => {
        const live = liveSessionOf(c.id, sessions);
        return (
          <TableRow key={c.id}>
            <TableCell>{c.name}</TableCell>
            <TableCell>{c.kind}</TableCell>
            <TableCell>
              <Badge variant={c.connected ? 'default' : 'outline'}>{clientState(c, sessions)}</Badge>
            </TableCell>
            <TableCell>{ago(now, c.last_seen_at)}</TableCell>
            <TableCell>
              <ClientActions
                client={c}
                live={live}
                drawing={live ? (drawing[live.id] ?? false) : false}
                onCommand={(command) => onCommand(c, command)}
              />
            </TableCell>
          </TableRow>
        );
      })}
    />
  );
}

/** Start, pause or resume, stop and draw mode: the TUI's s, p, x and d for this Client. */
function ClientActions({
  client,
  live,
  drawing,
  onCommand,
}: {
  client: ClientView;
  live: SessionOverview | undefined;
  drawing: boolean;
  onCommand: (command: Command) => void;
}) {
  if (!client.connected) return null;
  if (!live) {
    return (
      <Button size="sm" variant="outline" onClick={() => onCommand({ command: 'start_session' })}>
        <Play />
        Start
      </Button>
    );
  }
  return (
    <div className="flex items-center justify-end gap-2">
      <Button size="sm" variant="outline" onClick={() => onCommand({ command: live.paused ? 'resume' : 'pause' })}>
        {live.paused ? <Play /> : <Pause />}
        {live.paused ? 'Resume' : 'Pause'}
      </Button>
      <Button size="sm" variant="outline" onClick={() => onCommand({ command: 'stop' })}>
        <Square />
        Stop
      </Button>
      <div className="flex items-center gap-1.5 pl-1">
        <Switch
          id={`draw-${client.id}`}
          checked={drawing}
          onCheckedChange={(on) => onCommand({ command: 'set_draw_mode', draw_mode: on })}
        />
        <Label htmlFor={`draw-${client.id}`}>
          <Pencil className="size-3.5" />
          Draw
        </Label>
      </div>
    </div>
  );
}

export function SessionsView({
  host,
  now,
  onTimeline,
}: {
  host: ControlState;
  now: number;
  onTimeline: (session: SessionOverview) => void;
}) {
  return (
    <View
      head={[
        'Page',
        'State',
        'Annotations',
        'Open/items',
        'Started',
        <span key="a" className="sr-only">
          Timeline
        </span>,
      ]}
      empty="No Sessions yet. Start one from Clients, or from the extension."
      rows={host.state.sessions.map((s) => (
        <TableRow key={s.id}>
          <TableCell className="max-w-72 truncate">{sessionPage(s)}</TableCell>
          <TableCell>
            <Badge variant={s.live ? 'default' : 'outline'}>{sessionState(s)}</Badge>
          </TableCell>
          <TableCell>{s.annotations}</TableCell>
          <TableCell>
            {s.open_items}/{s.items}
          </TableCell>
          <TableCell>{ago(now, s.t0 ?? s.created_at)}</TableCell>
          <TableCell className="text-right">
            <Button size="sm" variant="ghost" onClick={() => onTimeline(s)}>
              Timeline
            </Button>
          </TableCell>
        </TableRow>
      ))}
    />
  );
}

export function TimelineView({ host }: { host: ControlState }) {
  const timeline = host.state.timeline;
  const session = host.state.sessions.find((s) => s.id === timeline?.session_id);
  return (
    <div className="flex flex-col gap-2">
      {session && (
        <p className="text-muted-foreground text-sm">
          {sessionPage(session)} ({sessionState(session)})
        </p>
      )}
      <View
        head={['At', 'What', '']}
        empty={timeline ? 'Nothing yet.' : 'No live Session. Pick one in Sessions to see its timeline.'}
        rows={(timeline?.entries ?? []).map((e, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: entries have no id, and only grow at the end
          <TableRow key={i}>
            <TableCell className="font-mono">{clock(e.t)}</TableCell>
            <TableCell>
              <Badge variant="secondary">{e.kind}</Badge>
            </TableCell>
            <TableCell className="whitespace-normal">{e.text}</TableCell>
          </TableRow>
        ))}
      />
    </div>
  );
}

export function ItemsView({ host, now }: { host: ControlState; now: number }) {
  return (
    <View
      head={['Id', 'Status', 'Title', 'Resolution']}
      empty="No Change Items yet. They arrive when a Session is processed in the extension."
      rows={host.state.items.map((item) => (
        <TableRow key={item.id}>
          <TableCell className="font-mono">{item.id}</TableCell>
          <TableCell>
            <Badge variant={item.status === 'open' ? 'default' : 'outline'}>{STATUS_LABEL[item.status]}</Badge>
          </TableCell>
          <TableCell className="whitespace-normal">{item.title}</TableCell>
          <TableCell className="text-muted-foreground whitespace-normal">{resolutionLine(now, item)}</TableCell>
        </TableRow>
      ))}
    />
  );
}

export function AgentsView({ host }: { host: ControlState }) {
  return (
    <View
      head={['Watch', 'Origin', 'Session']}
      empty="No agent is waiting in watch_items. Connect one to /mcp."
      rows={host.state.watchers.map((w) => (
        <TableRow key={w.id}>
          <TableCell>watch #{w.id}</TableCell>
          <TableCell>{w.url ?? 'any origin'}</TableCell>
          <TableCell className="max-w-60 truncate">{w.session_id ?? 'any Session'}</TableCell>
        </TableRow>
      ))}
    />
  );
}

export function TokensView({
  host,
  port,
  now,
  onCreate,
  onRevoke,
}: {
  host: ControlState;
  /** The port the host listens on now: network mode keeps it. */
  port: string;
  now: number;
  onCreate: (name: string) => Promise<NewToken | null>;
  onRevoke: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <NewTokenDialog baseUrl={host.network?.base_url ?? `http://<this machine>:${port}`} onCreate={onCreate} />
      </div>
      <View
        head={[
          'For',
          'Id',
          'Created',
          'Last used',
          <span key="a" className="sr-only">
            Revoke
          </span>,
        ]}
        empty="No agent tokens. Agents on this machine need none; one on another machine needs a token (network mode)."
        rows={host.state.agent_tokens.map((t) => (
          <TableRow key={t.id}>
            <TableCell>{t.name}</TableCell>
            <TableCell className="font-mono">{t.id}</TableCell>
            <TableCell>{ago(now, t.created_at)}</TableCell>
            <TableCell>{ago(now, t.last_used_at)}</TableCell>
            <TableCell className="text-right">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" variant="ghost" aria-label={`Revoke the token for ${t.name}`}>
                    <Trash2 />
                    Revoke
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Revoke token</AlertDialogTitle>
                    <AlertDialogDescription>
                      Revoke the token for {t.name}? The agent is refused from then on.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => onRevoke(t.id)}>
                      Revoke
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </TableCell>
          </TableRow>
        ))}
      />
    </div>
  );
}

/** Name it, then see it once, with a copy button and the command for the agent's machine. */
function NewTokenDialog({
  baseUrl,
  onCreate,
}: {
  /** The network address, or a placeholder for it while network mode is off. */
  baseUrl: string;
  onCreate: (name: string) => Promise<NewToken | null>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [made, setMade] = useState<NewToken | null>(null);
  const [copied, setCopied] = useState(false);

  const reset = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setName('');
      setMade(null);
      setCopied(false);
    }
  };
  const create = async () => {
    const token = await onCreate(name.trim());
    if (token) setMade(token);
  };
  const copy = async () => {
    if (!made) return;
    await navigator.clipboard.writeText(made.token);
    setCopied(true);
  };

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus />
          New token
        </Button>
      </DialogTrigger>
      <DialogContent>
        {made ? (
          <>
            <DialogHeader>
              <DialogTitle>Token for {made.name}</DialogTitle>
              <DialogDescription>Shown once: copy it now. The agent sends it as its Bearer token.</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <Input readOnly value={made.token} className="font-mono" aria-label="The new token" />
              <Button variant="outline" onClick={copy}>
                <Copy />
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="text-muted-foreground text-sm">On the agent's machine:</p>
            <code className="bg-muted rounded-md p-2 font-mono text-xs break-all">
              inkup mcp install --remote {baseUrl} --token {made.token}
            </code>
            {baseUrl.includes('<this machine>') && (
              <p className="text-muted-foreground text-sm">It works once network mode is on.</p>
            )}
            <DialogFooter>
              <Button onClick={() => reset(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <DialogHeader>
              <DialogTitle>New agent token</DialogTitle>
              <DialogDescription>For an agent on another machine. Who is it for?</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="token-name">Name</Label>
              <Input
                id="token-name"
                placeholder="claude-code on laptop"
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={name.trim() === ''}>
                <KeyRound />
                Create
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
