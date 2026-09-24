import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAsyncQueue } from '@/adapters/transcription/queue';
import { createScriptedAdapter } from '@/adapters/transcription/scripted';
import type { Segment } from '@/adapters/transcription/types';
import {
  createWebSpeechAdapter,
  type SpeechRecognitionCtor,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
} from '@/adapters/transcription/webspeech';

const fakeStream = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;

async function collect(it: AsyncIterable<Segment>): Promise<Segment[]> {
  const out: Segment[] = [];
  for await (const s of it) out.push(s);
  return out;
}

describe('async queue', () => {
  it('delivers buffered and later items, then ends', async () => {
    const q = createAsyncQueue<number>();
    q.push(1);
    const done = (async () => {
      const got: number[] = [];
      for await (const n of q) got.push(n);
      return got;
    })();
    q.push(2);
    await Promise.resolve();
    q.push(3);
    q.end();
    q.push(4); // ignored after end
    expect(await done).toEqual([1, 2, 3]);
    expect(q.ended).toBe(true);
  });
  it('rejects a waiting consumer when ended with an error', async () => {
    const q = createAsyncQueue<number>();
    const it = q[Symbol.asyncIterator]();
    const p = it.next();
    q.end(new Error('boom'));
    await expect(p).rejects.toThrow('boom');
  });
});

describe('scripted adapter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits cues at their times, stamped on the Session clock, and ends on stop', async () => {
    let clock = 100; // adapter started 100ms after t0
    const adapter = createScriptedAdapter(
      {
        timestamp_quality: 'approximate',
        cues: [
          { at_ms: 2500, duration_ms: 1800, text: 'this button should go in the header' },
          { at_ms: 500, duration_ms: 300, text: 'first' },
        ],
      },
      { now: () => clock, lang: 'en-US' },
    );
    expect(await adapter.describe()).toEqual({
      engine: 'scripted',
      local: true,
      timestamp_quality: 'approximate',
      captions: 'live',
    });
    const got = collect(adapter.start(fakeStream));
    clock = 600;
    await vi.advanceTimersByTimeAsync(500);
    clock = 2600;
    await vi.advanceTimersByTimeAsync(2000);
    adapter.stop();
    const segs = await got;
    expect(segs.map((s) => [s.text, s.t, s.t_end])).toEqual([
      ['first', 300, 600],
      ['this button should go in the header', 800, 2600],
    ]);
    expect(segs[0]).toMatchObject({ engine: 'scripted', local: true, timestamp_quality: 'approximate', words: null });
  });

  it('drops cues that have not fired when stopped', async () => {
    const adapter = createScriptedAdapter(
      { timestamp_quality: 'word', cues: [{ at_ms: 5000, duration_ms: 1, text: 'late' }] },
      { now: () => 0, lang: 'en' },
    );
    const got = collect(adapter.start(fakeStream));
    adapter.stop();
    await vi.advanceTimersByTimeAsync(6000);
    expect(await got).toEqual([]);
  });
});

/** A controllable fake of Chrome's SpeechRecognition. */
function fakeRecognition(availability: string) {
  const instances: (SpeechRecognitionLike & { started: unknown[] })[] = [];
  class Fake implements SpeechRecognitionLike {
    lang = '';
    continuous = false;
    interimResults = false;
    processLocally = false;
    onresult: SpeechRecognitionLike['onresult'] = null;
    onerror: SpeechRecognitionLike['onerror'] = null;
    onend: SpeechRecognitionLike['onend'] = null;
    started: unknown[] = [];
    constructor() {
      instances.push(this);
    }
    start(track?: MediaStreamTrack) {
      this.started.push(track);
    }
    stop() {
      this.onend?.();
    }
    abort() {}
    static available = vi.fn(async () => availability);
  }
  return { Ctor: Fake as unknown as SpeechRecognitionCtor, instances };
}
const result = (index: number, transcript: string, isFinal: boolean): SpeechRecognitionEventLike => {
  const results: SpeechRecognitionEventLike['results'] = { length: index + 1 };
  results[index] = Object.assign([{ transcript, confidence: 0.9 }], { isFinal });
  return { resultIndex: index, results };
};

const DEFAULT = { allowServer: false };
const OPT_IN = { allowServer: true };

