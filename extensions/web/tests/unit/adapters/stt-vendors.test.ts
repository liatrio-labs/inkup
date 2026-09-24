// @vitest-environment node
// The real Deepgram and ElevenLabs SDK paths (src/adapters/transcription/{deepgram,elevenlabs}.ts) against the
// local vendor stubs (tests/support/stt-stubs.ts). Node 26 has a global WebSocket for Scribe; the Deepgram SDK
// uses `ws` in Node and sends its credential as a header instead of subprotocols (the stub accepts both; the
// browser subprotocol path is covered by tests/e2e/stt-tiers.spec.ts).
import { afterEach, describe, expect, it } from 'vitest';
import { transcribeDeepgramFile, transcribeElevenLabsFile } from '@/adapters/transcription/batch';
import { createDeepgramEngine, mintDeepgramToken } from '@/adapters/transcription/deepgram';
import { createElevenLabsEngine } from '@/adapters/transcription/elevenlabs';
import { createAsyncQueue } from '@/adapters/transcription/queue';
import { createStreamingAdapter } from '@/adapters/transcription/streaming';
import type { AdapterContext, Fallback, PcmFrame, Segment, TranscriptionAdapter } from '@/adapters/transcription/types';
import { type SttStub, startDeepgramStub, startElevenLabsStub } from '../../../../../tests/support/stt-stubs';

const KEY = 'test-key-123';
const SCRIPT = 'this button should go in the header';
let stub: SttStub | null = null;
afterEach(async () => {
  await stub?.close();
  stub = null;
});

