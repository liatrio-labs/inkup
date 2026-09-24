// Feeding the voice activity detector from Start (PRD P0-7, P0-8). The model takes seconds to load on a slow
// machine, and speech before that must still make islands, Voice Commands and Whisper spans. The offscreen
// document buffers the 16 kHz PCM16 frames from Start, and this module turns them into the detector's frames in
// order once it is ready, each with its own Session time. Clock-free and model-free: `process` is injected.

export interface PcmFrameIn {
  pcm: Int16Array;
  /** Session time of the frame's first sample, ms. */
  t: number;
}

export interface VadFeed {
  /** A PCM frame from the graph: buffered until `start`, then processed in order. */
  push(frame: PcmFrameIn): void;
  /** The detector is ready: process the backlog, then every frame as it comes. */
  start(): void;
  /** Stop processing; resolves once the frame in progress is done. The backlog is dropped. */
  stop(): Promise<void>;
  /** Frames waiting (for tests and diagnostics). */
  readonly pending: number;
}

export interface VadFeedOptions {
  /** Samples per detector frame (Silero v5: 512). */
  frameSamples: number;
  sampleRateKhz: number;
  /** Runs the detector on one frame; `t` is the Session time of its first sample. */
  process(frame: Float32Array, t: number): Promise<void>;
}

export function createVadFeed({ frameSamples, sampleRateKhz, process }: VadFeedOptions): VadFeed {
  const backlog: PcmFrameIn[] = [];
  let carry: { samples: Float32Array; t: number } | null = null;
  let started = false;
  let stopped = false;
  let pumping: Promise<void> | null = null;

  const drain = async () => {
    while (backlog.length && !stopped) {
      const f = backlog.shift()!;
      let samples = Float32Array.from(f.pcm, (v) => v / 32768);
      let t = f.t;
      if (carry) {
        const joined = new Float32Array(carry.samples.length + samples.length);
        joined.set(carry.samples);
        joined.set(samples, carry.samples.length);
        ({ t } = carry);
        samples = joined;
        carry = null;
      }
      let i = 0;
      for (; i + frameSamples <= samples.length && !stopped; i += frameSamples) {
        await process(samples.slice(i, i + frameSamples), t + i / sampleRateKhz);
      }
      if (i < samples.length && !stopped) carry = { samples: samples.slice(i), t: t + i / sampleRateKhz };
    }
  };

  const pump = () => {
    if (!started || stopped || pumping) return;
    pumping = drain()
      .catch((e: unknown) => console.warn('[var] VAD frame failed', e))
      .finally(() => {
        pumping = null;
        if (backlog.length) pump();
      });
  };

  return {
    push(frame) {
      if (stopped) return;
      backlog.push(frame);
      pump();
    },
    start() {
      started = true;
      pump();
    },
    async stop() {
      stopped = true;
      backlog.length = 0;
      await pumping;
    },
    get pending() {
      return backlog.length;
    },
  };
}

export interface SpanHold<S> {
  /** A span: to every listener, or held until the first one subscribes. */
  emit(span: S): void;
  /** Subscribes; the first listener also gets every held span, oldest first. */
  subscribe(fn: (span: S) => void): () => void;
  clear(): void;
}

/**
 * Speech spans for a listener that subscribes late (local Whisper loads its model after the detector is
 * ready). At most `maxSamples` of audio are held: the oldest spans go first.
 */
export function createSpanHold<S extends { audio: { length: number } }>(maxSamples: number): SpanHold<S> {
  const listeners = new Set<(span: S) => void>();
  let held: S[] = [];
  let heldSamples = 0;
  return {
    emit(span) {
      if (listeners.size) {
        for (const l of listeners) l(span);
        return;
      }
      held.push(span);
      heldSamples += span.audio.length;
      while (heldSamples > maxSamples && held.length > 1) heldSamples -= held.shift()!.audio.length;
    },
    subscribe(fn) {
      listeners.add(fn);
      const out = held;
      held = [];
      heldSamples = 0;
      for (const span of out) fn(span);
      return () => listeners.delete(fn);
    },
    clear() {
      held = [];
      heldSamples = 0;
    },
  };
}
