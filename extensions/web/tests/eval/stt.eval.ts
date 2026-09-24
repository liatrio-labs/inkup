// `pnpm eval:stt` (docs/PLAN.md Slice 6 proof): the fixture WAVs through the real Deepgram and ElevenLabs
// services, both paths:
// - streaming: the same adapters the offscreen document runs (createStreamingAdapter + the vendor engine), fed
//   the WAV as 100 ms PCM16 frames stamped with their audio time, like the pcm16 worklet does;
// - batch: the re-transcription path (src/adapters/transcription/batch.ts) with the WAV file.
// Each run must reach WER ≤ MAX_WER against the fixture's script, with word timestamps that are monotonic, inside
// the audio, and (where the fixture has a .timing.json) start within TIMING_TOLERANCE_MS of each spoken clip.
//
// Key-gated: DEEPGRAM_API_KEY and ELEVENLABS_API_KEY from .env or the environment. A vendor without a key is
// skipped; with neither, the run skips cleanly and exits 0. Streaming runs at STT_EVAL_SPEED× real time
// (default 2). Costs a few cents per vendor per run.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { joinWords } from '@inkup/core/transcription-runs';
import { afterAll, describe, expect, it } from 'vitest';
import { transcribeDeepgramFile, transcribeElevenLabsFile } from '@/adapters/transcription/batch';
import { createDeepgramEngine } from '@/adapters/transcription/deepgram';
import { createElevenLabsEngine } from '@/adapters/transcription/elevenlabs';
import { createAsyncQueue } from '@/adapters/transcription/queue';
import { createStreamingAdapter, type StreamEngine } from '@/adapters/transcription/streaming';
import type { AdapterContext, Fallback, PcmFrame, Segment, TranscriptionAdapter } from '@/adapters/transcription/types';
import {
  AUDIO_DIR,
  FIXTURE_NAMES,
  fixtureReference,
  fixtureTiming,
  readPcm16Wav,
  wordErrorRate,
} from '../../../../tests/support/wer';

const KEYS = { deepgram: process.env.DEEPGRAM_API_KEY?.trim(), elevenlabs: process.env.ELEVENLABS_API_KEY?.trim() };
const SPEED = Number(process.env.STT_EVAL_SPEED) || 2;
const MAX_WER = 0.25;
const TIMING_TOLERANCE_MS = 600;

if (!KEYS.deepgram && !KEYS.elevenlabs)
  console.log(
    '\npnpm eval:stt: neither DEEPGRAM_API_KEY nor ELEVENLABS_API_KEY is set (add them to .env). Skipping.\n',
  );

type Vendor = keyof typeof KEYS;
const ENGINES: Record<Vendor, (key: string) => StreamEngine> = {
  deepgram: (key) => createDeepgramEngine({ key, lang: 'en-US' }),
  elevenlabs: (key) => createElevenLabsEngine({ key, lang: 'en-US' }),
};
const results: { vendor: Vendor; path: string; name: string; wer: number; text: string }[] = [];

/** Streams a fixture through the live adapter, in 100 ms frames plus 2 s of trailing silence. */
async function stream(
  vendor: Vendor,
  name: string,
): Promise<{ segs: Segment[]; fallbacks: Fallback[]; durationMs: number }> {
  const { samples } = readPcm16Wav(name);
  const listeners = new Set<(f: PcmFrame) => void>();
  const fallbacks: Fallback[] = [];
  const none = (): TranscriptionAdapter => {
    const q = createAsyncQueue<Segment>();
    return {
      start: () => q,
      describe: async () => ({
        engine: 'none',
        local: true,
        timestamp_quality: 'approximate',
        captions: 'unavailable',
      }),
      stop: () => q.end(),
    };
  };
  const ctx: AdapterContext = {
    now: () => 0,
    lang: 'en-US',
    onFallback: (f) => fallbacks.push(f),
    pcm: async () => ({
      sampleRate: 16000,
      onFrame: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    }),
  };
  const adapter = createStreamingAdapter(ENGINES[vendor](KEYS[vendor]!), ctx, { fallback: none });
  const segs: Segment[] = [];
  const done = (async () => {
    for await (const s of adapter.start({} as MediaStream)) segs.push(s);
  })();
  await adapter.describe();
  const padded = new Int16Array(samples.length + 32000);
  padded.set(samples);
  for (let i = 0, t = 0; i < padded.length; i += 1600, t += 100) {
    const pcm = padded.slice(i, i + 1600);
    for (const l of listeners) l({ pcm, t });
    await new Promise((r) => setTimeout(r, 100 / SPEED));
  }
  adapter.stop();
  await done;
  return { segs, fallbacks, durationMs: (padded.length / 16000) * 1000 };
}