describe('Web Speech adapter', () => {
  it('runs on-device when the language pack is available and stamps spans from first interim to final', async () => {
    const { Ctor, instances } = fakeRecognition('available');
    let clock = 1000;
    const fallbacks: unknown[] = [];
    const adapter = createWebSpeechAdapter(
      { now: () => clock, lang: 'en-US', onFallback: (f) => fallbacks.push(f) },
      DEFAULT,
      Ctor,
    );
    const it = adapter.start(fakeStream)[Symbol.asyncIterator]();
    expect(await adapter.describe()).toEqual({
      engine: 'webspeech',
      local: true,
      timestamp_quality: 'approximate',
      captions: 'live',
    });
    const r = instances[0]!;
    expect(r).toMatchObject({ lang: 'en-US', continuous: true, interimResults: true, processLocally: true });
    expect(r.started).toEqual([{ kind: 'audio' }]); // fed the offscreen mic track
    r.onresult!(result(0, 'this', false));
    clock = 2500;
    r.onresult!(result(0, ' this button ', true));
    expect((await it.next()).value).toEqual({
      text: 'this button',
      t: 1000,
      t_end: 2500,
      engine: 'webspeech',
      local: true,
      timestamp_quality: 'approximate',
      words: null,
      confidence: 0.9,
    });
    expect(fallbacks).toEqual([]);
  });

  it.each(['downloadable', 'downloading', 'unavailable'])(
    'by default never starts server recognition when on-device is %s: no captions, one fallback event',
    async (availability) => {
      vi.useFakeTimers();
      try {
        const { Ctor, instances } = fakeRecognition(availability);
        const fallbacks: unknown[] = [];
        const adapter = createWebSpeechAdapter(
          { now: () => 5, lang: 'en-US', onFallback: (f) => fallbacks.push(f) },
          DEFAULT,
          Ctor,
        );
        const got = collect(adapter.start(fakeStream));
        expect(await adapter.describe()).toEqual({
          engine: 'webspeech',
          local: true,
          timestamp_quality: 'approximate',
          captions: 'unavailable',
        });
        // No SpeechRecognition was ever constructed, so nothing could have used processLocally: false.
        expect(instances).toHaveLength(0);
        expect(Ctor.available).toHaveBeenCalledWith({ langs: ['en-US'], processLocally: true });
        expect(fallbacks).toEqual([{ from: 'webspeech-on-device', to: 'none', reason: 'on_device_unavailable' }]);
        adapter.stop();
        await vi.advanceTimersByTimeAsync(500);
        expect(await got).toEqual([]); // the Session keeps going; the stream simply ends empty on Stop
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('by default stops recognizing (no server restart) when on-device start fails with language-not-supported', async () => {
    const { Ctor, instances } = fakeRecognition('available');
    const fallbacks: unknown[] = [];
    const adapter = createWebSpeechAdapter(
      { now: () => 5, lang: 'en-US', onFallback: (f) => fallbacks.push(f) },
      DEFAULT,
      Ctor,
    );
    adapter.start(fakeStream);
    await adapter.describe();
    instances[0]!.onerror!({ error: 'language-not-supported' });
    instances[0]!.onend!();
    expect(instances).toHaveLength(1);
    expect(instances.every((r) => r.processLocally === true)).toBe(true);
    expect(fallbacks).toEqual([{ from: 'webspeech-on-device', to: 'none', reason: 'on_device_unavailable' }]);
  });

  it('with the server opt-in, falls back to the server recognizer and marks segments non-local', async () => {
    const { Ctor, instances } = fakeRecognition('downloadable');
    const fallbacks: unknown[] = [];
    const adapter = createWebSpeechAdapter(
      { now: () => 5, lang: 'en-US', onFallback: (f) => fallbacks.push(f) },
      OPT_IN,
      Ctor,
    );
    const it = adapter.start(fakeStream)[Symbol.asyncIterator]();
    expect(await adapter.describe()).toMatchObject({ local: false, captions: 'live' });
    expect(instances[0]!.processLocally).toBe(false);
    expect(fallbacks).toEqual([
      { from: 'webspeech-on-device', to: 'webspeech-server', reason: 'on_device_unavailable' },
    ]);
    instances[0]!.onresult!(result(0, 'hello', true));
    expect((await it.next()).value).toMatchObject({ text: 'hello', local: false });
  });

  it('with the server opt-in, restarts on the server after language-not-supported', async () => {
    const { Ctor, instances } = fakeRecognition('available');
    const adapter = createWebSpeechAdapter({ now: () => 5, lang: 'en-US' }, OPT_IN, Ctor);
    adapter.start(fakeStream);
    await adapter.describe();
    instances[0]!.onerror!({ error: 'language-not-supported' });
    instances[0]!.onend!();
    expect(instances).toHaveLength(2);
    expect(instances[1]!.processLocally).toBe(false);
  });

  it('restarts after Chrome ends a continuous run, and stops for good on stop()', async () => {
    vi.useFakeTimers();
    try {
      const { Ctor, instances } = fakeRecognition('available');
      const adapter = createWebSpeechAdapter({ now: () => 5, lang: 'en-US' }, DEFAULT, Ctor);
      const got = collect(adapter.start(fakeStream));
      await adapter.describe();
      instances[0]!.onerror!({ error: 'no-speech' });
      instances[0]!.onend!();
      expect(instances).toHaveLength(2);
      expect(instances[1]!.processLocally).toBe(true);
      adapter.stop();
      await vi.advanceTimersByTimeAsync(500);
      expect(instances).toHaveLength(2);
      expect(await got).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends the stream with an error on a fatal error', async () => {
    const { Ctor, instances } = fakeRecognition('available');
    const adapter = createWebSpeechAdapter({ now: () => 5, lang: 'en-US' }, DEFAULT, Ctor);
    const got = collect(adapter.start(fakeStream));
    await adapter.describe();
    instances[0]!.onerror!({ error: 'not-allowed' });
    await expect(got).rejects.toThrow(/not-allowed/);
  });

  it('ends with an error when SpeechRecognition is missing', async () => {
    const adapter = createWebSpeechAdapter({ now: () => 5, lang: 'en-US' }, DEFAULT, undefined);
    await expect(collect(adapter.start(fakeStream))).rejects.toThrow(/not available/);
  });
});
