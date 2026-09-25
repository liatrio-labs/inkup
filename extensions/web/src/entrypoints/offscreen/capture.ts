// Mic capture in the offscreen document (ADR 0001, PRD P0-7): one getUserMedia stream feeds the audio
// MediaRecorder (chunks to Dexie every 30s, so a crash loses at most one chunk), the transcription adapter, the
// voice activity detector that gates Voice Commands and segments local Whisper (./voice.ts), and the shared
// 16 kHz PCM16 graph (./pcm.ts) that feeds the detector and the streaming tiers.
//
// E11: the microphone is optional. A Session without one records only the tab video here, until "Turn on voice"
// (voiceOn) opens it. While a comment box dictates (boxDictation), finals go to that box, tagged with its target.

import { toOffset } from '@inkup/core/clock';
import { AUDIO_PATH } from '@inkup/core/session-document';
import type { DictationTarget } from '@inkup/core/timeline';
import fixWebmDuration from 'fix-webm-duration';
import {
  type AdapterConfig,
  createTranscriptionAdapter,
  type TranscriptionAdapter,
  type TranscriptionInfo,
} from '@/adapters/transcription';
import { type AudioMedia, db } from '@/db';
import { getUserMediaWithRetry } from '@/lib/get-user-media';
import { joinChunks } from '@/media/join-chunks';
import { type OffscreenStartConfig, type OffscreenStartResult, sendMessage } from '@/messaging';
import { type PcmGraph, startPcmGraph } from './pcm';
import { pauseTabVideo, startTabVideo, stopTabVideo } from './video';
import { startVoiceCommands, type VoiceCommands } from './voice';

const MIME = 'audio/webm;codecs=opus';

/** The microphone's part of a Session: absent while it has no voice (E11). */
interface Mic {
  stream: MediaStream;
  recorder: MediaRecorder;
  adapter: TranscriptionAdapter;
  startedAt: number;
  chunkSeq: number;
  pendingWrites: Promise<unknown>[];
  transcribing: Promise<void>;
  voice: VoiceCommands;
  /** Feeds the VAD and the streaming tiers. */
  pcm: Promise<PcmGraph>;
  /** Audio leaves the machine (Chrome server speech): recognition stops while paused. */
  remote: boolean;
  /** Whether the adapter was asked to pause (by a pause with remote audio, or a mute). */
  adapterPaused: boolean;
}

interface Running {
  config: OffscreenStartConfig;
  /** Null: a Session without voice (E11), until offscreenVoiceOn. */
  mic: Mic | null;
  paused: boolean;
  /** Mute (E10): Session time the mic went off, or null. */
  mutedAt: number | null;
  /** Muted spans already closed: a segment reaching into one is dropped, whenever the engine delivers it. */
  mutes: { start: number; end: number }[];
  /** The comment box speech goes into (E11), and the Session time it opened; null: speech is the Session's. */
  box: DictationTarget | null;
  boxSince: number;
}

let running: Running | null = null;

const errMsg = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
};

export async function startCapture(config: OffscreenStartConfig): Promise<OffscreenStartResult> {
  if (running) await stopCapture();
  const r: Running = { config, mic: null, paused: false, mutedAt: null, mutes: [], box: null, boxSince: 0 };
  let transcription: TranscriptionInfo | null = null;
  let mic_error: string | undefined;
  if (config.voice) {
    try {
      transcription = await startMic(r, config.transcription);
    } catch (e) {
      // The Session goes on without voice (E11): "Turn on voice" can try again.
      mic_error = errMsg(e);
    }
  }
  running = r;
  const video = config.video_capture_id
    ? await startTabVideo(config.session_id, config.t0, config.video_capture_id)
    : undefined;
  return { ok: true, transcription, ...(mic_error ? { mic_error } : {}), ...(video ? { video } : {}) };
}

