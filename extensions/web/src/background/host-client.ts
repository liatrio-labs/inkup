// The service worker's side of the Host (ADR 0004): pairing, one live connection with backoff reconnects, and the
// outbox drain; commands from the Host's user go to ./host-commands.ts. Capture never waits on any of this: events
// land in Dexie first, and the outbox catches the Host up whenever it is reachable, so a Host that goes away
// mid-Session loses nothing.
import type { ResolutionMessage } from '@inkup/protocol';
import {
  backoffMs,
  clientIdentity,
  connectHost,
  type FoundHost,
  type HostConnection,
  HostRefused,
  hostedSessions,
  probeHosts,
  probeList,
  putBlob,
} from '@/adapters/host';
import { db, type OutboxRow } from '@/db';
import { onOutboxAdded, queueSessionForHost } from '@/db/outbox';
import { currentChangeItems } from '@/db/review';
import type { HostPairResult } from '@/messaging';
import { hostCapabilities, hostStatus } from '@/session-state';
import {
  discardPending,
  type HostStatus,
  hostAddresses,
  hostPairing,
  hostProbeOverride,
  hostRevokePending,
} from '@/settings';
import { runHostCommand } from './host-commands';

/** Pairing waits for a person at the Host; the Host itself gives up after two minutes. */
const PAIRING_TIMEOUT_MS = 150_000;
/** A backstop: anything a missed notification left in the outbox goes within this. */
const SWEEP_MS = 5_000;
const BATCH = 100;
/** Forget waits this long for what is on the wire to be acked, and this long for the Host to revoke the token. */
const FORGET_DRAIN_MS = 10_000;
const REVOKE_MS = 5_000;

let conn: HostConnection | null = null;
let connecting = false;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** The drain in progress, if any: Forget waits for it. */
let draining: Promise<void> | null = null;
let drainAgain = false;
/** Forget is under way: nothing more leaves the outbox. */
let halted = false;

function hello() {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    '';
  return clientIdentity(import.meta.env.BROWSER, platform);
}

const setStatus = (status: HostStatus) => hostStatus.setValue(status);

/** Kept by id, so the replay after each welcome changes nothing; the review page shows the latest per item. */
function storeResolution(r: ResolutionMessage) {
  const { resolution_id, session_id, run_id, item_id, status, note, source, agent, created_at } = r;
  void db.resolutions
    .put({
      id: resolution_id,
      session_id,
      run_id,
      item_id,
      status,
      note,
      source,
      ...(agent ? { agent } : {}),
      created_at,
    })
    .catch((e: unknown) => console.warn('host: could not store a resolution', e));
}

export function initHostClient(): void {
  onOutboxAdded(() => void drain());
  hostPairing.watch((pairing) => {
    if (pairing) void connect();
    else disconnect();
  });
  setInterval(() => conn && void drain(), SWEEP_MS);
  void hostPairing.getValue().then((pairing) => (pairing ? connect() : setStatus({ state: 'unpaired' })));
  void revokePending();
}

/**
 * Options page: pair with the Host at `url`. On this machine its user approves in the TUI or terminal. On another
 * machine (ADR 0006) the first try makes the Host show a code and answers `needsCode`; the reviewer types it (or
 * it came in a pair link) and the second try, with `code`, pairs.
 */
export async function pairHost({ url, code }: { url: string; code?: string }): Promise<HostPairResult> {
  disconnect();
  void revokePending();
  await setStatus({ state: 'pairing' });
  try {
    const c = await connectHost(
      url,
      { ...hello(), ...(code ? { pairing_code: code } : {}) },
      { timeoutMs: PAIRING_TIMEOUT_MS, onResolution: storeResolution, onCommand: runHostCommand },
    );
    if (!c.token) throw new Error('The host did not issue a token.');
    adopt(c);
    await hostPairing.setValue({
      url,
      token: c.token,
      client_id: c.welcome.client_id,
      paired_at: new Date().toISOString(),
    });
    await hostAddresses.setValue([url, ...(await hostAddresses.getValue()).filter((a) => a !== url)].slice(0, 10));
    await connected(c);
    return { ok: true };
  } catch (e) {
    await setStatus({ state: 'unpaired' });
    return pairingRefused(e);
  }
}

