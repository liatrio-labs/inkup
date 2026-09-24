// Voice Commands in the offscreen document (PRD P0-8). @ricky0123/vad-web runs Silero v5, from the locally
// bundled ORT and model files (docs/spikes/README.md), on the shared 16 kHz PCM graph (./pcm.ts). Each frame's
// speech probability becomes speech/silence edges on the Session clock (packages/core/src/speech-activity.ts); the edges
// and the final transcript segments feed the command watcher (packages/core/src/voice-commands.ts), which is ticked every
// 100 ms. Confirmed commands go to the service worker, which logs and acts on them. Speech spans are logged as
// `speech_activity` events (not while paused).
//
// The PCM is buffered from Start: loading the model takes seconds on a slow machine (2.9 s on the CI runners),
// and vad-web's own microphone node would only hear what comes after. The backlog is fed through once the model
// is ready, with each frame's own time, so speech from the first seconds still makes islands, Voice Commands and
// (for local Whisper) speech spans.
import { spokenSpan } from '@inkup/core/process/align';
import type { Span } from '@inkup/core/process/pairing';
import { type ActivityEdge, createSpeechActivityTracker } from '@inkup/core/speech-activity';
import { createSpanHold, createVadFeed } from '@inkup/core/vad-feed';
import { createCommandWatcher, type WatchedSegment } from '@inkup/core/voice-commands';
import type { PcmSource, SpeechSpan, SpeechSpanSource } from '@/adapters/transcription/types';
import { sendMessage } from '@/messaging';

export interface VoiceCommands {
  /** vad-web's speech spans with their audio: local Whisper transcribes each one. */
  speech: SpeechSpanSource;
  segment(seg: WatchedSegment): void;
  /**
   * When a late (approximate) segment was said: the VAD speech that explains it (packages/core/src/process/align.ts),
   * or null when the VAD heard none (not loaded yet, or muted).
   */
  spoken(seg: Span): Span | null;
  setCaptions(live: boolean): void;
  setPaused(paused: boolean): void;
  /** Mute (E10): no Voice Command at all (not even `resume`), and no speech spans or starts are reported. */
  setMuted(muted: boolean): void;
  /**
   * A comment box is dictating (E11): its speech is the comment's, so no Voice Command and no speech activity is
   * reported; speech spans still go to local Whisper, which transcribes the dictation.
   */
  setDictating(dictating: boolean): void;
  stop(): Promise<void>;
}

const TICK_MS = 100;
const SAMPLE_RATE_KHZ = 16;
/** Silero v5's frame: 512 samples, 32 ms at 16 kHz. */
const VAD_FRAME = 512;
/** Recent speech/silence spans kept for `spoken`. */
const KEPT_HEARD = 64;
/** Speech spans kept for a listener that has not subscribed yet (local Whisper loads its model first). */
const MAX_PENDING_SPAN_SAMPLES = 60 * 16_000;

/**
 * vad-web 0.0.31's MicVAD, fed frames by hand. Its frame processor and model are private: the processor starts
 * paused (start() would resume it and open a microphone), and destroy() assumes start() ran, so the model is
 * released directly.
 */
interface FedVad {
  processFrame(frame: Float32Array): Promise<void>;
  frameProcessor: { resume(): void };
  model: { release(): Promise<void> };
  start(): Promise<void>;
  destroy(): Promise<void>;
}

/** vad-web's private API that feeding by hand relies on is still there (a vad-web upgrade may remove it). */
export function canFeedByHand(v: unknown): boolean {
  const x = v as Partial<FedVad> | null;
  return (
    typeof x?.processFrame === 'function' &&
    typeof x.frameProcessor?.resume === 'function' &&
    typeof x.model?.release === 'function'
  );
}