/** "Turn on voice" (E11): the microphone from now on, for a Session that started without it. */
export async function voiceOn({
  transcription,
}: {
  transcription: AdapterConfig;
}): Promise<{ ok: true; transcription: TranscriptionInfo } | { ok: false; error: string }> {
  const r = running;
  if (!r) return { ok: false, error: 'No Session is recording.' };
  try {
    return { ok: true, transcription: r.mic ? await r.mic.adapter.describe() : await startMic(r, transcription) };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** Opens the microphone and starts its recorder, transcription and Voice Commands. Throws when it will not open. */
async function startMic(r: Running, transcription: AdapterConfig): Promise<TranscriptionInfo> {
  const { config } = r;
  const stream = await getUserMediaWithRetry(MIC_CONSTRAINTS);
  const now = () => toOffset(config.t0, Date.now());
  const recorder = new MediaRecorder(stream, MediaRecorder.isTypeSupported(MIME) ? { mimeType: MIME } : undefined);
  // The PCM graph starts now, not on first use: the VAD buffers it from Start (./voice.ts).
  const pcm = startPcmGraph(stream, now);
  const voice = startVoiceCommands(stream, pcm, now);
  let m!: Mic;
  const adapter = createTranscriptionAdapter(transcription, {
    now,
    lang: config.lang,
    onFallback: (f) => {
      // The engine changed mid-Session (a paid tier fell back): pause handling and Voice Commands follow it.
      if (f.info && m) {
        m.remote = !f.info.local;
        m.voice.setCaptions(f.info.captions === 'live');
      }
      void sendMessage('transcriptionFallback', { ...f, session_id: config.session_id }).catch(() => {});
    },
    onInterim: (text) => {
      if (r.box) void sendMessage('boxInterim', { target: r.box, text }).catch(() => {});
    },
    pcm: () => pcm,
    speech: voice.speech,
  });
  m = {
    stream,
    recorder,
    adapter,
    startedAt: Date.now(),
    chunkSeq: 0,
    pendingWrites: [],
    transcribing: Promise.resolve(),
    voice,
    pcm,
    remote: false,
    adapterPaused: false,
  };

  recorder.ondataavailable = (e) => {
    if (e.data.size === 0) return;
    const seq = m.chunkSeq++;
    m.pendingWrites.push(
      db.blobs.put({
        id: `${config.session_id}:audio_chunk:${seq}`,
        session_id: config.session_id,
        kind: 'audio_chunk',
        mime: e.data.type || MIME,
        size: e.data.size,
        t: now(),
        seq,
        blob: e.data,
      }),
    );
  };
  // The file's time 0 is when start() is called, as for the tab video (media/tab-video.ts), not when the start event
  // fires: on a loaded machine that comes seconds later, and the audio then plays early against the timeline.
  m.startedAt = Date.now();
  recorder.start(config.chunk_ms);
  // A Session paused before its voice came on records nothing until it resumes.
  if (r.paused) recorder.pause();

  m.transcribing = (async () => {
    try {
      for await (const seg of adapter.start(stream)) {
        // Web Speech stamps a segment when its results arrive, late: judge it by when the VAD heard it said.
        const said = seg.timestamp_quality === 'approximate' && !seg.words?.length ? (voice.spoken(seg) ?? seg) : seg;
        // Dictated into the open comment box (E11): that comment's text, tagged with it, never the Session
        // transcript or a Voice Command. Speech that began before the box opened is the Session's.
        const box = r.box;
        if (box && (said.t + said.t_end) / 2 >= r.boxSince) {
          await sendMessage('transcriptSegment', { segment_id: crypto.randomUUID(), ...seg, target: box });
          continue;
        }
        // Nothing said while muted exists (E10): not logged, not heard as a Voice Command. A final that arrives after
        // the mute but was spoken before it is kept.
        if (inMute(r, said)) continue;
        // While paused nothing is logged; the Voice Command watcher still hears `resume` (segment_id null).
        const segment_id = r.paused ? null : crypto.randomUUID();
        voice.segment({ ...seg, segment_id });
        // Await each hand-off so every segment is in the log before Stop's reply.
        if (segment_id) await sendMessage('transcriptSegment', { segment_id, ...seg });
      }
    } catch (e) {
      await sendMessage('offscreenError', `Transcription stopped: ${errMsg(e)}. Audio is still recording.`).catch(
        () => {},
      );
    }
  })();

  r.mic = m;
  const info = await adapter.describe();
  m.remote = !info.local;
  voice.setCaptions(info.captions === 'live');
  applyMic(r);
  return info;
}

/** Pause (PRD P0-1): the recorder pauses; segments are no longer logged; server recognition stops. */
export function pauseCapture(): void {
  const r = running;
  if (!r || r.paused) return;
  r.paused = true;
  pauseTabVideo(true);
  const m = r.mic;
  if (!m) return;
  m.voice.setPaused(true);
  if (m.recorder.state === 'recording') m.recorder.pause();
  syncAdapter(r);
}

/**
 * Recognition runs unless muted (and not dictating into a comment box), or paused with audio leaving the machine.
 * On-device recognition keeps running through a pause so `resume` can be heard; audio never leaves the machine.
 */
function syncAdapter(r: Running): void {
  const m = r.mic;
  if (!m) return;
  const pause = (r.mutedAt !== null && r.box === null) || (r.paused && m.remote);
  if (pause === m.adapterPaused) return;
  m.adapterPaused = pause;
  if (pause) m.adapter.pause?.();
  else m.adapter.resume?.();
}

function inMute(r: Running, seg: { t: number; t_end: number }): boolean {
  const spans = r.mutedAt === null ? r.mutes : [...r.mutes, { start: r.mutedAt, end: Infinity }];
  return spans.some((m) => seg.t < m.end && seg.t_end > m.start);
}

/**
 * The track, the VAD and recognition follow Mute and comment-box dictation: a box dictates even while muted (E11),
 * and the mic goes off again when it closes. Voice Commands are off while either is on.
 */
function applyMic(r: Running): void {
  const m = r.mic;
  if (!m) return;
  const live = r.mutedAt === null || r.box !== null;
  for (const track of m.stream.getAudioTracks()) track.enabled = live;
  m.voice.setMuted(!live);
  m.voice.setDictating(r.box !== null);
  syncAdapter(r);
}

/**
 * Mute (E10): the track is disabled, so the recorder writes silence and the PCM graph (VAD, streaming engines) hears
 * zeros; recognition pauses and Voice Commands are off. Unmuting undoes it; a pause in between changes nothing.
 */
export function muteCapture(on: boolean): void {
  const r = running;
  if (!r || (r.mutedAt !== null) === on) return;
  const t = toOffset(r.config.t0, Date.now());
  if (on) r.mutedAt = t;
  else {
    r.mutes.push({ start: r.mutedAt!, end: t });
    r.mutedAt = null;
  }
  applyMic(r);
}

/** Comment-box dictation (E11): speech goes into `target`'s box from now on, or (null) back to the Session. */
export function boxDictation(target: DictationTarget | null): void {
  const r = running;
  if (!r) return;
  r.box = target;
  r.boxSince = toOffset(r.config.t0, Date.now());
  applyMic(r);
}

export function resumeCapture(): void {
  const r = running;
  if (!r?.paused) return;
  r.paused = false;
  pauseTabVideo(false);
  const m = r.mic;
  if (!m) return;
  m.voice.setPaused(false);
  if (m.recorder.state === 'paused') m.recorder.resume();
  syncAdapter(r);
}

export async function stopCapture(): Promise<AudioMedia | null> {
  const r = running;
  if (!r) return null;
  running = null;
  // Stop asks for the video first (offscreenVideoStop); this only catches a recorder it never asked about.
  await stopTabVideo();
  const m = r.mic;
  if (!m) return null;
  const stopped = new Promise<void>((resolve) => (m.recorder.onstop = () => resolve()));
  if (m.recorder.state !== 'inactive') m.recorder.stop();
  await stopped; // the final dataavailable fires before stop
  const stoppedAt = Date.now();
  await m.voice.stop();
  m.adapter.stop();
  m.stream.getTracks().forEach((t) => {
    t.stop();
  });
  await m.transcribing;
  await m.pcm.then((g) => g.close()).catch(() => {});
  await Promise.all(m.pendingWrites);
  return finalizeAudio(r.config, m, stoppedAt - m.startedAt);
}

/** Joins the chunks into one WebM with a duration header (Chromium omits it; crbug 40482588), then drops the chunks. */
async function finalizeAudio(config: OffscreenStartConfig, m: Mic, durationMs: number): Promise<AudioMedia | null> {
  const sessionId = config.session_id;
  const chunks = await db.blobs.where('[session_id+kind]').equals([sessionId, 'audio_chunk']).sortBy('seq');
  if (chunks.length === 0) return null;
  const mime = chunks[0]!.mime;
  const joined = await joinChunks(
    chunks.map((c) => c.blob),
    mime,
  );
  const fixed = await fixWebmDuration(joined, durationMs, { logger: false });
  const id = `${sessionId}:audio`;
  await db.transaction('rw', db.blobs, async () => {
    await db.blobs.put({
      id,
      session_id: sessionId,
      kind: 'audio',
      mime,
      size: fixed.size,
      t: toOffset(config.t0, m.startedAt),
      seq: 0,
      blob: fixed,
    });
    await db.blobs.bulkDelete(chunks.map((c) => c.id));
  });
  return {
    blob_id: id,
    mime,
    start_offset_ms: toOffset(config.t0, m.startedAt),
    duration_ms: Math.round(durationMs),
    chunk_count: chunks.length,
    path: AUDIO_PATH,
  };
}
