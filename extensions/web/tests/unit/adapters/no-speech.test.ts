// The free default where the browser has no Web Speech API (Firefox): the Session records without captions and
// logs one fallback, instead of the adapter failing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTranscriptionAdapter } from '@/adapters/transcription';
import type { Fallback, Segment } from '@/adapters/transcription/types';

const fakeStream = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;

async function drain(it: AsyncIterable<Segment>): Promise<Segment[]> {
  const out: Segment[] = [];
  for await (const s of it) out.push(s);
  return out;
}

describe('free default without SpeechRecognition', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('records without captions and reports one fallback', async () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    vi.stubGlobal('webkitSpeechRecognition', undefined);
    const fallbacks: Fallback[] = [];
    const adapter = createTranscriptionAdapter(
      { adapter: 'webspeech', allow_server: true },
      { now: () => 5, lang: 'en-US', onFallback: (f) => fallbacks.push(f) },
    );
    const segments = drain(adapter.start(fakeStream));
    expect(await adapter.describe()).toEqual({
      engine: 'none',
      local: true,
      timestamp_quality: 'approximate',
      captions: 'unavailable',
    });
    adapter.stop();
    expect(await segments).toEqual([]);
    expect(fallbacks).toEqual([{ from: 'webspeech', to: 'none', reason: 'speech_recognition_unsupported' }]);
  });

  it('still uses Web Speech where the browser has it', async () => {
    class Recognition {
      static available = () => Promise.resolve('available');
      lang = '';
      continuous = false;
      interimResults = false;
      onresult = null;
      onerror = null;
      onend = null;
      start() {}
      stop() {}
      abort() {}
    }
    vi.stubGlobal('SpeechRecognition', Recognition);
    const adapter = createTranscriptionAdapter(
      { adapter: 'webspeech', allow_server: false },
      { now: () => 5, lang: 'en-US' },
    );
    adapter.start(fakeStream);
    expect((await adapter.describe()).engine).toBe('webspeech');
    adapter.stop();
  });
});