/** A PCM source the test drives: `play(seconds)` emits 100 ms frames of a 440 Hz tone, stamped from `t0`. */
function pcmSource(t0: number) {
  const listeners = new Set<(f: PcmFrame) => void>();
  let t = t0;
  return {
    source: {
      sampleRate: 16000,
      onFrame: (fn: (f: PcmFrame) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    async play(seconds: number, skipMs = 0) {
      t += skipMs;
      for (let i = 0; i < seconds * 10; i++) {
        const pcm = Int16Array.from({ length: 1600 }, (_, k) =>
          Math.round(8000 * Math.sin((2 * Math.PI * 440 * k) / 16000)),
        );
        for (const l of listeners) l({ pcm, t });
        t += 100;
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
}

const noFallback = (): TranscriptionAdapter => {
  const q = createAsyncQueue<Segment>();
  return {
    start: () => q,
    describe: async () => ({
      engine: 'webspeech',
      local: true,
      timestamp_quality: 'approximate',
      captions: 'unavailable',
    }),
    stop: () => q.end(),
  };
};

async function run(
  engineFor: (base: string) => ReturnType<typeof createDeepgramEngine>,
  seconds: number,
  opts: { skipMs?: number; policy?: object } = {},
) {
  const pcm = pcmSource(5000);
  const fallbacks: Fallback[] = [];
  const ctx: AdapterContext = {
    now: () => 0,
    lang: 'en-US',
    onFallback: (f) => fallbacks.push(f),
    pcm: async () => pcm.source,
  };
  const adapter = createStreamingAdapter(engineFor(stub!.baseURL), ctx, {
    fallback: noFallback,
    policy: { baseMs: 50, ...opts.policy },
  });
  const segs: Segment[] = [];
  const done = (async () => {
    for await (const s of adapter.start({} as MediaStream)) segs.push(s);
  })();
  const info = await adapter.describe();
  await pcm.play(seconds / 2);
  await pcm.play(seconds / 2, opts.skipMs ?? 0);
  adapter.stop();
  await done;
  return { segs, info, fallbacks };
}

function expectWordLevel(segs: Segment[], from: number, to: number) {
  expect(segs.length).toBeGreaterThan(0);
  const words = segs.flatMap((s) => s.words ?? []);
  expect(words.length).toBeGreaterThan(3);
  for (const s of segs) expect(s.timestamp_quality).toBe('word');
  const ts = words.map((w) => w.t);
  expect(ts).toEqual([...ts].sort((a, b) => a - b));
  for (const w of words) {
    expect(w.t).toBeGreaterThanOrEqual(from);
    expect(w.t_end).toBeLessThanOrEqual(to);
    expect(w.t_end).toBeGreaterThanOrEqual(w.t);
  }
  return words;
}

describe('Deepgram adapter (real @deepgram/sdk against the stub)', () => {
  it('mints a bearer token with ttl_seconds and streams linear16 at 16 kHz', async () => {
    stub = await startDeepgramStub({ key: KEY, script: SCRIPT });
    const { segs, info } = await run((b) => createDeepgramEngine({ key: KEY, baseUrl: b, lang: 'en-US' }), 4);
    expect(info).toMatchObject({ engine: 'deepgram', local: false, timestamp_quality: 'word' });
    const grant = stub.rest.find((r) => r.path === '/v1/auth/grant')!;
    expect(JSON.parse(grant.body.toString())).toEqual({ ttl_seconds: 60 });
    expect(stub.sockets[0]!.protocols[0]).toBe('bearer');
    expect(stub.sockets[0]!.query).toMatchObject({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
    });
    expect(stub.sockets[0]!.audioBytes).toBe(4 * 32000);
    const words = expectWordLevel(segs, 5000, 9000);
    expect(
      words
        .map((w) => w.text)
        .slice(0, 7)
        .join(' '),
    ).toBe(SCRIPT);
    // Interim results never become segments: each word appears once.
    expect(words.length).toBe(stub.sockets[0]!.words.length);
  });

  it('maps word times across a pause gap to the Session time the audio was captured', async () => {
    stub = await startDeepgramStub({ key: KEY, script: SCRIPT });
    const { segs } = await run((b) => createDeepgramEngine({ key: KEY, baseUrl: b, lang: 'en-US' }), 4, {
      skipMs: 10_000,
    });
    const words = expectWordLevel(segs, 5000, 19_000);
    // Nothing lands inside the 10 s gap between the two halves (Session 7000–17000).
    for (const w of words) expect(w.t < 7000 || w.t >= 17_000).toBe(true);
    expect(words.some((w) => w.t >= 17_000)).toBe(true);
  });

  it('falls back to the raw key on the token subprotocol when the grant is forbidden (403)', async () => {
    stub = await startDeepgramStub({ key: KEY, script: SCRIPT, grantStatus: 403 });
    expect(await mintDeepgramToken(KEY, stub.baseURL)).toEqual({ kind: 'key', token: KEY });
    const { segs } = await run((b) => createDeepgramEngine({ key: KEY, baseUrl: b, lang: 'en-US' }), 2);
    expect(stub.sockets[0]!.protocols).toEqual(['token', KEY]);
    expect(segs.length).toBeGreaterThan(0);
  });

  it('a wrong key falls back at once', async () => {
    stub = await startDeepgramStub({ key: KEY, script: SCRIPT });
    const { fallbacks } = await run((b) => createDeepgramEngine({ key: 'wrong', baseUrl: b, lang: 'en-US' }), 0.4);
    expect(fallbacks).toEqual([
      expect.objectContaining({ from: 'deepgram', to: 'none', reason: expect.stringMatching(/^auth_failed/) }),
    ]);
    expect(stub.sockets).toHaveLength(0);
  });

  it('four drops: three retries, then the fallback', async () => {
    stub = await startDeepgramStub({ key: KEY, script: SCRIPT, dropAfterMs: 150, dropConnections: 4 });
    const { fallbacks } = await run((b) => createDeepgramEngine({ key: KEY, baseUrl: b, lang: 'en-US' }), 40);
    expect(stub.sockets).toHaveLength(4);
    expect(fallbacks).toEqual([
      expect.objectContaining({ from: 'deepgram', to: 'none', reason: expect.stringContaining('socket_closed: 1011') }),
    ]);
  }, 20_000);
});

describe('ElevenLabs adapter (real @elevenlabs/client Scribe against the stub)', () => {
  it('mints a single-use token and streams pcm_16000 with VAD commits and timestamps', async () => {
    stub = await startElevenLabsStub({ key: KEY, script: SCRIPT });
    const { segs, info } = await run((b) => createElevenLabsEngine({ key: KEY, baseUrl: b, lang: 'en-US' }), 4);
    expect(info).toMatchObject({ engine: 'elevenlabs', local: false, timestamp_quality: 'word' });
    const tokenReq = stub.rest.find((r) => r.path === '/v1/single-use-token/realtime_scribe')!;
    expect(tokenReq.headers['xi-api-key']).toBe(KEY);
    expect(stub.sockets[0]!.query).toMatchObject({
      model_id: 'scribe_v2_realtime',
      token: 'sutkn_stub1',
      audio_format: 'pcm_16000',
      commit_strategy: 'vad',
      include_timestamps: 'true',
      language_code: 'en',
    });
    expect(stub.sockets[0]!.audioBytes).toBe(4 * 32000);
    const words = expectWordLevel(segs, 5000, 9000);
    expect(
      words
        .map((w) => w.text)
        .slice(0, 7)
        .join(' '),
    ).toBe(SCRIPT);
  });

  it('four drops: three retries, then the fallback', async () => {
    stub = await startElevenLabsStub({ key: KEY, script: SCRIPT, dropAfterMs: 150, dropConnections: 4 });
    const { fallbacks } = await run((b) => createElevenLabsEngine({ key: KEY, baseUrl: b, lang: 'en-US' }), 40);
    expect(stub.sockets).toHaveLength(4);
    expect(fallbacks).toEqual([
      expect.objectContaining({
        from: 'elevenlabs',
        to: 'none',
        reason: expect.stringContaining('socket_closed: 1011'),
      }),
    ]);
  }, 20_000);
});

describe('batch paths (re-transcription)', () => {
  const audio = new Blob([new Uint8Array(4096)], { type: 'audio/webm;codecs=opus' });

  it('Deepgram pre-recorded: the file with Token auth, utterances as word groups in media ms', async () => {
    stub = await startDeepgramStub({
      key: KEY,
      script: 'this button should go in the header make this card taller',
      batchSeconds: 6,
    });
    const r = await transcribeDeepgramFile(audio, KEY, 'en-US', stub.baseURL);
    const req = stub.rest.find((x) => x.path === '/v1/listen')!;
    expect(req.headers.authorization).toBe(`Token ${KEY}`);
    expect(req.query).toMatchObject({ model: 'nova-3', utterances: 'true', language: 'en' });
    expect(req.body.length).toBe(4096);
    expect(r).toMatchObject({ engine: 'deepgram', model: 'nova-3', local: false });
    // The stub pauses 0.9 s after every 6th word: two utterances.
    expect(r.groups.map((g) => g.map((w) => w.text).join(' '))).toEqual([
      'this button should go in the',
      'header make this card taller',
    ]);
    expect(r.groups[0]![0]).toEqual({ text: 'this', start_ms: 500, end_ms: 800 });
  });

  it('ElevenLabs speech-to-text: multipart with word timestamps; spacing entries dropped', async () => {
    stub = await startElevenLabsStub({ key: KEY, script: SCRIPT, batchSeconds: 6 });
    const r = await transcribeElevenLabsFile(audio, KEY, 'en-US', stub.baseURL);
    const req = stub.rest.find((x) => x.path === '/v1/speech-to-text')!;
    expect(req.headers['xi-api-key']).toBe(KEY);
    const body = req.body.toString('latin1');
    for (const [k, v] of [
      ['model_id', 'scribe_v2'],
      ['timestamps_granularity', 'word'],
      ['language_code', 'en'],
    ])
      expect(body).toMatch(new RegExp(`name="${k}"\\r\\n\\r\\n${v}`));
    expect(body).toContain('filename="session.webm"');
    expect(r).toMatchObject({ engine: 'elevenlabs', model: 'scribe_v2', local: false });
    expect(
      r.groups
        .flat()
        .map((w) => w.text)
        .join(' '),
    ).toMatch(new RegExp(`^${SCRIPT}`));
    expect(r.groups.length).toBeGreaterThan(1); // split at the stub's 0.9 s pause
    await expect(transcribeElevenLabsFile(audio, 'wrong', 'en-US', stub.baseURL)).rejects.toThrow(/401/);
  });
});
