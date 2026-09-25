// The window: what the TUI shows, from the host through the app's commands. Slice 1: the header, Sessions and
// Clients, polled every second. Off-the-shelf shadcn components only.
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ago,
  type ControlState,
  clientState,
  type HostView,
  hostState,
  hostView,
  sessionPage,
  sessionState,
} from './host';

const POLL_MS = 1000;
const KIND = { desktop: 'this app', tui: 'the inkup TUI', serve: 'inkup serve' } as const;

export function App() {
  const [view, setView] = useState<HostView | null>(null);
  const [host, setHost] = useState<ControlState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      setHost(await hostState());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    hostView().then(setView, (e) => setError(String(e)));
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const sessions = host?.state.sessions ?? [];
  const clients = host?.state.clients ?? [];

  return (
    <main className="flex min-h-screen flex-col gap-4 p-4">
      <Card className="gap-2 py-4">
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
          <CardAction>
            <Button variant="outline" size="sm" onClick={refresh}>
              <RefreshCw />
              Refresh
            </Button>
          </CardAction>
        </CardHeader>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>The InkUp host did not answer</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {host?.update && (
        <Alert>
          <AlertTitle>Update available</AlertTitle>
          <AlertDescription>{host.update}</AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="sessions">
        <TabsList>
          <TabsTrigger value="sessions">Sessions ({sessions.length})</TabsTrigger>
          <TabsTrigger value="clients">Clients ({clients.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="sessions">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Page</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Annotations</TableHead>
                <TableHead className="text-right">Open/items</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">
                    No Sessions yet. Start one from the extension.
                  </TableCell>
                </TableRow>
              ) : (
                sessions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="max-w-80 truncate">{sessionPage(s)}</TableCell>
                    <TableCell>
                      <Badge variant={s.live ? 'default' : 'outline'}>{sessionState(s)}</Badge>
                    </TableCell>
                    <TableCell className="text-right">{s.annotations}</TableCell>
                    <TableCell className="text-right">
                      {s.open_items}/{s.items}
                    </TableCell>
                    <TableCell>{ago(now, s.t0 ?? s.created_at)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TabsContent>
        <TabsContent value="clients">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    No paired clients. Pair from the extension's Settings.
                  </TableCell>
                </TableRow>
              ) : (
                clients.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.name}</TableCell>
                    <TableCell>{c.kind}</TableCell>
                    <TableCell>
                      <Badge variant={c.connected ? 'default' : 'outline'}>{clientState(c, sessions)}</Badge>
                    </TableCell>
                    <TableCell>{ago(now, c.last_seen_at)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TabsContent>
      </Tabs>
    </main>
  );
}
