// The free default in a browser without the Web Speech API (Firefox): nothing recognizes speech, so the Session
// records audio, Strokes and screenshots without live captions, like Chrome without an on-device pack and without
// the server opt-in. It says so once, as a fallback event, instead of failing the Session. Whisper or a paid tier
// give captions there (background/transcription.ts prefers a downloaded Whisper model).
import { createAsyncQueue } from './queue';
import type { AdapterContext, Segment, TranscriptionAdapter, TranscriptionInfo } from './types';

export const NO_ENGINE = 'none';
export const SPEECH_RECOGNITION_UNSUPPORTED = 'speech_recognition_unsupported';

export function createNoSpeechAdapter(ctx: AdapterContext): TranscriptionAdapter {
  const queue = createAsyncQueue<Segment>();
  const info: TranscriptionInfo = {
    engine: NO_ENGINE,
    local: true,
    timestamp_quality: 'approximate',
    captions: 'unavailable',
  };
  return {
    describe: () => Promise.resolve(info),
    start() {
      ctx.onFallback?.({ from: 'webspeech', to: 'none', reason: SPEECH_RECOGNITION_UNSUPPORTED });
      return queue;
    },
    stop() {
      queue.end();
    },
  };
}
