// The microphone input in the media context (ADR 0001). The chosen device (null: the system default) opens raw, into a
// Web Audio graph whose MediaStreamAudioDestinationNode track is the Session's mic stream: the recorder and the
// transcription adapter (Web Speech's `start(track)`) hold that track, so choosing another device mid-Session only
// swaps the graph's source node. Nothing restarts and the audio file is not split.
//
// The 16 kHz PCM graph (./pcm.ts, for the VAD and the streaming tiers) is another AudioContext, and a track carried
// from one context to another arrives in gaps (its worklet saw about two thirds of the frames on CI). So it reads the
// raw device stream in its own context instead (`input`), and swaps its own source node when `onInput` says the device
// changed. Mute (`setEnabled`) disables both the stable track and the raw one, including a raw one opened later.
//
// A remembered device that is gone (OverconstrainedError or NotFoundError on `deviceId: { exact }`) opens the default
// instead, with a warning: the choice never fails a Session. A device unplugged mid-Session ends its track; the source
// then goes back to the default the same way.
//
// With no working audio output (Firefox on a Linux box with no sound server, ./pcm.ts) the graph's context never
// runs, and a stream it made would be silent. A context still not running GRAPH_GRACE_MS after the device opened is
// given up on, so Start is never held for the 2 s audio-device bound. The source then hands out the raw device stream,
// as before this existed, and cannot switch (`live` false): the toolbar hides the picker rather than offer a switch
// that would do nothing.
import { withTimeout } from '@inkup/core/overlay-lifetime';
import { getUserMediaWithRetry } from '@/lib/get-user-media';
import { AUDIO_DEVICE_TIMEOUT_MS } from './pcm';

/** An audio input as the media context's origin sees it (its deviceIds are not the page's). */
export interface MicDevice {
  id: string;
  label: string;
}

export interface MicSource {
  /** The Session's mic stream: stable for the life of the source, whichever device feeds it. */
  readonly stream: MediaStream;
  /** The device feeding it now; null: the system default. */
  device(): string | null;
  /** Whether `use` can switch the device live (the graph runs). */
  readonly live: boolean;
  /** The raw stream of the device feeding it now (the PCM graph reads this, in its own context). */
  input(): MediaStream;
  /** Calls `listener` with the new raw stream after each switch. Returns the unsubscribe. */
  onInput(listener: (input: MediaStream) => void): () => void;
  /** Mute: the stable track and the raw one off (they carry silence), or back on. Holds across switches. */
  setEnabled(on: boolean): void;
  /**
   * Feeds the stream from `deviceId` (null: the system default) from now on, and releases the old device. A device
   * that is gone gives the default. Resolves with the device now feeding it. Rejects (keeping the old device) when no
   * device opens at all, or when the source is not live.
   */
  use(deviceId: string | null): Promise<string | null>;
  /** Stops every track and closes the graph; never waits on the audio device longer than AUDIO_DEVICE_TIMEOUT_MS. */
  close(): Promise<void>;
}

export interface MicSourceDeps {
  gum?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  /** The graph's context; tests pass a fake. */
  context?: () => AudioContext;
  warn?: (message: string) => void;
  /** The device the source fed went away by itself (unplugged) and the default took over. */
  onDeviceLost?: (lost: string) => void;
}

/** How long after the device opens a graph context that is not running yet is waited for. */
export const GRAPH_GRACE_MS = 250;

const BASE_AUDIO: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true };

/** The getUserMedia constraints for a device: the default (no deviceId), or exactly the one chosen. */
export function micConstraints(deviceId: string | null): MediaStreamConstraints {
  return { audio: deviceId ? { ...BASE_AUDIO, deviceId: { exact: deviceId } } : { ...BASE_AUDIO } };
}

/** The answers that mean "that device is not here (any more)": the default is opened instead. */
export function isDeviceGone(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'OverconstrainedError' || name === 'NotFoundError';
}

const defaultWarn = (message: string) => console.warn(`[var] ${message}`);

/**
 * Opens `deviceId` raw, or the default when that device is gone. Resolves with the stream and the device it came from
 * (null: the default). Other errors (NotAllowedError, ...) are real answers and reject.
 */
export async function openDevice(
  deviceId: string | null,
  deps: Pick<MicSourceDeps, 'gum' | 'warn'> = {},
): Promise<{ stream: MediaStream; deviceId: string | null }> {
  const gum = deps.gum ? { gum: deps.gum } : {};
  if (deviceId) {
    try {
      return { stream: await getUserMediaWithRetry(micConstraints(deviceId), gum), deviceId };
    } catch (e) {
      if (!isDeviceGone(e)) throw e;
      (deps.warn ?? defaultWarn)(
        `the chosen microphone is not available (${(e as { name: string }).name}); using the system default`,
      );
    }
  }
  return { stream: await getUserMediaWithRetry(micConstraints(null), gum), deviceId: null };
}

const stopAll = (s: MediaStream) => {
  for (const t of s.getTracks()) t.stop();
};

