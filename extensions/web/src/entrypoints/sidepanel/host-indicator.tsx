// A quiet line about the paired Host (ADR 0004): @inkup/ui's HostIndicator, fed from the pairing, the Host status and
// the outbox. Nothing at all while unpaired: the panel is the same as without a Host.

import { HostIndicator as HostIndicatorView } from '@inkup/ui';
import { useLiveQuery } from 'dexie-react-hooks';
import { isLoopbackUrl } from '@/adapters/host';
import { db } from '@/db';
import { useStorageItem } from '@/lib/use-storage-item';
import { hostStatus } from '@/session-state';
import { hostPairing } from '@/settings';

export function HostIndicator() {
  const pairing = useStorageItem(hostPairing);
  const status = useStorageItem(hostStatus);
  const waiting = useLiveQuery(() => db.outbox.count(), [], 0);
  if (!pairing || !status) return null;
  return <HostIndicatorView status={status} waiting={waiting} network={!isLoopbackUrl(pairing.url)} />;
}
