// The PCM graph (src/entrypoints/offscreen/pcm.ts) with no working audio device: an AudioContext whose resume() and
// close() never settle, as Firefox's does on a Linux box with no sound server. Start and close still finish, each
// within AUDIO_DEVICE_TIMEOUT_MS, so Stop is not held to its 15 s backstop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_DEVICE_TIMEOUT_MS, startPcmGraph } from '@/entrypoints/offscreen/pcm';

const never = () => new Promise<void>(() => {});

class StuckAudioContext {
  static last: StuckAudioContext | null = null;
  state = 'suspended';
  currentTime = 0;
  destination = {};
  audioWorklet = { addModule: async () => {} };
  resume = vi.fn(never);
  close = vi.fn(never);
  constructor() {
    StuckAudioContext.last = this;
  }
  createMediaStreamSource() {
    return { connect: (n: unknown) => n, disconnect() {} };
  }
}

class FakeWorkletNode {
  port: { onmessage: unknown } = { onmessage: null };
  connect(n: unknown) {
    return n;
  }
  disconnect() {}
}

describe('startPcmGraph with no audio device', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('AudioContext', StuckAudioContext);
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts, and closes, without waiting on the context for more than the timeout', async () => {
    let started = false;
    const graph = startPcmGraph({} as MediaStream, () => 0).then((g) => {
      started = true;
      return g;
    });
    await vi.advanceTimersByTimeAsync(AUDIO_DEVICE_TIMEOUT_MS - 1);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toBe(true);
    expect(StuckAudioContext.last!.resume).toHaveBeenCalledOnce();

    let closed = false;
    const done = (await graph).close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(AUDIO_DEVICE_TIMEOUT_MS);
    await done;
    expect(closed).toBe(true);
    expect(StuckAudioContext.last!.close).toHaveBeenCalledOnce();
  });
});

describe('startPcmGraph after a microphone switch', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the new device through a new source node, connected before the old one goes', async () => {
    const log: string[] = [];
    class RunningContext extends StuckAudioContext {
      override state = 'running';
      override createMediaStreamSource(stream?: MediaStream) {
        const name = (stream as unknown as { name: string }).name;
        return {
          connect: (n: unknown) => {
            log.push(`${name} on`);
            return n;
          },
          disconnect: () => log.push(`${name} off`),
        };
      }
    }
    vi.stubGlobal('AudioContext', RunningContext);
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => p } });
    const graph = await startPcmGraph({ name: 'usb-1' } as unknown as MediaStream, () => 0);
    graph.setStream({ name: 'usb-2' } as unknown as MediaStream);
    expect(log).toEqual(['usb-1 on', 'usb-2 on', 'usb-1 off']);
  });
});
