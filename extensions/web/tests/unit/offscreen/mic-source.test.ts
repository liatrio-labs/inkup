// The microphone input (src/entrypoints/offscreen/mic-source.ts): the constraints for the default and for a chosen
// device, the fall back to the default when the chosen one is gone (never a failed Session), the live switch that
// swaps the graph's source under one stable stream and releases the old device, a device unplugged mid-Session, and
// the raw stream with no switching where the audio graph never runs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GRAPH_GRACE_MS,
  isDeviceGone,
  listMics,
  listMicsIdle,
  micConstraints,
  openDevice,
  openMicSource,
} from '@/entrypoints/offscreen/mic-source';
import { AUDIO_DEVICE_TIMEOUT_MS } from '@/entrypoints/offscreen/pcm';

class FakeTrack extends EventTarget {
  enabled = true;
  readyState: 'live' | 'ended' = 'live';
  constructor(readonly device: string) {
    super();
  }
  stop() {
    this.readyState = 'ended';
  }
  /** The device went away: the browser ends the track itself. */
  unplug() {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}

const streamOf = (device: string) => new FakeStream([new FakeTrack(device)]) as unknown as MediaStream;
const trackOf = (s: MediaStream) => s.getAudioTracks()[0] as unknown as FakeTrack;
const named = (name: string) => Object.assign(new Error(name), { name });

/** getUserMedia over a set of plugged-in devices; the default is "built-in". */
function devices(plugged: string[]) {
  const calls: MediaStreamConstraints[] = [];
  const gum = vi.fn(async (c: MediaStreamConstraints) => {
    calls.push(c);
    const want = ((c.audio as MediaTrackConstraints).deviceId as { exact: string } | undefined)?.exact;
    if (want === undefined) return streamOf('built-in');
    if (!plugged.includes(want)) throw named('OverconstrainedError');
    return streamOf(want);
  });
  return { gum, calls };
}

interface FakeSource {
  stream: MediaStream;
  connectedTo: unknown[];
  connect(n: unknown): unknown;
  disconnect(): void;
}

class FakeContext {
  state: 'running' | 'suspended' = 'running';
  sources: FakeSource[] = [];
  /** What the destination hears, in connection order (a source is removed when it disconnects). */
  feeding: FakeSource[] = [];
  dest = { channelCount: 2, stream: streamOf('graph') };
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  createMediaStreamDestination() {
    return this.dest;
  }
  createMediaStreamSource(stream: MediaStream) {
    const ctx = this;
    const src: FakeSource = {
      stream,
      connectedTo: [],
      connect(n) {
        this.connectedTo.push(n);
        ctx.feeding.push(this);
        return n;
      },
      disconnect() {
        ctx.feeding = ctx.feeding.filter((s) => s !== this);
      },
    };
    this.sources.push(src);
    return src;
  }
}

const ctxOf = (c: FakeContext) => () => c as unknown as AudioContext;

describe('micConstraints', () => {
  it('asks for the default with no deviceId, and for a chosen device exactly', () => {
    expect(micConstraints(null)).toEqual({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    expect(micConstraints('usb-1')).toEqual({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, deviceId: { exact: 'usb-1' } },
    });
  });

  it('treats OverconstrainedError and NotFoundError as a device that is gone, nothing else', () => {
    expect(isDeviceGone(named('OverconstrainedError'))).toBe(true);
    expect(isDeviceGone(named('NotFoundError'))).toBe(true);
    expect(isDeviceGone(named('NotAllowedError'))).toBe(false);
    expect(isDeviceGone(null)).toBe(false);
  });
});

describe('openDevice', () => {
  it('opens the chosen device when it is there', async () => {
    const { gum } = devices(['usb-1']);
    const r = await openDevice('usb-1', { gum });
    expect(r.deviceId).toBe('usb-1');
    expect(trackOf(r.stream).device).toBe('usb-1');
  });

  it.each(['OverconstrainedError', 'NotFoundError'])('falls back to the default on %s, with a warning', async (err) => {
    const gum = vi.fn(async (c: MediaStreamConstraints) => {
      if ((c.audio as MediaTrackConstraints).deviceId) throw named(err);
      return streamOf('built-in');
    });
    const warn = vi.fn();
    const r = await openDevice('gone', { gum, warn });
    expect(r.deviceId).toBeNull();
    expect(trackOf(r.stream).device).toBe('built-in');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain(err);
    expect(gum).toHaveBeenCalledTimes(2);
  });

  it('does not fall back from a real refusal', async () => {
    const gum = vi.fn(async () => {
      throw named('NotAllowedError');
    });
    await expect(openDevice('usb-1', { gum, warn: vi.fn() })).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(gum).toHaveBeenCalledOnce();
  });
});

describe('openMicSource', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives one stable stream from the graph, and switching swaps only the source', async () => {
    const { gum } = devices(['usb-1', 'usb-2']);
    const ctx = new FakeContext();
    const src = await openMicSource('usb-1', { gum, context: ctxOf(ctx), warn: vi.fn() });
    expect(src.live).toBe(true);
    expect(src.stream).toBe(ctx.dest.stream);
    expect(src.device()).toBe('usb-1');
    expect(ctx.dest.channelCount).toBe(1);
    const first = trackOf(ctx.sources[0]!.stream);
    expect(first.device).toBe('usb-1');
    expect(ctx.feeding.map((s) => trackOf(s.stream).device)).toEqual(['usb-1']);

    const stable = src.stream;
    expect(await src.use('usb-2')).toBe('usb-2');
    expect(src.stream).toBe(stable);
    expect(src.device()).toBe('usb-2');
    expect(ctx.feeding.map((s) => trackOf(s.stream).device)).toEqual(['usb-2']);
    // The old device is released; the stable track keeps going.
    expect(first.readyState).toBe('ended');
    expect(trackOf(stable).readyState).toBe('live');

    // Back to the system default.
    expect(await src.use(null)).toBeNull();
    expect(ctx.feeding.map((s) => trackOf(s.stream).device)).toEqual(['built-in']);
  });

