// Speech/silence edges from per-frame speech probabilities (Silero via @ricky0123/vad-web, run in the offscreen
// document). vad-web's own onSpeechStart/onSpeechEnd are built for cutting utterances: they wait `redemptionMs`
// before ending speech and pad the audio. Voice Commands need the raw edges on the Session clock instead, so
// this tracker applies the same hysteresis to each frame's probability with a short hangover.

export interface SpeechActivityOptions {
  /** A frame at or above this probability is speech (vad-web's default). */
  positive?: number;
  /** Speech continues until frames stay below this for `hangoverMs` (vad-web's default). */
  negative?: number;
  /** Shorter bursts (clicks, pops) are ignored. */
  minSpeechMs?: number;
  hangoverMs?: number;
}

export type ActivityEdge = { type: 'speech_start'; t: number } | { type: 'speech_end'; t: number; start: number };

export interface SpeechActivityTracker {
  /** One frame: `t` is the Session time of the frame's start, `ms` its length. Returns edges it completes. */
  frame(t: number, probability: number, ms: number): ActivityEdge[];
  /** Ends open speech at `t` (pause, stop). */
  flush(t: number): ActivityEdge[];
}

export function createSpeechActivityTracker({
  positive = 0.5,
  negative = 0.35,
  minSpeechMs = 90,
  hangoverMs = 160,
}: SpeechActivityOptions = {}): SpeechActivityTracker {
  /** Candidate or confirmed speech start. */
  let start: number | null = null;
  let confirmed = false;
  /** Start of the current run of quiet frames inside speech. */
  let quietSince: number | null = null;
  let lastEnd = 0;

  const end = (at: number): ActivityEdge[] => {
    const out: ActivityEdge[] = confirmed && start !== null ? [{ type: 'speech_end', t: at, start }] : [];
    start = null;
    confirmed = false;
    quietSince = null;
    return out;
  };

  return {
    frame(t, p, ms) {
      lastEnd = t + ms;
      const out: ActivityEdge[] = [];
      if (start === null) {
        if (p >= positive) {
          start = t;
          quietSince = null;
        }
      } else if (p < negative) {
        quietSince ??= t;
        if (t + ms - quietSince >= hangoverMs) return end(quietSince);
      } else if (p >= positive) {
        quietSince = null;
      }
      if (start !== null && !confirmed && t + ms - start >= minSpeechMs && quietSince === null) {
        confirmed = true;
        out.push({ type: 'speech_start', t: start });
      }
      return out;
    },
    flush(t) {
      return end(quietSince ?? Math.max(t, lastEnd));
    },
  };
}
