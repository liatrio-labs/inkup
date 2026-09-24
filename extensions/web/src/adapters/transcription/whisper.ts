// Free alternate tier (PRD P0-7): local Whisper, per vad-web speech span, in the offscreen document.
//
// Each span the VAD closes (src/entrypoints/offscreen/voice.ts) is transcribed in order; the next span waits
// for the one before, so captions lag by about one span. Words come back in ms from the span's start and are
// placed at span.t + offset on the Session clock. The model must already be in the cache (downloaded from the
// options page); if it is not, or the VAD cannot load, the adapter falls back to the free default like a paid
// tier would, with one `transcription_fallback`.
import { joinWords } from '@inkup/core/transcription-runs';
import type { WhisperModelId } from '@/settings';
import { createAsyncQueue } from './queue';
import { fallbackTarget } from './streaming';
import type { AdapterContext, Segment, SpeechSpan, TranscriptionAdapter, TranscriptionInfo } from './types';
import { loadWhisper, missingWhisperFiles, transcribeWords, WHISPER_ENGINE, WHISPER_MODELS } from './whisper-model';

export interface WhisperOptions {
  model: WhisperModelId;
  ortBase: string;
  fallback: (ctx: AdapterContext) => TranscriptionAdapter;
}

export const whisperInfo: TranscriptionInfo = {
  engine: WHISPER_ENGINE,
  local: true,
  timestamp_quality: 'word',
  captions: 'live',
};

export function createWhisperAdapter(ctx: AdapterContext, opts: WhisperOptions): TranscriptionAdapter {
  const queue = createAsyncQueue<Segment>();
  let resolveInfo!: (i: TranscriptionInfo) => void;
  const infoPromise = new Promise<TranscriptionInfo>((r) => (resolveInfo = r));
  let unsubscribe: (() => void) | null = null;
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;
  let fallback: TranscriptionAdapter | null = null;
  let fallbackDone: Promise<void> = Promise.resolve();

  async function fallBack(stream: MediaStream, reason: string) {
    const fb = opts.fallback({ ...ctx, onFallback: () => {} });
    fallback = fb;
    const it = fb.start(stream);
    const info = await fb.describe();
    ctx.onFallback?.({ from: WHISPER_ENGINE, to: fallbackTarget(info), reason, info });
    resolveInfo(info);
    fallbackDone = (async () => {
      try {
        for await (const s of it) queue.push(s);
      } catch (e) {
        queue.end(e);
      }
    })();
  }

  function transcribe(asr: Awaited<ReturnType<typeof loadWhisper>>, span: SpeechSpan) {
    chain = chain.then(async () => {
      try {
        const words = (await transcribeWords(asr, span.audio, ctx.lang)).map((w) => ({
          text: w.text,
          t: Math.round(span.t + w.start_ms),
          t_end: Math.round(Math.min(span.t_end, span.t + w.end_ms)),
        }));
        if (words.length === 0) return;
        queue.push({
          text: joinWords(words.map((w) => w.text)),
          t: words[0]!.t,
          t_end: Math.max(words[0]!.t, words.at(-1)!.t_end),
          engine: WHISPER_ENGINE,
          local: true,
          timestamp_quality: 'word',
          words,
          confidence: null,
        });
      } catch (e) {
        console.warn('[var] Whisper failed on a speech span', e);
      }
    });
  }

  return {
    describe: () => infoPromise,
    start(stream) {
      void (async () => {
        const model = WHISPER_MODELS[opts.model];
        const missing = await missingWhisperFiles(opts.ortBase, model.id);
        if (missing.length)
          return fallBack(
            stream,
            `whisper_model_missing: ${model.repo} is not downloaded (${missing.slice(0, 3).join(', ')})`,
          );
        if (!ctx.speech || !(await ctx.speech.ready))
          return fallBack(stream, 'vad_unavailable: Whisper transcribes VAD speech spans');
        let asr: Awaited<ReturnType<typeof loadWhisper>>;
        try {
          asr = await loadWhisper(opts.ortBase, model.id);
        } catch (e) {
          return fallBack(stream, `whisper_load_failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (stopped) return;
        resolveInfo(whisperInfo);
        unsubscribe = ctx.speech.onSpeech((span) => transcribe(asr, span));
      })();
      return queue;
    },
    stop() {
      stopped = true;
      unsubscribe?.();
      resolveInfo(whisperInfo);
      void (async () => {
        if (fallback) {
          fallback.stop();
          await fallbackDone;
        }
        // Spans already queued finish first: their words belong to the Session.
        await chain;
        queue.end();
      })();
    },
  };
}