  it('starts the graph before it opens the device, and closes it when no device opens', async () => {
    const ctx = new FakeContext();
    ctx.state = 'suspended';
    const order: string[] = [];
    ctx.resume = vi.fn(async () => {
      order.push('resume');
      ctx.state = 'running';
    });
    const gum = vi.fn(async () => {
      order.push('gum');
      throw named('NotAllowedError');
    });
    await expect(openMicSource(null, { gum, context: ctxOf(ctx), warn: vi.fn() })).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
    expect(order).toEqual(['resume', 'gum']);
    expect(ctx.close).toHaveBeenCalledOnce();
  });

  it('hands the PCM graph each new raw device, and keeps Mute across a switch', async () => {
    const { gum } = devices(['usb-1', 'usb-2']);
    const ctx = new FakeContext();
    const src = await openMicSource('usb-1', { gum, context: ctxOf(ctx), warn: vi.fn() });
    expect(trackOf(src.input()).device).toBe('usb-1');
    const inputs: string[] = [];
    src.onInput((s) => inputs.push(trackOf(s).device));

    src.setEnabled(false);
    expect(trackOf(src.stream).enabled).toBe(false);
    expect(trackOf(src.input()).enabled).toBe(false);
    await src.use('usb-2');
    expect(inputs).toEqual(['usb-2']);
    expect(trackOf(src.input()).device).toBe('usb-2');
    // Opened while muted: it carries silence too.
    expect(trackOf(src.input()).enabled).toBe(false);
    src.setEnabled(true);
    expect(trackOf(src.stream).enabled).toBe(true);
    expect(trackOf(src.input()).enabled).toBe(true);
  });

  it('connects the new device before it lets go of the old one', async () => {
    const { gum } = devices(['usb-1', 'usb-2']);
    const ctx = new FakeContext();
    const src = await openMicSource('usb-1', { gum, context: ctxOf(ctx), warn: vi.fn() });
    const old = ctx.sources[0]!;
    const order: string[] = [];
    const disconnect = old.disconnect.bind(old);
    old.disconnect = () => {
      order.push('old off');
      disconnect();
    };
    const create = ctx.createMediaStreamSource.bind(ctx);
    ctx.createMediaStreamSource = (s: MediaStream) => {
      const n = create(s);
      const connect = n.connect.bind(n);
      n.connect = (d: unknown) => {
        order.push('new on');
        return connect(d);
      };
      return n;
    };
    await src.use('usb-2');
    expect(order).toEqual(['new on', 'old off']);
  });

