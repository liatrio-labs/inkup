// The paid tiers' retry/fallback state machine (src/adapters/transcription/streaming.ts), on fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAsyncQueue } from '@/adapters/transcription/queue';
import {
  createStreamingAdapter,
  fallbackTarget,
  StreamAuthError,
  type StreamConnection,
  type StreamEngine,
  type StreamHandlers,
} from '@/adapters/transcription/streaming';
import type {
  AdapterContext,
  Fallback,
  PcmFrame,
  Segment,
  TranscriptionAdapter,
  TranscriptionInfo,
} from '@/adapters/transcription/types';

const stream = {} as MediaStream;
const INFO: TranscriptionInfo = { engine: 'deepgram', local: false, timestamp_quality: 'word', captions: 'live' };

interface FakeConn extends StreamConnection {
  sent: PcmFrame[];
  handlers: StreamHandlers;
  finished: boolean;
}

/** An engine whose connect() outcomes the test scripts: 'ok' opens, 'fail' rejects, 'auth' rejects as auth. */
function fakeEngine(outcomes: ('ok' | 'fail' | 'auth')[]) {
  const conns: FakeConn[] = [];
  let attempts = 0;
  const engine: StreamEngine = {
    id: 'deepgram',
    info: INFO,
    connect(handlers) {
      const o = outcomes[attempts++] ?? 'ok';
      if (o === 'fail') return Promise.reject(new Error('refused'));
      if (o === 'auth') return Promise.reject(new StreamAuthError('401'));
      const c: FakeConn = {
        sent: [],
        handlers,
        finished: false,
        send(f) {
          this.sent.push(f);
        },
        async finish() {
          this.finished = true;
        },
        abort() {},
      };
      conns.push(c);
      return Promise.resolve(c);
    },
  };
  return { engine, conns, attempts: () => attempts };
}

function fakePcm() {
  let listener: ((f: PcmFrame) => void) | null = null;
  return {
    source: {
      sampleRate: 16000,
      onFrame: (fn: (f: PcmFrame) => void) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    },
    emit: (t: number) => listener?.({ pcm: new Int16Array(1600), t }),
    get subscribed() {
      return listener !== null;
    },
  };
}

