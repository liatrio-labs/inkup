// A dot on the toolbar icon that says where the Session data goes: green when a paired Host is connected, blue when the
// extension works on its own (no Host paired; everything works locally), amber while a paired Host is unreachable
// (captures queue in the outbox and sync when it is back). Drawn as the action badge with blank text, which every
// browser renders as a small coloured dot at the icon's corner.

import { hostStatus } from '@/session-state';
import type { HostStatus } from '@/settings';

export type HostDot = { color: string; title: string };

export const HOST_DOT_COLORS = { connected: '#16a34a', local: '#2563eb', offline: '#d97706' } as const;

export function hostDot(status: HostStatus): HostDot {
  switch (status.state) {
    case 'connected':
      return { color: HOST_DOT_COLORS.connected, title: 'InkUp: connected to the Host' };
    case 'unpaired':
      return { color: HOST_DOT_COLORS.local, title: 'InkUp: local only (no Host paired)' };
    case 'pairing':
    case 'connecting':
      return { color: HOST_DOT_COLORS.offline, title: 'InkUp: connecting to the Host' };
    case 'offline':
      return { color: HOST_DOT_COLORS.offline, title: 'InkUp: Host offline, captures will sync when it is back' };
  }
}

async function show(status: HostStatus): Promise<void> {
  const dot = hostDot(status);
  await chrome.action.setBadgeBackgroundColor({ color: dot.color });
  await chrome.action.setBadgeText({ text: ' ' });
  await chrome.action.setTitle({ title: dot.title });
}

export function initHostDot(): void {
  void hostStatus.getValue().then(show);
  hostStatus.watch((status) => void show(status));
}
