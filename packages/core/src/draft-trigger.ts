// When a live Draft Item pass runs (PRD P0-10). Pure and clock-free: the service worker feeds it Session-time
// signals and polls it; tests drive it with a fake clock.
//
// - Annotation trigger: an Annotation closed since the last pass, and ~3 s of silence followed. Silence is
//   measured from the latest activity: the Annotation's close, a VAD speech end, or a transcript segment's
//   arrival. Any of those restarts the wait, so a burst of Annotations and speech is one pass (debounced).
//   While the VAD says someone is speaking, nothing fires.
// - Fallback: speech happened since the last pass with no Annotation, and 30 s passed since the last pass
//   (or the Session start).
// - One pass at a time. Signals that arrive while a pass is in flight are kept, so at most one more pass
//   follows it; anything later folds into that one.
// - Pause resets the "speaking" flag: the VAD's end edge for speech cut off by a pause never arrives.

export const DRAFT_SILENCE_MS = 3000;
export const DRAFT_FALLBACK_MS = 30_000;

export type DraftPassReason = 'annotation' | 'fallback';

export interface DraftTrigger {
  annotationClosed(t: number): void;
  speechStarted(t: number): void;
  speechEnded(t: number): void;
  /** A transcript segment arrived at `t`. */
  segment(t: number): void;
  /** Paused or resumed: open speech is over. */
  reset(t: number): void;
  /** The pass due at `now`, if any; it is then in flight until done(). */
  take(now: number): DraftPassReason | null;
  done(): void;
  readonly inFlight: boolean;
}

export function createDraftTrigger({
  silenceMs = DRAFT_SILENCE_MS,
  fallbackMs = DRAFT_FALLBACK_MS,
  startAt = 0,
} = {}): DraftTrigger {
  let pendingAnnotation = false;
  let speech = false;
  let speaking = false;
  let lastActivity = -Infinity;
  let lastPassAt = startAt;
  let inFlight = false;
  const touch = (t: number) => (lastActivity = Math.max(lastActivity, t));

  return {
    annotationClosed(t) {
      pendingAnnotation = true;
      touch(t);
    },
    speechStarted() {
      speaking = true;
      speech = true;
    },
    speechEnded(t) {
      speaking = false;
      speech = true;
      touch(t);
    },
    segment(t) {
      speech = true;
      touch(t);
    },
    reset(t) {
      speaking = false;
      touch(t);
    },
    take(now) {
      if (inFlight || speaking) return null;
      let reason: DraftPassReason | null = null;
      if (pendingAnnotation && now - lastActivity >= silenceMs) reason = 'annotation';
      else if (!pendingAnnotation && speech && now - lastPassAt >= fallbackMs) reason = 'fallback';
      if (!reason) return null;
      inFlight = true;
      pendingAnnotation = false;
      speech = false;
      lastPassAt = now;
      return reason;
    },
    done() {
      inFlight = false;
    },
    get inFlight() {
      return inFlight;
    },
  };
}