function pairingRefused(e: unknown): HostPairResult {
  if (!(e instanceof HostRefused)) return { ok: false, error: e instanceof Error ? e.message : String(e) };
  switch (e.code) {
    case 'pairing_code_required':
      return { ok: false, needsCode: true, error: 'Enter the 6-digit code the host shows.' };
    case 'wrong_pairing_code':
      return {
        ok: false,
        needsCode: true,
        error: `Wrong code: ${e.message.replace(/^that is not the code inkup shows; /, '')}.`,
      };
    case 'pairing_denied':
      return {
        ok: false,
        error: /wrong codes/.test(e.message)
          ? 'Too many wrong codes: pairing was refused. Connect again for a new code.'
          : 'Pairing was declined at the host.',
      };
    case 'pairing_timeout':
      return { ok: false, error: 'The code expired or was already used. Connect again for a new code.' };
    default:
      return { ok: false, error: e.message };
  }
}

/** Options page, Find hubs: the `.local` names and the saved addresses (or the tests' list), probed at once. */
export async function findHosts(): Promise<FoundHost[]> {
  const urls = (await hostProbeOverride.getValue()) ?? probeList(await hostAddresses.getValue());
  return probeHosts(urls);
}

/**
 * Options page: forget the Host. The outbox stops, what is already on the wire is let finish, and then the Host is
 * asked to revoke this browser's token, before the token and everything not sent yet are dropped here. Nothing is
 * sent after Forget. A Host that cannot be reached is asked again when it can be (`hostRevokePending`).
 */
export async function forgetHost(): Promise<{ revoked: boolean }> {
  halted = true;
  try {
    await within(draining ?? Promise.resolve(), FORGET_DRAIN_MS);
    const pairing = await hostPairing.getValue();
    // Kept open for the revoke, but no longer the connection: its close schedules no reconnect.
    const c = conn;
    conn = null;
    clearTimeout(retryTimer);
    let revoked = true;
    if (pairing) {
      revoked = await revoke(pairing, c);
      if (!revoked)
        await hostRevokePending.setValue([
          ...(await hostRevokePending.getValue()),
          { url: pairing.url, token: pairing.token },
        ]);
    }
    c?.close();
    await hostPairing.setValue(null);
    await db.outbox.clear();
    await setStatus({ state: 'unpaired' });
    return { revoked };
  } finally {
    halted = false;
  }
}

/** Resolves when `p` settles or after `ms`, whichever is first. */
const within = (p: Promise<unknown>, ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void p.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * Asks the Host to revoke `pairing`'s token, over `open` if it is the live connection, else over a connection of its
 * own. True once the Host has, or when it no longer knows the token; false when it could not be reached.
 */
async function revoke(pairing: { url: string; token: string }, open: HostConnection | null): Promise<boolean> {
  let c = open;
  try {
    c ??= await connectHost(pairing.url, { ...hello(), token: pairing.token }, { timeoutMs: REVOKE_MS });
    // A Host from before Forget revoked tokens cannot be asked; nothing will change that, so do not keep asking.
    if (!c.welcome.capabilities.includes('forget')) return true;
    await Promise.race([
      c.sendForget(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('The host did not answer.')), REVOKE_MS)),
    ]);
    return true;
  } catch (e) {
    if (e instanceof HostRefused && e.code === 'unknown_token') return true;
    console.warn('host: could not revoke the token', e);
    return false;
  } finally {
    c?.close();
  }
}

/** Tokens a Forget could not revoke: asked again at start and before each pairing. */
async function revokePending(): Promise<void> {
  const pending = await hostRevokePending.getValue();
  if (pending.length === 0) return;
  const done = new Set<string>();
  for (const p of pending) if (await revoke(p, null)) done.add(p.token);
  if (done.size > 0)
    await hostRevokePending.setValue((await hostRevokePending.getValue()).filter((p) => !done.has(p.token)));
}

/**
 * Sessions stored here that the paired Host lacks events of: recorded before pairing, or while paired with another
 * Host. Ended ones only, none the reviewer is cancelling, and none with rows in the outbox (they are on their way).
 * Null when the Host cannot be asked.
 */
