// Resilient streaming for the paid tiers (PRD P0-7): the shared PCM16 graph feeds one vendor socket at a time.
//
// - A connection that drops, or fails to open, is retried 3 times with backoff (base, 2×, 4×). The failure
//   count resets only after a connection has stayed up for `stableMs`, so a server that accepts and then drops
//   every socket still exhausts the retries.
// - After the last retry, or at once on an auth failure, the adapter falls back to the free default (on-device
//   Web Speech when available, else none: server speech only with the reviewer's opt-in, P0-15). It reports one
//   `transcription_fallback` {from, to, reason, info}. The Session goes on either way.
// - Frames captured while reconnecting are buffered (up to `bufferMs`) and sent first on the next connection;
//   each connection maps engine offsets through the frames it was actually sent (core/audio-offsets.ts), so
//   replayed audio keeps its capture time.
// - Pause closes the socket (no audio leaves the machine while paused); resume opens a fresh one.
import { createAsyncQueue } from './queue';
import type {
  AdapterContext,
  Fallback,
  PcmFrame,
  PcmSource,
  Segment,
  TranscriptionAdapter,
  TranscriptionInfo,
} from './types';

export interface StreamHandlers {
  onSegment(s: Segment): void;
  /** The connection closed without being asked to. */
  onDrop(reason: string): void;
}

export interface StreamConnection {
  send(frame: PcmFrame): void;
  /** Flush what the engine holds (final results arrive through onSegment), then close. */
  finish(): Promise<void>;
  /** Close now. */
  abort(): void;
}

export interface StreamEngine {
  /** Engine id: 'deepgram' | 'elevenlabs'. */
  id: string;
  info: TranscriptionInfo;
  /** Mints a token and opens a socket; resolves once audio can be sent. Rejects with StreamAuthError on 401. */
  connect(handlers: StreamHandlers): Promise<StreamConnection>;
}

/** The vendor rejected the key: retrying cannot help. */
export class StreamAuthError extends Error {
  override name = 'StreamAuthError';
}

export interface RetryPolicy {
  retries: number;
  baseMs: number;
  stableMs: number;
  bufferMs: number;
}
export const DEFAULT_RETRY: RetryPolicy = { retries: 3, baseMs: 500, stableMs: 30_000, bufferMs: 30_000 };

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: never) => void;
}

