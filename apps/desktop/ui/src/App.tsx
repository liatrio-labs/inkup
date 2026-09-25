// The window: what the TUI shows and does, from the host through the app's commands. The header (where the host
// is, host or client mode, network mode, the menu bar and Dock), the banners (network warning, update, host lost),
// the six views and the pairing prompt. It refetches when the host changes (a long-poll), not on a timer.
// Off-the-shelf shadcn components only.
import { listen } from '@tauri-apps/api/event';
import { Server, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Toaster } from '@/components/ui/sonner';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  answerPairing,
  type ClientView,
  type ControlState,
  createToken,
  desktopToggles,
  type HostView,
  hostChanges,
  hostHere,
  hostState,
  hostView,
  KIND,
  NETWORK_ELSEWHERE,
  NETWORK_WARNING,
  type PairingPrompt,
  pairingQr,
  revokeToken,
  sendCommand,
  setDesktopToggles,
  setNetwork,
  spacedCode,
  TOGGLES_EVENT,
  type Toggles,
  VIEW_EVENT,
} from './host';
import { AgentsView, ClientsView, type Command, ItemsView, SessionsView, TimelineView, TokensView } from './Views';

/** Changes close together make one refetch. */
const REFETCH_MS = 150;
/** After the host did not answer, before asking again. */
const RETRY_MS = 1000;

