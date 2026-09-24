// "Upload N earlier Sessions": Sessions recorded before this browser paired with its Host (or while it was paired with
// another one) never streamed, so the Host lacks them. The options page's Host section offers them while there are
// any; the Sessions page and the side panel show the offer once per pairing, until the reviewer uploads or says Not now.
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { db } from '@/db';
import { useStorageItem } from '@/lib/use-storage-item';
import { sendMessage } from '@/messaging';
import { hostStatus } from '@/session-state';
import { hostBackfillNoticed, hostPairing } from '@/settings';

const sessions = (n: number) => `${n} earlier ${n === 1 ? 'Session' : 'Sessions'}`;

export function HostBackfill({ variant }: { variant: 'section' | 'notice' }) {
  const pairing = useStorageItem(hostPairing);
  const status = useStorageItem(hostStatus);
  const noticed = useStorageItem(hostBackfillNoticed);
  // Asked again whenever the outbox empties or fills, so the offer follows what is on its way, and every few seconds
  // (a Session can end, or the Host can be asked again after a failed look).
  const waiting = useLiveQuery(() => db.outbox.count(), [], 0);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const connected = status?.state === 'connected';
  // The notice asks nothing once it was answered for this pairing.
  const offering = variant === 'section' || (noticed !== undefined && noticed !== pairing?.client_id);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the outbox emptying or filling, and a new pairing, are triggers to ask again, not values read
  useEffect(() => {
    if (!connected || !offering) return setCount(0);
    let live = true;
    const ask = () =>
      void sendMessage('hostBackfillOffer')
        .then((r) => live && setCount(r.sessions))
        .catch(() => live && setCount(0));
    ask();
    const timer = setInterval(ask, 5_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [connected, offering, waiting === 0, pairing?.client_id]);

  if (!pairing || !offering || count === 0) return null;

  async function upload() {
    setBusy(true);
    try {
      await sendMessage('hostBackfill');
      await hostBackfillNoticed.setValue(pairing!.client_id);
      setCount(0);
    } finally {
      setBusy(false);
    }
  }

  const button = (
    <Button size="sm" onClick={() => void upload()} disabled={busy} data-testid="host-backfill">
      Upload {sessions(count)}
    </Button>
  );
  if (variant === 'section') {
    return (
      <div className="flex flex-col items-start gap-2" data-testid="host-backfill-offer" data-count={count}>
        <p className="text-muted-foreground">
          {count === 1 ? 'A Session' : `${count} Sessions`} recorded here before pairing {count === 1 ? 'is' : 'are'}{' '}
          not on the host.
        </p>
        {button}
      </div>
    );
  }
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-md border p-3"
      data-testid="host-backfill-notice"
      data-count={count}
    >
      <p>
        The host has only what was recorded since pairing. Upload {sessions(count)} so its agents can see{' '}
        {count === 1 ? 'it' : 'them'} too?
      </p>
      <div className="flex gap-2">
        {button}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void hostBackfillNoticed.setValue(pairing.client_id)}
          data-testid="host-backfill-dismiss"
        >
          Not now
        </Button>
      </div>
    </div>
  );
}