export async function backfillCandidates(): Promise<string[] | null> {
  const pairing = await hostPairing.getValue();
  if (!pairing || !(await hostCapabilities()).has('events')) return null;
  let hosted: Map<string, number>;
  try {
    hosted = new Map((await hostedSessions(pairing.url, pairing.token)).map((s) => [s.id, s.event_count]));
  } catch (e) {
    console.warn('host: could not list its Sessions', e);
    return null;
  }
  const held = new Set((await discardPending.getValue()).map((p) => p.session_id));
  const queued = new Set(await db.outbox.orderBy('session_id').uniqueKeys());
  const ended = (await db.sessions.toArray()).filter(
    (s) => s.status === 'ended' && !held.has(s.id) && !queued.has(s.id),
  );
  const counts = await Promise.all(ended.map((s) => db.events.where('session_id').equals(s.id).count()));
  return ended.filter((s, i) => (hosted.get(s.id) ?? 0) < counts[i]!).map((s) => s.id);
}

/** "Upload N earlier Sessions": queues each candidate whole. Returns how many were queued. */
export async function backfill(): Promise<number> {
  const ids = (await backfillCandidates()) ?? [];
  let queued = 0;
  for (const id of ids) if (await queueSessionForHost(id)) queued++;
  return queued;
}

function disconnect() {
  clearTimeout(retryTimer);
  const c = conn;
  conn = null;
  c?.close();
}

async function connect(): Promise<void> {
  clearTimeout(retryTimer);
  if (conn || connecting) return;
  const pairing = await hostPairing.getValue();
  if (!pairing) return;
  connecting = true;
  if ((await hostStatus.getValue()).state !== 'offline') await setStatus({ state: 'connecting' });
  try {
    const c = await connectHost(
      pairing.url,
      { ...hello(), token: pairing.token },
      { onResolution: storeResolution, onCommand: runHostCommand },
    );
    if (!(await hostPairing.getValue())) return c.close();
    adopt(c);
    await connected(c);
  } catch (e) {
    if (e instanceof HostRefused && e.code === 'unknown_token') {
      await setStatus({
        state: 'offline',
        error: 'This host no longer knows this browser. Forget it and pair again.',
        retry: false,
      });
      return;
    }
    await setStatus({ state: 'offline', error: e instanceof Error ? e.message : String(e), retry: true });
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function scheduleReconnect() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void connect(), backoffMs(attempt++));
}

function adopt(c: HostConnection) {
  conn = c;
  attempt = 0;
  void c.closed.then(async () => {
    if (conn !== c) return;
    conn = null;
    await setStatus({ state: 'offline', error: 'The host went away.', retry: true });
    scheduleReconnect();
  });
}

async function connected(c: HostConnection) {
  await setStatus({ state: 'connected', host_version: c.welcome.host_version, capabilities: c.welcome.capabilities });
  void drain();
}

/** Sends the outbox in order until it is empty or the connection drops. Safe to call any time. */
export function drain(): Promise<void> {
  if (halted) return Promise.resolve();
  if (draining) {
    drainAgain = true;
    return draining;
  }
  draining = drainLoop().finally(() => (draining = null));
  return draining;
}

async function drainLoop(): Promise<void> {
  try {
    do {
      drainAgain = false;
      await drainOnce();
    } while (drainAgain && conn && !halted);
  } catch (e) {
    // The connection dropped (its close handler reconnects), or the token was revoked.
    if (e instanceof HostRefused && e.code === 'unknown_token') {
      disconnect();
      await setStatus({
        state: 'offline',
        error: 'This host no longer knows this browser. Forget it and pair again.',
        retry: false,
      });
    } else console.warn('host: outbox paused', e);
  }
}

