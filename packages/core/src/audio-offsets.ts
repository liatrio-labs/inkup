// Engine audio offsets ↔ Session time for streaming transcription (PRD P0-7, Slice 6).
//
// A streaming engine stamps words in seconds of the audio it has received on one connection. That audio is not
// a continuous slice of the Session: nothing is sent while the Session is paused, a reconnect starts a new
// connection at 0, and frames produced while disconnected are replayed after the reconnect. So the sender
// records every frame it sends, with the Session time of that frame's first sample (the capture time, not the
// send time), and an engine offset maps back through the frame that holds that sample.
//
// This is the streaming counterpart of media-time.ts: a MediaRecorder file also has no gap for a pause, and
// media-time.ts maps it through the session_pause/session_resume pairs. Here the frames carry their own capture
// times, so a pause gap needs no special case: the next frame sent after a resume starts at the resume time.
// Both mappings put a word at the Session time its audio was captured.

export interface SentFrame {
  /** First sample of the frame, counted from the start of this connection. */
  sample: number;
  /** Session time (ms since t0) at which the frame's first sample was captured. */
  t: number;
  /** Samples in the frame. */
  n: number;
}

export interface AudioOffsetMap {
  /** Records a frame sent on this connection, in send order. Returns its first sample index. */
  sent(t: number, n: number): number;
  /** Session time (ms, rounded) of an engine audio offset in seconds on this connection. */
  toSession(seconds: number): number;
  /** Seconds of audio sent so far. */
  readonly sentSeconds: number;
  readonly frames: readonly SentFrame[];
}

export function createAudioOffsetMap(sampleRate = 16000): AudioOffsetMap {
  const frames: SentFrame[] = [];
  let total = 0;
  const msPerSample = 1000 / sampleRate;
  return {
    frames,
    get sentSeconds() {
      return total / sampleRate;
    },
    sent(t, n) {
      const sample = total;
      frames.push({ sample, t, n });
      total += n;
      return sample;
    },
    toSession(seconds) {
      if (frames.length === 0) return 0;
      const s = Math.max(0, seconds * sampleRate);
      // The last frame starting at or before s (binary search: frames are in sample order).
      let lo = 0;
      let hi = frames.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (frames[mid]!.sample <= s) lo = mid;
        else hi = mid - 1;
      }
      const f = frames[lo]!;
      // Past the end of the frame (a word end in the gap before the next frame, or past everything sent):
      // clamp to the frame's end, so time never runs into a pause.
      const within = Math.min(s - f.sample, f.n);
      return Math.max(0, Math.round(f.t + within * msPerSample));
    },
  };
}

/** Float32 samples in [-1, 1] → 16-bit signed PCM, clamped (the same conversion the PCM worklet runs). */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** PCM16 → Float32 in [-1, 1) (Whisper and the eval read WAV files this way). */
export function pcm16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i]! / 0x8000;
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Little-endian PCM16 bytes as base64 (ElevenLabs Scribe takes audio chunks as base64 JSON). */
export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i]!, true);
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}==`;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}${B64[(n >> 6) & 63]}=`;
  }
  return out;
}
