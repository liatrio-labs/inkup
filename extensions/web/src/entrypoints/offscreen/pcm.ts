// The shared 16 kHz audio graph in the offscreen document (docs/PLAN.md "Resampling to 16 kHz PCM16"): one
// AudioContext({sampleRate: 16000}) on the mic stream, with the pcm16 AudioWorklet (public/worklets) turning each
// 100 ms into an Int16 frame for the streaming tiers. Chrome resamples the mic natively. It runs beside the
// MediaRecorder and vad-web, which read the same stream (vad-web through its own clone and AudioContext).
//
// Frame times: the worklet posts the context sample index of each frame's first sample. The first frame anchors
// that index to the Session clock, and every later frame is placed from the sample count, so frames stay evenly
// spaced even when messages arrive in bursts. The anchor subtracts how far the context's clock had run past the
// frame's last sample when the message arrived: a message delayed by a busy main thread would otherwise make every
// word late, up to past the end of the Session.
//
// With no working audio output (Firefox on a Linux box with no sound server) the context's resume() and close() can
// take ten seconds or never settle. Neither is waited on for longer than AUDIO_DEVICE_TIMEOUT_MS: the graph starts
// suspended (it posts no frames, the recording still runs) and Stop finishes without the 15 s backstop.
import { withTimeout } from '@inkup/core/overlay-lifetime';
import type { PcmFrame, PcmSource } from '@/adapters/transcription/types';

export const PCM_RATE = 16000;
export const FRAME_SAMPLES = 1600;
/** How long resume() and close() on the context are waited for. */
export const AUDIO_DEVICE_TIMEOUT_MS = 2_000;

export interface PcmGraph extends PcmSource {
  close(): Promise<void>;
}

export async function startPcmGraph(stream: MediaStream, now: () => number): Promise<PcmGraph> {
  const ctx = new AudioContext({ sampleRate: PCM_RATE });
  await ctx.audioWorklet.addModule(chrome.runtime.getURL('/worklets/pcm16-worklet.js'));
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm16', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { frameSamples: FRAME_SAMPLES },
  });
  // The worklet writes nothing to its output; the connection to the destination only keeps it rendering.
  source.connect(node).connect(ctx.destination);
  if (ctx.state !== 'running') await withTimeout(ctx.resume(), AUDIO_DEVICE_TIMEOUT_MS, undefined);

  const listeners = new Set<(f: PcmFrame) => void>();
  let anchor: { frame: number; t: number } | null = null;
  node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; frame: number }>) => {
    const pcm = new Int16Array(e.data.pcm);
    if (!anchor) {
      const lagMs = Math.max(0, ((ctx.currentTime * PCM_RATE - (e.data.frame + pcm.length)) * 1000) / PCM_RATE);
      anchor = { frame: e.data.frame, t: now() - lagMs - (pcm.length * 1000) / PCM_RATE };
    }
    const t = Math.max(0, Math.round(anchor.t + ((e.data.frame - anchor.frame) * 1000) / PCM_RATE));
    for (const l of listeners) l({ pcm, t });
  };
  return {
    sampleRate: PCM_RATE,
    onFrame(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async close() {
      listeners.clear();
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      await withTimeout(ctx.close(), AUDIO_DEVICE_TIMEOUT_MS, undefined);
    },
  };
}
