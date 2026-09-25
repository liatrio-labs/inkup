// A quiet line about the paired Host (ADR 0004). Nothing at all while unpaired: the panel is the same as without a
// Host. Offline, capture carries on and the outbox syncs later. A Host on another computer says it is unencrypted.
import { useLiveQuery } from 'dexie-react-hooks';
import { isLoopbackUrl } from '@/adapters/host';
import { TONE } from '@/components/tone';
import { db } from '@/db';
import { useStorageItem } from '@/lib/use-storage-item';
import { cn } from '@/lib/utils';
import { hostStatus } from '@/session-state';
import { hostPairing } from '@/settings';

export function HostIndicator() {
  const pairing = useStorageItem(hostPairing);
  const status = useStorageItem(hostStatus);
  const waiting = useLiveQuery(() => db.outbox.count(), [], 0);
  if (!pairing || !status) return null;
  const connected = status.state === 'connected';
  const label = connected
    ? 'Host connected'
    : status.state === 'offline' && !status.retry
      ? 'Host: pair again in Settings'
      : `Host offline, will sync${waiting ? ` (${waiting})` : ''}`;
  const title = [
    status.state === 'offline' ? status.error : null,
    isLoopbackUrl(pairing.url) ? null : 'Unencrypted network hub',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span
      data-testid="host-indicator"
      data-state={status.state}
      className="flex items-center gap-1.5"
      title={title || undefined}
    >
      <span aria-hidden className={cn('size-2 rounded-full', connected ? TONE.okDot : 'bg-muted-foreground/50')} />
      {label}
    </span>
  );
}
