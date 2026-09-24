import type { ScriptedTranscript, WhisperModelId } from '@/settings';
import { createDeepgramEngine } from './deepgram';
import { createElevenLabsEngine } from './elevenlabs';
import { createNoSpeechAdapter } from './none';
import { createScriptedAdapter } from './scripted';
import { createStreamingAdapter } from './streaming';
import type { AdapterContext, TranscriptionAdapter } from './types';
import { createWebSpeechAdapter, findSpeechRecognition } from './webspeech';
import { createWhisperAdapter } from './whisper';

/** The free default every other engine falls back to: on-device Web Speech, server speech only with the opt-in. */
export interface FreeDefault {
  allow_server: boolean;
}

export type AdapterConfig =
  | { adapter: 'webspeech'; allow_server: boolean }
  | { adapter: 'scripted'; script: ScriptedTranscript }
  | { adapter: 'whisper'; model: WhisperModelId; ort_base: string; fallback: FreeDefault }
  | { adapter: 'deepgram'; key: string; base_url: string | null; retry_base_ms: number | null; fallback: FreeDefault }
  | {
      adapter: 'elevenlabs';
      key: string;
      base_url: string | null;
      retry_base_ms: number | null;
      fallback: FreeDefault;
    };

export function createTranscriptionAdapter(config: AdapterConfig, ctx: AdapterContext): TranscriptionAdapter {
  switch (config.adapter) {
    case 'webspeech':
      return webSpeechOrNone(ctx, config.allow_server);
    case 'scripted':
      return createScriptedAdapter(config.script, ctx);
    case 'whisper':
      return createWhisperAdapter(ctx, {
        model: config.model,
        ortBase: config.ort_base,
        fallback: freeDefault(config.fallback),
      });
    case 'deepgram':
    case 'elevenlabs': {
      const opts = { key: config.key, baseUrl: config.base_url ?? undefined, lang: ctx.lang };
      const engine = config.adapter === 'deepgram' ? createDeepgramEngine(opts) : createElevenLabsEngine(opts);
      return createStreamingAdapter(engine, ctx, {
        fallback: freeDefault(config.fallback),
        ...(config.retry_base_ms ? { policy: { baseMs: config.retry_base_ms } } : {}),
      });
    }
  }
}

/** Web Speech where the browser has it; without it (Firefox) the Session goes on without live captions. */
const webSpeechOrNone = (ctx: AdapterContext, allowServer: boolean) =>
  findSpeechRecognition() ? createWebSpeechAdapter(ctx, { allowServer }) : createNoSpeechAdapter(ctx);

const freeDefault = (f: FreeDefault) => (ctx: AdapterContext) => webSpeechOrNone(ctx, f.allow_server);

export type { Fallback, Segment, TranscriptionAdapter, TranscriptionInfo } from './types';
