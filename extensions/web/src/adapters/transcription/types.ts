// One interface for every transcription engine (PRD P0-7): start(stream) → AsyncIterable<Segment>.
// Adapters stamp segments on the Session clock through the injected `now()` (ms since t0).
import type { TimestampQuality } from '@inkup/core/timeline';

export interface Word {
  text: string;
  t: number;
  t_end: number;
}

export interface Segment {
  text: string;
  /** Span start, ms since t0. Approximate engines estimate it. */
  t: number;
  t_end: number;
  engine: string;
  /** true: audio stayed on this machine. false: a server recognized it. */
  local: boolean;
  timestamp_quality: TimestampQuality;
  words: Word[] | null;
  confidence: number | null;
}

export interface TranscriptionInfo {
  engine: string;
  local: boolean;
  timestamp_quality: TimestampQuality;
  /** 'unavailable': the engine is not recognizing anything (e.g. no on-device pack and no server opt-in). */
  captions: 'live' | 'unavailable';
}

/** The engine changed mode or stopped recognizing; logged as a `transcription_fallback` event. */
export interface Fallback {
  from: string;
  to: string;
  reason: string;
  /** What transcribes from now on, when the engine itself changed (a paid tier fell back to the free default). */
  info?: TranscriptionInfo;
}

/** 100 ms of mic audio as 16 kHz mono PCM16, stamped with the Session time of its first sample. */
export interface PcmFrame {
  pcm: Int16Array;
  t: number;
}

/** The shared 16 kHz PCM16 graph in the offscreen document (one AudioContext + worklet on the mic stream). */
export interface PcmSource {
  readonly sampleRate: number;
  /** Receive every frame from now on; returns the unsubscribe function. */
  onFrame(fn: (f: PcmFrame) => void): () => void;
}

/** One vad-web speech span: its 16 kHz Float32 audio and where it lies on the Session clock. */
export interface SpeechSpan {
  audio: Float32Array;
  t: number;
  t_end: number;
}
export interface SpeechSpanSource {
  onSpeech(fn: (s: SpeechSpan) => void): () => void;
  /** Resolves true once the VAD is running, false if it failed to load. */
  ready: Promise<boolean>;
}

export interface TranscriptionAdapter {
  /** Begin transcribing. The iterable ends after stop() once buffered segments are drained. */
  start(stream: MediaStream): AsyncIterable<Segment>;
  /** Resolves once the engine is configured (e.g. on-device vs server decided). */
  describe(): Promise<TranscriptionInfo>;
  stop(): void;
  /** Stop recognizing until resume() (Session pause). Engines that keep audio local may leave it out. */
  pause?(): void;
  resume?(): void;
}

export interface AdapterContext {
  /** Session clock: ms since t0. */
  now: () => number;
  lang: string;
  onFallback?: (f: Fallback) => void;
  /** The shared PCM graph, started on first use (streaming tiers). */
  pcm?: () => Promise<PcmSource>;
  /** VAD speech spans (local Whisper transcribes each one). */
  speech?: SpeechSpanSource;
  /** The words so far of an utterance not yet final, for engines that have them (a comment box shows them, E11). */
  onInterim?: (text: string) => void;
}
