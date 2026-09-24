import { describe, expect, it } from 'vitest';
import { createSpanHold, createVadFeed } from '../src/vad-feed';

const frame = (n: number, t: number, value = 16384) => ({ pcm: new Int16Array(n).fill(value), t });
const tick = () => new Promise((r) => setTimeout(r, 0));

function recorder() {
  const seen: { t: number; length: number; first: number }[] = [];
  return { seen, process: async (f: Float32Array, t: number) => void seen.push({ t, length: f.length, first: f[0]! }) };
}

describe('createVadFeed', () => {
  it('buffers frames from Start and processes them in order, each with its own time, once the detector is ready', async () => {
    const { seen, process } = recorder();
    const feed = createVadFeed({ frameSamples: 512, sampleRateKhz: 16, process });
    // 3 s of 100 ms frames before the model is ready: nothing runs yet.
    for (let i = 0; i < 30; i++) feed.push(frame(1600, i * 100));
    await tick();
    expect(seen).toHaveLength(0);
    expect(feed.pending).toBe(30);

    feed.start();
    await expect.poll(() => seen.length).toBe(Math.floor((30 * 1600) / 512));
    // Frame k starts at k * 32 ms: the backlog keeps the Session clock of the audio, not the time it ran.
    seen.forEach((s, k) => {
      expect(s.t).toBeCloseTo(k * 32, 6);
    });
    expect(seen.every((s) => s.length === 512)).toBe(true);
    expect(seen[0]!.first).toBeCloseTo(0.5);
  });

  it('carries the remainder of a PCM frame into the next one', async () => {
    const { seen, process } = recorder();
    const feed = createVadFeed({ frameSamples: 512, sampleRateKhz: 16, process });
    feed.start();
    feed.push(frame(1600, 1000));
    await expect.poll(() => seen.length).toBe(3);
    // 64 samples (4 ms) are left over; the next frame completes a 512-sample frame starting at 1096 ms.
    feed.push(frame(1600, 1100, -16384));
    await expect.poll(() => seen.length).toBe(6);
    expect(seen.map((s) => s.t)).toEqual([1000, 1032, 1064, 1096, 1128, 1160]);
    expect(seen[3]!.first).toBeCloseTo(0.5);
  });

  it('frames pushed while the backlog drains wait their turn', async () => {
    const order: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const feed = createVadFeed({
      frameSamples: 512,
      sampleRateKhz: 16,
      process: async (_f, t) => {
        if (order.length === 0) await gate;
        order.push(t);
      },
    });
    feed.push(frame(512, 0));
    feed.start();
    feed.push(frame(512, 32));
    feed.push(frame(512, 64));
    release();
    await expect.poll(() => order).toEqual([0, 32, 64]);
  });

  it('stop drops the backlog and ignores later frames', async () => {
    const { seen, process } = recorder();
    const feed = createVadFeed({ frameSamples: 512, sampleRateKhz: 16, process });
    for (let i = 0; i < 5; i++) feed.push(frame(512, i * 32));
    await feed.stop();
    feed.start();
    feed.push(frame(512, 500));
    await tick();
    expect(seen).toHaveLength(0);
    expect(feed.pending).toBe(0);
  });
});

describe('createSpanHold', () => {
  const span = (n: number, t: number) => ({ audio: new Float32Array(n), t });

  it('holds spans until the first listener subscribes, then hands them over oldest first', () => {
    const hold = createSpanHold<ReturnType<typeof span>>(10_000);
    hold.emit(span(100, 0));
    hold.emit(span(100, 1));
    const got: number[] = [];
    hold.subscribe((s) => got.push(s.t));
    expect(got).toEqual([0, 1]);
    hold.emit(span(100, 2));
    expect(got).toEqual([0, 1, 2]);
  });

  it('keeps at most maxSamples of audio, dropping the oldest', () => {
    const hold = createSpanHold<ReturnType<typeof span>>(250);
    for (let i = 0; i < 5; i++) hold.emit(span(100, i));
    const got: number[] = [];
    hold.subscribe((s) => got.push(s.t));
    expect(got).toEqual([3, 4]);
  });
});
