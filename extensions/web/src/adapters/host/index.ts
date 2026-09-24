// The Host adapter (ADR 0004, ADR 0005, ADR 0006): the WebSocket client, blob uploads and finding a Host on the
// LAN, over @inkup/protocol. The service
// worker's host client (src/background/host-client.ts) owns the connection and the outbox.
import type { ClientKind } from '@inkup/protocol';
import { HostRefused } from './connection';

export {
  type CommandOutcome,
  type ConnectOptions,
  connectHost,
  type Hello,
  type HostConnection,
  HostRefused,
  socketUrl,
  type Welcome,
} from './connection';
export {
  type FoundHost,
  HOST_PORT,
  isLoopbackUrl,
  LOCAL_NAMES,
  normalizeAddress,
  parsePairLink,
  probeHosts,
  probeList,
} from './discovery';

/** Where the Host listens unless the reviewer says otherwise (inkup serve --port). */
export const DEFAULT_HOST_URL = 'http://127.0.0.1:47823';

/** Reconnect delay: 0.5 s doubling to 10 s, ±20% so several Clients do not retry in step. */
export function backoffMs(attempt: number, random = Math.random): number {
  return Math.round(Math.min(10_000, 500 * 2 ** attempt) * (0.8 + 0.4 * random()));
}

/** Uploads one blob under the extension's own id. Idempotent: a resend replaces the bytes. */
export async function putBlob(
  baseUrl: string,
  token: string,
  blob: { id: string; sessionId: string; data: Blob },
): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, '')}/blobs/${encodeURIComponent(blob.id)}?session_id=${encodeURIComponent(blob.sessionId)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': blob.data.type || 'application/octet-stream' },
    body: blob.data,
  });
  if (res.ok) return;
  if (res.status === 401) throw new HostRefused('unknown_token', 'The host no longer knows this browser.');
  // The host will never take this one (a bad id, too large): the caller drops it.
  if (res.status === 400 || res.status === 413)
    throw new HostRefused('bad_message', `The host refused blob ${blob.id}: ${res.status}`);
  throw new Error(`Uploading blob ${blob.id} failed: ${res.status}`);
}

/** What the Host holds, per Session: the read API's `/api/sessions` (only the fields a Client uses). */
export interface HostedSession {
  id: string;
  event_count: number;
}

export async function hostedSessions(baseUrl: string, token: string): Promise<HostedSession[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/sessions`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new HostRefused('unknown_token', 'The host no longer knows this browser.');
  if (!res.ok) throw new Error(`Listing the host's Sessions failed: ${res.status}`);
  return (await res.json()) as HostedSession[];
}

/** How this browser introduces itself when it pairs. */
export function clientIdentity(browser: string, platform: string): { client_kind: ClientKind; client_name: string } {
  const kind: ClientKind = browser === 'chrome' || browser === 'firefox' || browser === 'safari' ? browser : 'other';
  const label = { chrome: 'Chrome', firefox: 'Firefox', safari: 'Safari', other: 'Browser' }[kind];
  return { client_kind: kind, client_name: platform ? `${label} on ${platform}` : label };
}
