// A quiet line about the paired Host (ADR 0004), drawn from props alone (R1.2). The caller renders it only while
// paired: unpaired, the panel is the same as without a Host. Offline, capture carries on and the outbox syncs later;
// `waiting` is how much is queued. A Host on another computer says it is unencrypted.

import { cn } from '../lib/utils';
import { TONE } from './tone';

export type HostIndicatorStatus =
  | { state: 'unpaired' | 'pairing' | 'connecting' }
  | { state: 'connected' }
  | { state: 'offline'; error: string; retry: boolean };

export interface HostIndicatorProps {
  status: HostIndicatorStatus;
  /** Rows in the outbox, waiting to sync. */
  waiting: number;
  /** The Host is on another computer (not loopback), so the hub is unencrypted. */
  network: boolean;
}

export function HostIndicator({ status, waiting, network }: HostIndicatorProps) {
  const connected = status.state === 'connected';
  const label = connected
    ? 'Host connected'
    : status.state === 'offline' && !status.retry
      ? 'Host: pair again in Settings'
      : `Host offline, will sync${waiting ? ` (${waiting})` : ''}`;
  const title = [status.state === 'offline' ? status.error : null, network ? 'Unencrypted network hub' : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <span
      data-testid="host-indicator"
      data-state={status.state}
      className="flex items-center gap-1.5"
      title={title || undefined}
    >
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', connected ? TONE.okDot : TONE.restDot)} />
      {label}
    </span>
  );
}