function fakeFallback(info: TranscriptionInfo) {
  const q = createAsyncQueue<Segment>();
  const made: TranscriptionAdapter[] = [];
  const factory = () => {
    const a: TranscriptionAdapter = { start: () => q, describe: async () => info, stop: () => q.end() };
    made.push(a);
    return a;
  };
  return { factory, made, q };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('createStreamingAdapter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(
    outcomes: ('ok' | 'fail' | 'auth')[],
    fbInfo: TranscriptionInfo = {
      engine: 'webspeech',
      local: true,
      timestamp_quality: 'approximate',
      captions: 'unavailable',
    },
  ) {
    const eng = fakeEngine(outcomes);
    const pcm = fakePcm();
    const fb = fakeFallback(fbInfo);
    const fallbacks: Fallback[] = [];
    const ctx: AdapterContext = {
      now: () => 0,
      lang: 'en-US',
      onFallback: (f) => fallbacks.push(f),
      pcm: async () => pcm.source,
    };
    const adapter = createStreamingAdapter(eng.engine, ctx, {
      fallback: fb.factory,
      policy: { retries: 3, baseMs: 500, stableMs: 30_000 },
    });
    return { adapter, eng, pcm, fb, fallbacks };
  }

  it('streams frames to the open connection and reports the paid engine', async () => {
    const { adapter, eng, pcm } = setup(['ok']);
    adapter.start(stream);
    await flush();
    expect(await adapter.describe()).toEqual(INFO);
    pcm.emit(100);
    pcm.emit(200);
    expect(eng.conns[0]!.sent.map((f) => f.t)).toEqual([100, 200]);
  });

  it('retries 3 times with 500/1000/2000 ms backoff, then falls back once and keeps going', async () => {
    const { adapter, eng, fallbacks, fb, pcm } = setup(['ok', 'ok', 'ok', 'ok']);
    const segs: Segment[] = [];
    void (async () => {
      for await (const s of adapter.start(stream)) segs.push(s);
    })();
    await flush();
    // Four drops: the first connection, then each of the three retries.
    for (const [i, wait] of [
      [0, 500],
      [1, 1000],
      [2, 2000],
    ] as const) {
      eng.conns[i]!.handlers.onDrop('socket_closed: 1011');
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(eng.attempts()).toBe(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(eng.attempts()).toBe(i + 2);
    }
    expect(fallbacks).toEqual([]);
    eng.conns[3]!.handlers.onDrop('socket_closed: 1011');
    await flush();
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toMatchObject({
      from: 'deepgram',
      to: 'none',
      reason: 'socket_closed: 1011 (after 3 retries)',
    });
    expect(fb.made).toHaveLength(1);
    // No more connection attempts, and the PCM graph is released.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(eng.attempts()).toBe(4);
    expect(pcm.subscribed).toBe(false);
    // The fallback's segments flow through the same iterable: the Session continues.
    fb.q.push({
      text: 'after',
      t: 1,
      t_end: 2,
      engine: 'webspeech',
      local: true,
      timestamp_quality: 'approximate',
      words: null,
      confidence: null,
    });
    await flush();
    expect(segs.map((s) => s.text)).toEqual(['after']);
  });

  it('resets the failure count once a connection stays up for stableMs', async () => {
    const { adapter, eng, fallbacks } = setup(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    adapter.start(stream);
    await flush();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      eng.conns[i]!.handlers.onDrop('socket_closed: 1006');
      await vi.advanceTimersByTimeAsync(500);
      await flush();
    }
    expect(fallbacks).toEqual([]);
    expect(eng.attempts()).toBe(6);
  });

  it('counts failed connects like drops, and buffers frames for the next connection', async () => {
    const { adapter, eng, pcm, fallbacks } = setup(['fail', 'fail', 'ok']);
    adapter.start(stream);
    await flush();
    pcm.emit(10);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    pcm.emit(20);
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(fallbacks).toEqual([]);
    expect(eng.conns[0]!.sent.map((f) => f.t)).toEqual([10, 20]);
  });

  it('falls back at once when the key is rejected', async () => {
    const { adapter, fallbacks } = setup(['auth'], {
      engine: 'webspeech',
      local: true,
      timestamp_quality: 'approximate',
      captions: 'live',
    });
    adapter.start(stream);
    await flush();
    expect(fallbacks).toEqual([
      expect.objectContaining({
        from: 'deepgram',
        to: 'webspeech-on-device',
        reason: expect.stringMatching(/^auth_failed/),
      }),
    ]);
    expect(await adapter.describe()).toMatchObject({ engine: 'webspeech', local: true });
  });

  it('closes the socket on pause, sends nothing while paused, and reconnects on resume', async () => {
    const { adapter, eng, pcm } = setup(['ok', 'ok']);
    adapter.start(stream);
    await flush();
    adapter.pause!();
    expect(eng.conns[0]!.finished).toBe(true);
    pcm.emit(5000);
    // A drop reported by the closing socket is not a failure.
    eng.conns[0]!.handlers.onDrop('socket_closed: 1000');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(eng.attempts()).toBe(1);
    adapter.resume!();
    await flush();
    pcm.emit(9000);
    expect(eng.conns[1]!.sent.map((f) => f.t)).toEqual([9000]);
  });

  it('flushes the open connection on stop, then ends', async () => {
    const { adapter, eng } = setup(['ok']);
    const it = adapter.start(stream);
    await flush();
    adapter.stop();
    await flush();
    expect(eng.conns[0]!.finished).toBe(true);
    const r = await it[Symbol.asyncIterator]().next();
    expect(r.done).toBe(true);
  });

  it('names the fallback target', () => {
    expect(
      fallbackTarget({ engine: 'webspeech', local: true, timestamp_quality: 'approximate', captions: 'live' }),
    ).toBe('webspeech-on-device');
    expect(
      fallbackTarget({ engine: 'webspeech', local: false, timestamp_quality: 'approximate', captions: 'live' }),
    ).toBe('webspeech-server');
    expect(
      fallbackTarget({ engine: 'webspeech', local: true, timestamp_quality: 'approximate', captions: 'unavailable' }),
    ).toBe('none');
  });
});