export const TABS = ['clients', 'sessions', 'timeline', 'items', 'agents', 'tokens'] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [view, setView] = useState<HostView | null>(null);
  const [host, setHost] = useState<ControlState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggles, setToggles] = useState<Toggles | null>(null);
  const [tab, setTab] = useState<Tab>('sessions');
  const [now, setNow] = useState(() => Date.now());
  /** The Session whose timeline to show; unset: the newest live one. */
  const [timeline, setTimeline] = useState<string | undefined>();
  const [drawing, setDrawing] = useState<Record<string, boolean>>({});
  const [asking, setAsking] = useState<'on' | 'off' | null>(null);
  const [answered, setAnswered] = useState<number[]>([]);
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;

  const refresh = useCallback(async () => {
    try {
      setHost(await hostState(timelineRef.current));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    setNow(Date.now());
  }, []);

  // Refetch on every change the host reports; retry while it does not answer.
  useEffect(() => {
    let stopped = false;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(pending);
      pending = setTimeout(refresh, REFETCH_MS);
    };
    (async () => {
      let since = 0;
      while (!stopped) {
        try {
          since = await hostChanges(since);
          soon();
        } catch (e) {
          setError(String(e));
          await new Promise((r) => setTimeout(r, RETRY_MS));
          // A restarted host counts from 0 again: start over, which answers at once.
          since = 0;
        }
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(pending);
    };
  }, [refresh]);

  useEffect(() => {
    hostView().then(setView, (e) => setError(String(e)));
    desktopToggles().then(setToggles, () => {});
    // "5m ago" moves on without a change.
    const clock = setInterval(() => setNow(Date.now()), 15_000);
    const unlisten = [
      listen<Toggles>(TOGGLES_EVENT, (e) => setToggles(e.payload)),
      listen<HostView>(VIEW_EVENT, (e) => {
        setView(e.payload);
        refresh();
      }),
    ];
    return () => {
      clearInterval(clock);
      for (const u of unlisten) u.then((off) => off()).catch(() => {});
    };
  }, [refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a Session picked for the timeline refetches at once
  useEffect(() => {
    refresh();
  }, [timeline, refresh]);

  const command = async (client: ClientView, asked: Command) => {
    try {
      const outcome = await sendCommand({ client_id: client.id, ...asked });
      if (!outcome.ok) {
        toast.error(outcome.message ?? `${client.name} refused.`);
        return;
      }
      const session = outcome.session_id;
      if (asked.command === 'set_draw_mode' && session) {
        setDrawing((d) => ({ ...d, [session]: asked.draw_mode ?? false }));
      }
      toast.success(DONE[asked.command](client.name, asked.draw_mode));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const create = async (name: string) => {
    try {
      return await createToken(name);
    } catch (e) {
      toast.error(String(e));
      return null;
    }
  };

  const revoke = async (id: string) => {
    try {
      await revokeToken(id);
      toast.success('Token revoked.');
    } catch (e) {
      toast.error(String(e));
    }
  };

  const switchNetwork = async (on: boolean) => {
    setAsking(null);
    try {
      if (!(await setNetwork(on))) toast.error('This host switches network mode in its own terminal.');
    } catch (e) {
      toast.error(String(e));
    }
  };

  const takeOver = async () => {
    try {
      setView(await hostHere());
      setError(null);
      refresh();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const toggle = async (next: Toggles) => {
    try {
      setToggles(await setDesktopToggles(next));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const answer = async (prompt: PairingPrompt, decision: 'approve' | 'deny') => {
    setAnswered((a) => [...a, prompt.id]);
    try {
      await answerPairing(prompt.id, decision);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const hostLost = view?.mode === 'client' && error !== null;
  const counts: Record<Tab, number | null> = {
    clients: host?.state.clients.length ?? null,
    sessions: host?.state.sessions.length ?? null,
    timeline: null,
    items: host?.state.items.length ?? null,
    agents: host?.state.watchers.length ?? null,
    tokens: host?.state.agent_tokens.length ?? null,
  };
  const prompt = host?.pending_pairing.find((p) => !answered.includes(p.id));

  return (
    <TooltipProvider>
      <main className="flex min-h-screen flex-col gap-4 p-4">
        <Card className="gap-3 py-4">
          <CardHeader className="px-4">
            <CardTitle className="flex items-center gap-2">
              InkUp
              {view && <Badge variant={view.mode === 'host' ? 'default' : 'secondary'}>{view.mode}</Badge>}
            </CardTitle>
            <CardDescription data-testid="host-address">
              {view
                ? `${view.mode === 'host' ? 'Hosting' : `Client of ${KIND[view.kind]}`} on ${view.address}`
                : 'Connecting…'}
              {host && ` · inkup ${host.version}`}
            </CardDescription>
            <CardAction className="flex items-center gap-4">
              <NetworkSwitch view={view} host={host} onAsk={(on) => setAsking(on ? 'on' : 'off')} />
              {toggles && <IconToggles toggles={toggles} onChange={toggle} />}
            </CardAction>
          </CardHeader>
        </Card>

        {hostLost ? (
          <Alert variant="destructive">
            <Server />
            <AlertTitle>The InkUp host stopped</AlertTitle>
            <AlertDescription>
              <p>
                {view && KIND[view.kind]} on {view?.address} does not answer. Host here to keep InkUp running in this
                app.
              </p>
              <Button size="sm" className="mt-2" onClick={takeOver}>
                Host here
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          error && (
            <Alert variant="destructive">
              <AlertTitle>The InkUp host did not answer</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )
        )}
        {host?.network && (
          <Alert>
            <TriangleAlert />
            <AlertTitle>{NETWORK_WARNING}</AlertTitle>
            <AlertDescription>
              {[host.network.claimed ?? 'no .local name yet', ...host.network.addresses].join(' · ')}. Other machines
              reach it at {host.network.base_url}.
            </AlertDescription>
          </Alert>
        )}
        {host?.update && (
          <Alert>
            <AlertTitle>Update available</AlertTitle>
            <AlertDescription>{host.update}</AlertDescription>
          </Alert>
        )}

        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList>
            {TABS.map((t) => (
              <TabsTrigger key={t} value={t}>
                {TAB_TITLE[t]}
                {counts[t] !== null && ` (${counts[t]})`}
              </TabsTrigger>
            ))}
          </TabsList>
          {host && (
            <>
              <TabsContent value="clients">
                <ClientsView host={host} now={now} drawing={drawing} onCommand={command} />
              </TabsContent>
              <TabsContent value="sessions">
                <SessionsView
                  host={host}
                  now={now}
                  onTimeline={(s) => {
                    setTimeline(s.id);
                    setTab('timeline');
                  }}
                />
              </TabsContent>
              <TabsContent value="timeline">
                <TimelineView host={host} />
              </TabsContent>
              <TabsContent value="items">
                <ItemsView host={host} now={now} />
              </TabsContent>
              <TabsContent value="agents">
                <AgentsView host={host} now={now} />
              </TabsContent>
              <TabsContent value="tokens">
                <TokensView host={host} now={now} onCreate={create} onRevoke={revoke} />
              </TabsContent>
            </>
          )}
        </Tabs>

        <AlertDialog open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Network mode</AlertDialogTitle>
              <AlertDialogDescription asChild>
                {asking === 'on' ? (
                  <div className="flex flex-col gap-2">
                    <p>Listen on every interface so other machines on this LAN can pair and send Sessions?</p>
                    <p className="text-foreground font-medium">{NETWORK_WARNING}</p>
                    <p>Agents on other machines need a token. The server restarts; Clients reconnect.</p>
                  </div>
                ) : (
                  <p>
                    Listen on this machine only? Other machines are cut off. The server restarts; Clients on this
                    machine reconnect.
                  </p>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => switchNetwork(asking === 'on')}>
                {asking === 'on' ? 'Turn it on' : 'Turn it off'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {prompt && <PairingDialog key={prompt.id} prompt={prompt} onAnswer={(d) => answer(prompt, d)} />}
        <Toaster />
      </main>
    </TooltipProvider>
  );
}

const TAB_TITLE: Record<Tab, string> = {
  clients: 'Clients',
  sessions: 'Sessions',
  timeline: 'Timeline',
  items: 'Items',
  agents: 'Agents',
  tokens: 'Tokens',
};

/** What a command did, once its Client said ok. */
const DONE: Record<Command['command'], (client: string, on?: boolean) => string> = {
  start_session: (c) => `Started a Session on ${c}.`,
  pause: (c) => `Paused on ${c}.`,
  resume: (c) => `Resumed on ${c}.`,
  stop: (c) => `Stopped on ${c}.`,
  set_draw_mode: (c, on) => `Draw mode ${on ? 'on' : 'off'} on ${c}.`,
};

/** Network mode: switched here when this app hosts; otherwise where the host is, in a tooltip. */
function NetworkSwitch({
  view,
  host,
  onAsk,
}: {
  view: HostView | null;
  host: ControlState | null;
  onAsk: (on: boolean) => void;
}) {
  const here = view?.mode === 'host' && host?.network_switch === true;
  const on = host?.network != null;
  const control = (
    <div className="flex items-center gap-2">
      <Switch id="network" checked={on} disabled={!here} onCheckedChange={onAsk} />
      <Label htmlFor="network">Network mode</Label>
    </div>
  );
  if (here) return control;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled switch gets no pointer events: the wrapper takes the hover, and keyboard focus. */}
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so the tooltip shows on focus too */}
        <span tabIndex={0} data-testid="network-elsewhere">
          {control}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {view ? `This app is a client of ${KIND[view.kind]}. ${NETWORK_ELSEWHERE[view.kind]}` : 'Connecting…'}
      </TooltipContent>
    </Tooltip>
  );
}

/** Where the app's icons show. The last one on cannot be turned off, or the app could not be reached. */
function IconToggles({ toggles, onChange }: { toggles: Toggles; onChange: (next: Toggles) => void }) {
  return (
    <>
      <div className="flex items-center gap-2">
        <Switch
          id="menubar"
          checked={toggles.menubar}
          disabled={!toggles.dock}
          onCheckedChange={(menubar) => onChange({ ...toggles, menubar })}
        />
        <Label htmlFor="menubar">Menu bar</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id="dock"
          checked={toggles.dock}
          disabled={!toggles.menubar}
          onCheckedChange={(dock) => onChange({ ...toggles, dock })}
        />
        <Label htmlFor="dock">Dock</Label>
      </div>
    </>
  );
}

/** A pairing request. From another machine: its code, big, and a QR code of the pair link. That one can only be
 * refused here: the Client pairs by typing the code. */
function PairingDialog({
  prompt,
  onAnswer,
}: {
  prompt: PairingPrompt;
  onAnswer: (decision: 'approve' | 'deny') => void;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const link = prompt.remote?.link;
  useEffect(() => {
    if (link) pairingQr(link).then(setQr, () => setQr(null));
  }, [link]);

  return (
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {prompt.remote ? 'Pairing request from another machine' : 'Pairing request'}
          </AlertDialogTitle>
          <AlertDialogDescription>{prompt.prompt}</AlertDialogDescription>
        </AlertDialogHeader>
        {prompt.remote ? (
          <div className="flex flex-col items-center gap-3 text-sm">
            <p>Type this code in the extension:</p>
            <p className="font-mono text-3xl font-semibold tracking-widest" data-testid="pairing-code">
              {spacedCode(prompt.remote.code)}
            </p>
            {qr && (
              <>
                <p>or scan it with the extension's Scan QR:</p>
                <img
                  src={`data:image/svg+xml;utf8,${encodeURIComponent(qr)}`}
                  alt={`QR code of ${prompt.remote.link}`}
                  className="size-40 rounded-md bg-white"
                />
              </>
            )}
            <p className="text-muted-foreground">It expires in 2 minutes.</p>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">Paired, it can stream Sessions and receive commands.</p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onAnswer('deny')}>{prompt.remote ? 'Refuse' : 'Decline'}</AlertDialogCancel>
          {!prompt.remote && <AlertDialogAction onClick={() => onAnswer('approve')}>Pair</AlertDialogAction>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