/** Opens the microphone (`deviceId`, or the default) as a MicSource. Rejects when no microphone opens. */
export async function openMicSource(deviceId: string | null, deps: MicSourceDeps = {}): Promise<MicSource> {
  const warn = deps.warn ?? defaultWarn;
  // The graph's context resumes while the device opens. Once the device is open the caller starts the recorder and the
  // engine at once, as it did before this graph existed, so a context still not running GRAPH_GRACE_MS later is given
  // up on (the raw stream, below) instead of holding up Start for the full audio-device bound.
  let ctx: AudioContext | null = null;
  let resumed: Promise<unknown> = Promise.resolve();
  try {
    ctx = deps.context ? deps.context() : new AudioContext();
    if (ctx.state !== 'running') resumed = ctx.resume().catch(() => {});
  } catch (e) {
    warn(`no audio graph for the microphone (${e instanceof Error ? e.message : String(e)})`);
  }
  let first: Awaited<ReturnType<typeof openDevice>>;
  try {
    first = await openDevice(deviceId, { ...deps, warn });
  } catch (e) {
    if (ctx) void withTimeout(ctx.close(), AUDIO_DEVICE_TIMEOUT_MS, undefined).catch(() => {});
    throw e;
  }
  if (ctx && ctx.state !== 'running') await withTimeout(resumed, GRAPH_GRACE_MS, undefined);
  let raw = first.stream;
  let current = first.deviceId;

  if (ctx?.state !== 'running') {
    // No graph that runs: the raw stream, as before, and no live switching.
    if (ctx) void withTimeout(ctx.close(), AUDIO_DEVICE_TIMEOUT_MS, undefined).catch(() => {});
    return {
      stream: raw,
      device: () => current,
      live: false,
      input: () => raw,
      onInput: () => () => {},
      setEnabled(on) {
        for (const t of raw.getAudioTracks()) t.enabled = on;
      },
      use: () => Promise.reject(new Error('This browser cannot switch the microphone during a Session.')),
      async close() {
        stopAll(raw);
      },
    };
  }

  const graph = ctx;
  const dest = graph.createMediaStreamDestination();
  dest.channelCount = 1;
  let source = graph.createMediaStreamSource(raw);
  source.connect(dest);
  let closed = false;
  let enabled = true;
  const inputListeners = new Set<(input: MediaStream) => void>();
  /** Counts switches, so an older one that finishes late does not replace a newer one. */
  let generation = 0;

  const watch = (stream: MediaStream, gen: number) => {
    for (const t of stream.getAudioTracks())
      t.addEventListener('ended', () => {
        if (closed || gen !== generation || current === null) return;
        const lost = current;
        warn('the microphone in use went away; using the system default');
        void self
          .use(null)
          .then(() => deps.onDeviceLost?.(lost))
          .catch((e: unknown) => warn(`no microphone after the one in use went away (${String(e)})`));
      });
  };
  watch(raw, generation);

  const self: MicSource = {
    stream: dest.stream,
    device: () => current,
    live: true,
    input: () => raw,
    onInput(listener) {
      inputListeners.add(listener);
      return () => inputListeners.delete(listener);
    },
    setEnabled(on) {
      enabled = on;
      for (const t of [...dest.stream.getAudioTracks(), ...raw.getAudioTracks()]) t.enabled = on;
    },
    async use(next) {
      if (closed) throw new Error('The microphone is closed.');
      const gen = ++generation;
      const opened = await openDevice(next, { ...deps, warn });
      if (closed || gen !== generation) {
        stopAll(opened.stream);
        if (closed) throw new Error('The microphone is closed.');
        return current;
      }
      for (const t of opened.stream.getAudioTracks()) t.enabled = enabled;
      const nextSource = graph.createMediaStreamSource(opened.stream);
      // Connect the new source before dropping the old one: the destination never runs dry in between.
      nextSource.connect(dest);
      source.disconnect();
      stopAll(raw);
      source = nextSource;
      raw = opened.stream;
      current = opened.deviceId;
      watch(raw, gen);
      for (const l of inputListeners) l(raw);
      return current;
    },
    async close() {
      closed = true;
      source.disconnect();
      stopAll(raw);
      stopAll(dest.stream);
      await withTimeout(graph.close(), AUDIO_DEVICE_TIMEOUT_MS, undefined).catch(() => {});
    },
  };
  return self;
}

const toMics = (all: MediaDeviceInfo[]): MicDevice[] =>
  all
    // Chrome's "default" and "communications" entries alias a real device; "System default" stands for them.
    .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));

/** The audio inputs this context can open, by label (a placeholder where the label is hidden without the grant). */
export async function listMics(
  md: Pick<MediaDevices, 'enumerateDevices'> = navigator.mediaDevices,
): Promise<MicDevice[]> {
  return toMics(await md.enumerateDevices());
}

/**
 * The inputs before a Session, when nothing holds the microphone. A document that has not used the microphone gets the
 * inputs without their deviceIds and labels where the grant was not kept for the extension (Chromium with fake
 * devices, a grant for this session only): the default then opens for as long as the list takes, and closes again.
 */
export async function listMicsIdle(
  md: Pick<MediaDevices, 'enumerateDevices'> = navigator.mediaDevices,
  gum?: (c: MediaStreamConstraints) => Promise<MediaStream>,
): Promise<MicDevice[]> {
  const all = await md.enumerateDevices();
  if (!all.some((d) => d.kind === 'audioinput' && (!d.deviceId || !d.label))) return toMics(all);
  const open = await getUserMediaWithRetry(micConstraints(null), gum ? { gum } : {}).catch(() => null);
  if (!open) return toMics(all);
  try {
    return toMics(await md.enumerateDevices());
  } finally {
    stopAll(open);
  }
}