export function startVoiceCommands(stream: MediaStream, pcm: Promise<PcmSource>, now: () => number): VoiceCommands {
  const watcher = createCommandWatcher();
  const tracker = createSpeechActivityTracker();
  let paused = false;
  let muted = false;
  let dictating = false;
  let captions = true;
  let ready = false;
  let stopped = false;
  let vad: FedVad | null = null;
  /** vad-web's internals changed: MicVAD runs on its own stream from when it loaded, on the wall clock. */
  let live = false;
  const spans = createSpanHold<SpeechSpan>(MAX_PENDING_SPAN_SAMPLES);
  /** Every span of speech the VAD heard lately (whatever is reported), and the start of the one going on. */
  let heard: Span[] = [];
  let speaking: number | null = null;
  // `frameT` is the Session time of the frame being processed, which the callbacks below use.
  let frameT = 0;
  const feed = createVadFeed({
    frameSamples: VAD_FRAME,
    sampleRateKhz: SAMPLE_RATE_KHZ,
    process: async (frame, t) => {
      frameT = t;
      await vad!.processFrame(frame);
    },
  });
  let unsubscribePcm = (): unknown => undefined;
  void pcm.then(
    (source) => {
      if (!stopped) unsubscribePcm = source.onFrame((f) => feed.push(f));
    },
    (e) => console.warn('[var] PCM graph for the VAD failed', e),
  );
  let resolveReady!: (ok: boolean) => void;
  const ready$ = new Promise<boolean>((r) => (resolveReady = r));

  const onEdges = (edges: ActivityEdge[]) => {
    for (const e of edges) {
      watcher.activity(e);
      if (e.type === 'speech_start') speaking = e.t;
      if (e.type === 'speech_end') {
        speaking = null;
        heard = [...heard, { t: e.start, t_end: e.t }].slice(-KEPT_HEARD);
      }
      if (e.type === 'speech_end' && !paused && !muted && !dictating)
        void sendMessage('speechActivity', { t: e.start, t_end: e.t }).catch(() => {});
      if (e.type === 'speech_start' && !paused && !muted && !dictating)
        void sendMessage('speechStart', { t: e.t }).catch(() => {});
    }
  };

  const loading = (async () => {
    try {
      const { MicVAD } = await import('@ricky0123/vad-web');
      const base = chrome.runtime.getURL('/vad/');
      const v = (await MicVAD.new({
        model: 'v5',
        baseAssetPath: base,
        // The ONNX Runtime wasm shared with Whisper (wxt.config.ts `vadUsesTransformersOrt`).
        onnxWASMBasePath: chrome.runtime.getURL('/ort/'),
        // Not started: frames come from the PCM graph through processFrame. Its own stream (a clone, so stopping
        // the VAD never stops the recorder's track) is only opened by the fallback below.
        startOnLoad: false,
        getStream: async () => stream.clone(),
        pauseStream: async () => {},
        resumeStream: async (s) => s,
        // vad-web's audio for a span runs from its pre-speech pad through the redemption silence, so it ends at
        // the frame that closed it: now. One-word Voice Commands ("next") must not be dropped as misfires.
        minSpeechMs: 150,
        onSpeechEnd: (audio) => {
          if (muted) return;
          const t_end = live ? now() : Math.round(frameT + VAD_FRAME / SAMPLE_RATE_KHZ);
          spans.emit({ audio, t: Math.max(0, Math.round(t_end - audio.length / SAMPLE_RATE_KHZ)), t_end });
        },
        onFrameProcessed: (probs, frame) => {
          const ms = frame.length / SAMPLE_RATE_KHZ;
          const t = Math.max(0, live ? now() - ms : frameT);
          if (!ready) {
            ready = true;
            watcher.activity({ type: 'ready', t });
            if (captions) void sendMessage('voiceCommandsStatus', { status: 'ready' }).catch(() => {});
          }
          onEdges(tracker.frame(t, probs.isSpeech, ms));
        },
      })) as unknown as FedVad;
      if (!canFeedByHand(v)) {
        // Early speech is lost again, but Voice Commands and Whisper spans work from now on.
        console.warn('[var] vad-web internals changed: the VAD hears only speech after it loaded');
        unsubscribePcm();
        void feed.stop();
        live = true;
        if (stopped) return resolveReady(false);
        await v.start();
        vad = v;
        resolveReady(true);
        if (stopped) await v.destroy();
        return;
      }
      if (stopped) {
        resolveReady(false);
        await v.model.release();
        return;
      }
      v.frameProcessor.resume();
      vad = v;
      resolveReady(true);
      feed.start();
    } catch (e) {
      resolveReady(false);
      // Nothing will read the buffered PCM: stop holding it.
      unsubscribePcm();
      void feed.stop();
      console.warn('[var] VAD failed to load', e);
      void sendMessage('voiceCommandsStatus', {
        status: 'unavailable',
        reason: 'Voice Commands are off: silence detection could not load.',
      }).catch(() => {});
    }
  })();

  const timer = setInterval(() => {
    const { confirmed, rejected } = watcher.tick(now());
    for (const hit of confirmed) {
      if (muted || dictating || (paused && hit.command !== 'resume')) continue;
      void sendMessage('voiceCommand', {
        command: hit.command,
        phrase: hit.phrase,
        segment_id: hit.segment_id,
        t: hit.t,
        t_end: hit.t_end,
      }).catch(() => {});
    }
    for (const r of rejected) console.debug(`[var] not a Voice Command: "${r.phrase}" (${r.reason})`);
  }, TICK_MS);

  return {
    speech: {
      ready: ready$,
      onSpeech: (fn) => spans.subscribe(fn),
    },
    segment(seg) {
      if (captions) watcher.segment(seg);
    },
    spoken(seg) {
      return spokenSpan(seg, speaking === null ? heard : [...heard, { t: speaking, t_end: now() }]);
    },
    setCaptions(live) {
      captions = live;
    },
    setPaused(p) {
      paused = p;
    },
    setMuted(m) {
      muted = m;
    },
    setDictating(d) {
      dictating = d;
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      unsubscribePcm();
      await loading;
      await feed.stop();
      await (live ? vad?.destroy() : vad?.model.release())?.catch(() => {});
      spans.clear();
    },
  };
}