  it('switches to the default when the chosen device is gone, and says so', async () => {
    const { gum } = devices(['usb-1']);
    const ctx = new FakeContext();
    const warn = vi.fn();
    const src = await openMicSource('usb-1', { gum, context: ctxOf(ctx), warn });
    expect(await src.use('unplugged')).toBeNull();
    expect(src.device()).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('keeps the old device when no device opens at all', async () => {
    const { gum } = devices(['usb-1']);
    const ctx = new FakeContext();
    const src = await openMicSource('usb-1', { gum, context: ctxOf(ctx), warn: vi.fn() });
    gum.mockImplementation(async () => {
      throw named('NotReadableError');
    });
    await expect(src.use(null)).rejects.toMatchObject({ name: 'NotReadableError' });
    expect(src.device()).toBe('usb-1');
    expect(trackOf(ctx.sources[0]!.stream).readyState).toBe('live');
  });

  it('opens the default at Start when the remembered device is gone', async () => {
    const { gum, calls } = devices([]);
    const warn = vi.fn();
    const src = await openMicSource('remembered', { gum, context: ctxOf(new FakeContext()), warn });
    expect(src.device()).toBeNull();
    expect(calls).toHaveLength(2);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('goes back to the default when the device in use is unplugged', async () => {
    const { gum } = devices(['usb-1']);
    const ctx = new FakeContext();
    const lost = vi.fn();
    const src = await openMicSource('usb-1', { gum, context: ctxOf(ctx), warn: vi.fn(), onDeviceLost: lost });
    trackOf(ctx.sources[0]!.stream).unplug();
    await vi.waitFor(() => expect(lost).toHaveBeenCalledWith('usb-1'));
    expect(src.device()).toBeNull();
    expect(ctx.feeding.map((s) => trackOf(s.stream).device)).toEqual(['built-in']);
  });

  it('a switch that finishes after a newer one does not replace it', async () => {
    const plugged = devices(['slow', 'fast']);
    let releaseSlow!: () => void;
    const gum = vi.fn(async (c: MediaStreamConstraints) => {
      const want = ((c.audio as MediaTrackConstraints).deviceId as { exact: string } | undefined)?.exact;
      if (want === 'slow') await new Promise<void>((r) => (releaseSlow = r));
      return plugged.gum(c);
    });
    const ctx = new FakeContext();
    const src = await openMicSource(null, { gum, context: ctxOf(ctx), warn: vi.fn() });
    const slow = src.use('slow');
    await vi.waitFor(() => expect(releaseSlow).toBeTypeOf('function'));
    await src.use('fast');
    releaseSlow();
    expect(await slow).toBe('fast');
    expect(src.device()).toBe('fast');
    expect(ctx.feeding.map((s) => trackOf(s.stream).device)).toEqual(['fast']);
    // The slow device that lost the race was opened and released.
    const slowStream = (await gum.mock.results[1]!.value) as MediaStream;
    expect(trackOf(slowStream).device).toBe('slow');
    expect(trackOf(slowStream).readyState).toBe('ended');
  });

  it('closes everything, and does not wait on a stuck context past the timeout', async () => {
    const { gum } = devices(['usb-1']);
    const ctx = new FakeContext();
    ctx.close = vi.fn(() => new Promise<void>(() => {}));
    const src = await openMicSource('usb-1', { gum, context: ctxOf(ctx), warn: vi.fn() });
    let closed = false;
    const done = src.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(AUDIO_DEVICE_TIMEOUT_MS);
    await done;
    expect(closed).toBe(true);
    expect(trackOf(ctx.sources[0]!.stream).readyState).toBe('ended');
    expect(trackOf(src.stream).readyState).toBe('ended');
    await expect(src.use(null)).rejects.toThrow('closed');
  });

  it('hands out the raw stream, and cannot switch, where the graph never runs', async () => {
    const { gum } = devices(['usb-1']);
    const ctx = new FakeContext();
    ctx.state = 'suspended';
    ctx.resume = vi.fn(() => new Promise<void>(() => {}));
    let opened = false;
    const opening = openMicSource('usb-1', { gum, context: ctxOf(ctx), warn: vi.fn() }).then((s) => {
      opened = true;
      return s;
    });
    // Start is held up GRAPH_GRACE_MS at most, not the whole audio-device bound.
    await vi.advanceTimersByTimeAsync(GRAPH_GRACE_MS - 1);
    expect(opened).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(opened).toBe(true);
    const src = await opening;
    expect(src.live).toBe(false);
    expect(trackOf(src.stream).device).toBe('usb-1');
    expect(src.device()).toBe('usb-1');
    expect(ctx.sources).toHaveLength(0);
    await expect(src.use(null)).rejects.toThrow('cannot switch');
    await src.close();
    expect(trackOf(src.stream).readyState).toBe('ended');
  });
});

describe('listMics', () => {
  it("lists the audio inputs by label, without Chrome's default and communications aliases", async () => {
    const md = {
      enumerateDevices: async () =>
        [
          { kind: 'audioinput', deviceId: 'default', label: 'Default - Built-in' },
          { kind: 'audioinput', deviceId: 'communications', label: 'Communications - Built-in' },
          { kind: 'audioinput', deviceId: 'a', label: 'Built-in Microphone' },
          { kind: 'videoinput', deviceId: 'cam', label: 'Camera' },
          { kind: 'audiooutput', deviceId: 'spk', label: 'Speakers' },
          { kind: 'audioinput', deviceId: 'b', label: '' },
        ] as MediaDeviceInfo[],
    };
    expect(await listMics(md)).toEqual([
      { id: 'a', label: 'Built-in Microphone' },
      { id: 'b', label: 'Microphone 2' },
    ]);
  });
});

describe('listMicsIdle', () => {
  it('lists at once where the inputs are named', async () => {
    const gum = vi.fn();
    const md = {
      enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'a', label: 'USB' }] as MediaDeviceInfo[],
    };
    expect(await listMicsIdle(md, gum)).toEqual([{ id: 'a', label: 'USB' }]);
    expect(gum).not.toHaveBeenCalled();
  });

  it('opens the default for as long as the list takes where the inputs are hidden, then releases it', async () => {
    let open = false;
    const stream = streamOf('built-in');
    const gum = vi.fn(async () => {
      open = true;
      return stream;
    });
    const md = {
      enumerateDevices: async () =>
        (open
          ? [{ kind: 'audioinput', deviceId: 'a', label: 'USB' }]
          : [{ kind: 'audioinput', deviceId: '', label: '' }]) as MediaDeviceInfo[],
    };
    expect(await listMicsIdle(md, gum)).toEqual([{ id: 'a', label: 'USB' }]);
    expect(gum).toHaveBeenCalledOnce();
    expect(trackOf(stream).readyState).toBe('ended');
  });
});