async function drainOnce() {
  const c = conn;
  const pairing = await hostPairing.getValue();
  if (!c || !pairing) return;
  const capabilities = await hostCapabilities();
  for (;;) {
    // A cancelled Session's rows wait out its Undo window (E10): Undo releases them, the discard deletes them.
    const held = new Set((await discardPending.getValue()).map((p) => p.session_id));
    const rows = await db.outbox
      .orderBy('seq')
      .filter((r) => !held.has(r.session_id))
      .limit(BATCH)
      .toArray();
    if (rows.length === 0 || conn !== c || halted) return;
    for (let i = 0; i < rows.length; ) {
      // Forget: what is on the wire finishes, nothing more goes.
      if (halted) return;
      if (rows[i]!.kind === 'discard') {
        const row = rows[i++]!;
        if (capabilities.has('discard')) await sendDiscard(c, row.session_id);
        await db.outbox.delete(row.seq!);
        continue;
      }
      if (rows[i]!.kind === 'screenshot_discard') {
        const row = rows[i++] as Extract<OutboxRow, { kind: 'screenshot_discard' }>;
        if (capabilities.has('screenshot_discard')) await sendScreenshotDiscard(c, row);
        await db.outbox.delete(row.seq!);
        continue;
      }
      if (rows[i]!.kind === 'blob') {
        const row = rows[i++] as Extract<OutboxRow, { kind: 'blob' }>;
        if (capabilities.has('blobs')) await sendBlob(pairing.url, pairing.token, row);
        await db.outbox.delete(row.seq!);
        continue;
      }
      if (rows[i]!.kind === 'items') {
        // Each push is the Session's whole current set, so a run of rows for one Session needs one push.
        const row = rows[i++]!;
        const same: number[] = [row.seq!];
        while (i < rows.length && rows[i]!.kind === 'items' && rows[i]!.session_id === row.session_id)
          same.push(rows[i++]!.seq!);
        if (capabilities.has('items')) await sendItems(c, row.session_id);
        await db.outbox.bulkDelete(same);
        continue;
      }
      // Consecutive events go out together; each is acked by the id of its message, and all are dropped from the
      // outbox once all are acked. A resend after a drop is harmless: the Host upserts on the event id.
      const batch: Extract<OutboxRow, { kind: 'event' }>[] = [];
      while (i < rows.length && rows[i]!.kind === 'event')
        batch.push(rows[i++] as Extract<OutboxRow, { kind: 'event' }>);
      if (capabilities.has('events')) await sendEvents(c, batch);
      await db.outbox.bulkDelete(batch.map((r) => r.seq!));
    }
  }
}

async function sendEvents(c: HostConnection, rows: Extract<OutboxRow, { kind: 'event' }>[]) {
  const stored = await db.events.bulkGet(rows.map((r) => r.event_seq));
  const results = await Promise.allSettled(
    rows.map((row, i) => {
      const event = stored[i];
      // Deleted since it was queued (a failed Start, a deleted Session): nothing to send.
      if (!event) return Promise.resolve();
      const { seq: _seq, session_id: _session, ...timelineEvent } = event;
      return c.sendEvent(row.session_id, timelineEvent);
    }),
  );
  for (const r of results) {
    if (r.status === 'fulfilled') continue;
    // A refusal is final (the Host will never take this event); anything else means the socket dropped, so keep
    // the rows for the next connection.
    if (r.reason instanceof HostRefused && r.reason.code !== 'unknown_token' && r.reason.code !== 'internal') {
      console.warn('host: dropped an event the host refused', r.reason.message);
      continue;
    }
    throw r.reason;
  }
}

async function sendItems(c: HostConnection, sessionId: string) {
  const current = await currentChangeItems(sessionId);
  if (!current) return;
  try {
    await c.sendItems(sessionId, current.run_id, current.items);
  } catch (e) {
    if (e instanceof HostRefused && e.code !== 'unknown_token' && e.code !== 'internal')
      return console.warn('host: dropped items the host refused', e.message);
    throw e;
  }
}

async function sendDiscard(c: HostConnection, sessionId: string) {
  try {
    await c.sendDiscard(sessionId);
  } catch (e) {
    if (e instanceof HostRefused && e.code !== 'unknown_token' && e.code !== 'internal')
      return console.warn('host: the host refused a discard', e.message);
    throw e;
  }
}

async function sendScreenshotDiscard(c: HostConnection, row: Extract<OutboxRow, { kind: 'screenshot_discard' }>) {
  try {
    await c.sendScreenshotDiscard(row.session_id, row.blob_id);
  } catch (e) {
    if (e instanceof HostRefused && e.code !== 'unknown_token' && e.code !== 'internal')
      return console.warn('host: the host refused a screenshot discard', e.message);
    throw e;
  }
}

async function sendBlob(url: string, token: string, row: Extract<OutboxRow, { kind: 'blob' }>) {
  const blob = await db.blobs.get(row.blob_id);
  if (!blob) return;
  try {
    await putBlob(url, token, { id: blob.id, sessionId: row.session_id, data: blob.blob });
  } catch (e) {
    if (e instanceof HostRefused && e.code === 'bad_message')
      return console.warn('host: dropped a blob the host refused', e.message);
    throw e;
  }
}