function checkWords(name: string, words: { text: string; t: number; t_end: number }[], durationMs: number) {
  expect(words.length).toBeGreaterThan(0);
  const starts = words.map((w) => w.t);
  expect(starts, 'monotonic word starts').toEqual([...starts].sort((a, b) => a - b));
  for (const w of words) {
    expect(w.t).toBeGreaterThanOrEqual(0);
    expect(w.t_end).toBeGreaterThanOrEqual(w.t);
    expect(w.t_end).toBeLessThanOrEqual(durationMs + 500);
  }
  // Each spoken clip's first word starts near where the fixture says the clip starts.
  // Timing, independent of what was recognized: a word starts near each spoken clip, and every word starts
  // inside one. Ends are not checked: Whisper stretches a span's last word into the silence after it.
  const clips = fixtureTiming(name) ?? [];
  for (const clip of clips) {
    const start = clip.start * 1000;
    const nearest = Math.min(...words.map((w) => Math.abs(w.t - start)));
    expect(nearest, `"${clip.text}" at ${clip.start}s`).toBeLessThanOrEqual(TIMING_TOLERANCE_MS);
  }
  for (const w of words) {
    const inClip =
      clips.length === 0 ||
      clips.some((c) => w.t >= c.start * 1000 - TIMING_TOLERANCE_MS && w.t <= c.end * 1000 + TIMING_TOLERANCE_MS);
    expect(inClip, `"${w.text}" at ${w.t} ms starts outside every spoken clip`).toBe(true);
  }
}

for (const vendor of ['deepgram', 'elevenlabs'] as const) {
  describe.skipIf(!KEYS[vendor])(`${vendor} (live service)`, () => {
    it.each(FIXTURE_NAMES)(`streaming: %s`, async (name) => {
      const { segs, fallbacks, durationMs } = await stream(vendor, name);
      expect(fallbacks, 'no fallback').toEqual([]);
      for (const s of segs) expect(s).toMatchObject({ engine: vendor, local: false, timestamp_quality: 'word' });
      const words = segs.flatMap((s) => s.words ?? []);
      const text = joinWords(segs.map((s) => s.text));
      const wer = wordErrorRate(fixtureReference(name), text);
      results.push({ vendor, path: 'stream', name, wer, text });
      expect(wer, text).toBeLessThanOrEqual(MAX_WER);
      checkWords(name, words, durationMs);
    });

    it.each(FIXTURE_NAMES)(`batch: %s`, async (name) => {
      const file = new Blob([readFileSync(join(AUDIO_DIR, `${name}.wav`))], { type: 'audio/wav' });
      const r =
        vendor === 'deepgram'
          ? await transcribeDeepgramFile(file, KEYS[vendor]!, 'en-US')
          : await transcribeElevenLabsFile(file, KEYS[vendor]!, 'en-US');
      const words = r.groups.flat().map((w) => ({ text: w.text, t: w.start_ms, t_end: w.end_ms }));
      const text = joinWords(words.map((w) => w.text));
      const wer = wordErrorRate(fixtureReference(name), text);
      results.push({ vendor, path: 'batch', name, wer, text });
      expect(wer, text).toBeLessThanOrEqual(MAX_WER);
      checkWords(name, words, readPcm16Wav(name).samples.length / 16);
    });
  });
}

afterAll(() => {
  if (results.length === 0) return;
  console.log('\nvendor      path    fixture               WER');
  for (const r of results)
    console.log(`${r.vendor.padEnd(11)} ${r.path.padEnd(7)} ${r.name.padEnd(21)} ${r.wer.toFixed(2)}  ${r.text}`);
});
