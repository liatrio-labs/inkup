// Replays a timed transcript fixture instead of recognizing speech. Selected only by the dev/test override
// (src/settings.ts devOverrides); never offered in production UI. The mic stream is still recorded by the
// caller, so everything except recognition runs for real.
import type { ScriptedTranscript } from '@/settings';
import { createAsyncQueue } from './queue';
import type { AdapterContext, Segment, TranscriptionAdapter } from './types';

export const SCRIPTED_ENGINE = 'scripted';

export function createScriptedAdapter(
  script: ScriptedTranscript,
  ctx: AdapterContext,
  timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = globalThis,
): TranscriptionAdapter {
  const queue = createAsyncQueue<Segment>();
  const handles: ReturnType<typeof setTimeout>[] = [];
  const info = {
    engine: SCRIPTED_ENGINE,
    local: true,
    timestamp_quality: script.timestamp_quality,
    captions: 'live' as const,
  };
  return {
    describe: () => Promise.resolve(info),
    start() {
      const cues = [...script.cues].sort((a, b) => a.at_ms - b.at_ms);
      // The iterable stays open after the last cue: the Session is still live, the reviewer is just quiet.
      for (const cue of cues) {
        // An interim caption with the first half of the words shortly before the final, as Web Speech shows them.
        const words = cue.text.split(/\s+/);
        const interimAt = cue.at_ms - Math.min(400, Math.floor(cue.duration_ms / 2));
        if (words.length > 1 && interimAt > 0)
          handles.push(
            timers.setTimeout(() => ctx.onInterim?.(words.slice(0, Math.ceil(words.length / 2)).join(' ')), interimAt),
          );
        handles.push(
          timers.setTimeout(() => {
            const t_end = ctx.now();
            queue.push({
              text: cue.text,
              t: Math.max(0, t_end - cue.duration_ms),
              t_end,
              engine: info.engine,
              local: info.local,
              timestamp_quality: info.timestamp_quality,
              words: null,
              confidence: null,
            });
          }, cue.at_ms),
        );
      }
      return queue;
    },
    stop() {
      handles.forEach((h) => {
        timers.clearTimeout(h);
      });
      queue.end();
    },
  };
}