/** What a fallback adapter reports as its engine name in `transcription_fallback.to`. */
export function fallbackTarget(info: TranscriptionInfo): string {
  if (info.captions === 'unavailable') return 'none';
  if (info.engine === 'webspeech') return info.local ? 'webspeech-on-device' : 'webspeech-server';
  return info.engine;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createStreamingAdapter(
  engine: StreamEngine,
  ctx: AdapterContext,
  opts: { fallback: (ctx: AdapterContext) => TranscriptionAdapter; policy?: Partial<RetryPolicy>; timers?: Timers },
): TranscriptionAdapter {
  const policy = { ...DEFAULT_RETRY, ...opts.policy };
  const timers: Timers = opts.timers ?? (globalThis as unknown as Timers);
  const queue = createAsyncQueue<Segment>();
  let state: 'idle' | 'connecting' | 'open' | 'waiting' | 'paused' | 'fallback' | 'stopped' = 'idle';
  let conn: StreamConnection | null = null;
  let failures = 0;
  let generation = 0;
  let retryTimer: unknown = null;
  let stableTimer: unknown = null;
  let buffer: PcmFrame[] = [];
  let unsubscribe: (() => void) | null = null;
  let stream: MediaStream | null = null;
  let fallback: TranscriptionAdapter | null = null;
  let fallbackDone: Promise<void> = Promise.resolve();
  let resolveInfo!: (i: TranscriptionInfo) => void;
  let infoResolved = false;
  const infoPromise = new Promise<TranscriptionInfo>((r) => (resolveInfo = r));
  const settleInfo = (i: TranscriptionInfo) => {
    if (infoResolved) return;
    infoResolved = true;
    resolveInfo(i);
  };

  const clear = (h: unknown) => {
    if (h !== null) timers.clearTimeout(h as never);
  };

  function onFrame(f: PcmFrame) {
    if (state === 'open' && conn) {
      conn.send(f);
      return;
    }
    if (state === 'connecting' || state === 'waiting') {
      buffer.push(f);
      // Keep only the most recent bufferMs of audio.
      while (buffer.length && f.t - buffer[0]!.t > policy.bufferMs) buffer.shift();
    }
  }

  function connect() {
    const gen = ++generation;
    state = 'connecting';
    engine
      .connect({
        // Every connection's results count, including the final ones a connection flushes while it closes for
        // a pause or Stop: they cover audio the Session captured.
        onSegment: (s) => queue.push(s),
        onDrop: (reason) => {
          if (gen !== generation || state !== 'open') return;
          conn = null;
          failed(reason, false);
        },
      })
      .then(
        (c) => {
          if (gen !== generation || state !== 'connecting') {
            c.abort();
            return;
          }
          conn = c;
          state = 'open';
          settleInfo({ ...engine.info, captions: 'live' });
          for (const f of buffer) c.send(f);
          buffer = [];
          clear(stableTimer);
          stableTimer = timers.setTimeout(() => {
            if (gen === generation && state === 'open') failures = 0;
          }, policy.stableMs);
        },
        (e: unknown) => {
          if (gen !== generation || state !== 'connecting') return;
          failed(`connect_failed: ${errText(e)}`, e instanceof StreamAuthError);
        },
      );
  }

  function failed(reason: string, fatal: boolean) {
    clear(stableTimer);
    failures++;
    if (fatal || failures > policy.retries) {
      void fallBack(fatal ? `auth_failed: ${reason}` : `${reason} (after ${policy.retries} retries)`);
      return;
    }
    // Starting still reports the paid engine; the fallback event updates the Session if retries run out.
    settleInfo({ ...engine.info, captions: 'live' });
    state = 'waiting';
    const delay = policy.baseMs * 2 ** (failures - 1);
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      if (state === 'waiting') connect();
    }, delay);
  }

  async function fallBack(reason: string) {
    state = 'fallback';
    generation++;
    buffer = [];
    unsubscribe?.();
    unsubscribe = null;
    let target: TranscriptionInfo | null = null;
    // The fallback's own mode change (e.g. on-device → none) is folded into this one event.
    const fb = opts.fallback({ ...ctx, onFallback: () => {} });
    fallback = fb;
    const iterable = fb.start(stream!);
    target = await fb.describe();
    const f: Fallback = { from: engine.id, to: fallbackTarget(target), reason, info: target };
    ctx.onFallback?.(f);
    settleInfo(target);
    fallbackDone = (async () => {
      try {
        for await (const s of iterable) queue.push(s);
      } catch (e) {
        queue.end(e);
      }
    })();
  }

  return {
    describe: () => infoPromise,
    start(s) {
      stream = s;
      void (async () => {
        let pcm: PcmSource;
        try {
          if (!ctx.pcm) throw new Error('no PCM source in this context');
          pcm = await ctx.pcm();
        } catch (e) {
          await fallBack(`audio_graph_failed: ${errText(e)}`);
          return;
        }
        if (state !== 'idle') return;
        unsubscribe = pcm.onFrame(onFrame);
        connect();
      })();
      return queue;
    },
    pause() {
      if (state === 'fallback') return fallback?.pause?.();
      if (state === 'stopped' || state === 'paused') return;
      generation++;
      clear(retryTimer);
      clear(stableTimer);
      retryTimer = null;
      buffer = [];
      const c = conn;
      conn = null;
      state = 'paused';
      // Final results of the audio sent before the pause still arrive; they belong to the Session.
      if (c) void c.finish().catch(() => c.abort());
    },
    resume() {
      if (state === 'fallback') return fallback?.resume?.();
      if (state !== 'paused') return;
      connect();
    },
    stop() {
      const wasFallback = state === 'fallback';
      const c = conn;
      conn = null;
      state = 'stopped';
      generation++;
      clear(retryTimer);
      clear(stableTimer);
      unsubscribe?.();
      unsubscribe = null;
      settleInfo({ ...engine.info, captions: 'live' });
      void (async () => {
        if (wasFallback) {
          fallback?.stop();
          await fallbackDone;
        } else if (c) {
          await c.finish().catch(() => c.abort());
        }
        queue.end();
      })();
    },
  };
}
