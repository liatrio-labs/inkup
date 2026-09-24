// Free default tier (PRD P0-7): Chrome's Web Speech API, on-device only by default (P0-15: zero network calls).
// - Recognition starts with processLocally: true only when SpeechRecognition.available({processLocally:true})
//   says 'available'. Otherwise, by default, no recognizer is started at all: the Session keeps recording
//   audio, Strokes and screenshots without live captions, and the adapter reports a fallback with reason
//   'on_device_unavailable' (to: 'none').
// - Only with the explicit opt-in `allowServer` does it use Chrome's server recognizer instead, marking every
//   segment local: false and reporting the fallback (to: 'webspeech-server').
// - Timestamps are approximate: a result's span starts when its first interim result arrived and ends when the
//   final result arrived, both stamped on the Session clock.
// - Chrome ends continuous recognition after silence or network hiccups; the adapter restarts until stop().
import { createAsyncQueue } from './queue';
import type { AdapterContext, Segment, TranscriptionAdapter, TranscriptionInfo } from './types';

export const WEBSPEECH_ENGINE = 'webspeech';
export const ON_DEVICE = 'webspeech-on-device';
export const SERVER = 'webspeech-server';
export const ON_DEVICE_UNAVAILABLE = 'on_device_unavailable';

export interface WebSpeechOptions {
  /** Opt-in (default off): use Chrome's server recognizer when on-device recognition is unavailable. */
  allowServer: boolean;
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}
export interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
}
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
}
export interface SpeechRecognitionCtor {
  new (): SpeechRecognitionLike;
  available?: (o: { langs: string[]; processLocally: boolean }) => Promise<string>;
}

export function findSpeechRecognition(): SpeechRecognitionCtor | undefined {
  const g = globalThis as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition;
}

/** Errors that end a recognition run without ending the Session; onend restarts it. */
const TRANSIENT = new Set(['no-speech', 'aborted', 'audio-capture']);

export function createWebSpeechAdapter(
  ctx: AdapterContext,
  { allowServer }: WebSpeechOptions = { allowServer: false },
  Ctor: SpeechRecognitionCtor | undefined = findSpeechRecognition(),
): TranscriptionAdapter {
  const queue = createAsyncQueue<Segment>();
  let recognition: SpeechRecognitionLike | null = null;
  let running = false;
  let processLocally = false;
  let captions: TranscriptionInfo['captions'] = 'live';
  let track: MediaStreamTrack | undefined;
  let resolveInfo!: (i: TranscriptionInfo) => void;
  const infoPromise = new Promise<TranscriptionInfo>((r) => (resolveInfo = r));
  const info = (): TranscriptionInfo => ({
    engine: WEBSPEECH_ENGINE,
    local: processLocally || captions === 'unavailable',
    timestamp_quality: 'approximate',
    captions,
  });

  /** On-device is not usable: go to the server if opted in, else stop recognizing. Returns true to keep running. */
  function onDeviceUnavailable(): boolean {
    if (allowServer) {
      processLocally = false;
      ctx.onFallback?.({ from: ON_DEVICE, to: SERVER, reason: ON_DEVICE_UNAVAILABLE });
      return true;
    }
    captions = 'unavailable';
    processLocally = false;
    ctx.onFallback?.({ from: ON_DEVICE, to: 'none', reason: ON_DEVICE_UNAVAILABLE });
    return false;
  }

  async function decideLocal(): Promise<boolean> {
    if (!Ctor?.available) return false;
    try {
      return (await Ctor.available({ langs: [ctx.lang], processLocally: true })) === 'available';
    } catch {
      return false;
    }
  }

  function run(track: MediaStreamTrack | undefined) {
    if (!Ctor) return;
    const r = new Ctor();
    recognition = r;
    r.lang = ctx.lang;
    r.continuous = true;
    r.interimResults = true;
    if ('processLocally' in r) r.processLocally = processLocally;
    const firstSeen = new Map<number, number>();
    r.onresult = (e) => {
      const interim: string[] = [];
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (!firstSeen.has(i)) firstSeen.set(i, ctx.now());
        if (!res.isFinal) {
          interim.push(res[0]?.transcript.trim() ?? '');
          continue;
        }
        const alt = res[0];
        const text = alt?.transcript.trim() ?? '';
        if (!text) continue;
        const t_end = ctx.now();
        queue.push({
          text,
          t: Math.min(firstSeen.get(i) ?? t_end, t_end),
          t_end,
          engine: WEBSPEECH_ENGINE,
          local: processLocally,
          timestamp_quality: 'approximate',
          words: null,
          confidence: typeof alt?.confidence === 'number' && alt.confidence > 0 ? alt.confidence : null,
        });
      }
      const words = interim.filter(Boolean).join(' ');
      if (words) ctx.onInterim?.(words);
    };
    r.onerror = (e) => {
      if (e.error === 'language-not-supported' && processLocally) {
        // On-device pack missing after all. onend follows: it restarts on the server only if opted in.
        if (!onDeviceUnavailable()) running = false;
        return;
      }
      if (!TRANSIENT.has(e.error)) {
        running = false;
        queue.end(new Error(`speech recognition: ${e.error}${e.message ? ` (${e.message})` : ''}`));
      }
    };
    r.onend = () => {
      if (running) run(track);
    };
    try {
      if (track) r.start(track);
      else r.start();
    } catch {
      r.start(); // engines without MediaStreamTrack input (pre-Chrome 139) use the default mic
    }
  }

  return {
    describe: () => infoPromise,
    start(stream) {
      running = true;
      if (!Ctor) {
        queue.end(new Error('SpeechRecognition is not available in this context'));
        resolveInfo(info());
        return queue;
      }
      void decideLocal().then((local) => {
        processLocally = local;
        const keepGoing = local || onDeviceUnavailable();
        resolveInfo(info());
        // Without on-device speech and without the opt-in, no recognizer is ever constructed; the iterable stays
        // open (and empty) until stop().
        track = stream.getAudioTracks()[0];
        if (running && keepGoing) run(track);
      });
      return queue;
    },
    pause() {
      if (!running) return;
      running = false;
      try {
        recognition?.stop();
      } catch {
        /* already stopped */
      }
    },
    resume() {
      if (running || queue.ended || captions === 'unavailable') return;
      running = true;
      run(track);
    },
    stop() {
      running = false;
      try {
        recognition?.stop();
      } catch {
        /* already stopped */
      }
      // Give the engine a moment to deliver the last final result before closing.
      setTimeout(() => queue.end(), 300);
    },
  };
}
