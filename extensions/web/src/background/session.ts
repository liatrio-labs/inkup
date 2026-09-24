// Session ownership (ADR 0001): the service worker holds t0, the bound tab and the event log. State lives in
// storage.session so a restarted worker picks it up; the panel watches the same item. Recording inputs
// (Strokes, Annotations, clicks, navigation, speech) are in ./capture.ts; Voice Commands in ./voice.ts.
import { toOffset } from '@inkup/core/clock';
import type { DictationTarget } from '@inkup/core/timeline';
import { fallbackTarget } from '@/adapters/transcription/streaming';
import { db } from '@/db';
import { queueBlobs } from '@/db/outbox';
import {
  type ContentSessionState,
  type ContentSignal,
  type StartResult,
  type StartVideo,
  sendMessage,
  type VideoStatusInput,
} from '@/messaging';
import { platform } from '@/platform';
import { activeSession, panelNotice } from '@/session-state';
import {
  type ActiveSession,
  captureSettings,
  clampFade,
  devOverrides,
  micGranted,
  providerKey,
  readProcessingSettings,
  type SelectMode,
} from '@/settings';
import { salvageAudio } from './audio';
import { appendEvent } from './event-log';
import { type ModeRequest, modesOf, nextModes } from './modes';
import { flushPanelVideo } from './panel-port';
import { openReview } from './review-tab';
import { sweepUnusedScreenshots } from './screenshots';
import { pickTargetTab, targetTab } from './target-tab';
import { transcriptionForStart } from './transcription';
import { finalizeVideo, startOffset } from './video';

const AUDIO_CHUNK_MS = 30_000;
type EndReason = 'stop' | 'panel_closed' | 'tab_closed' | 'shortcut';

let stopping: Promise<{ ok: boolean; session_id: string | null }> | null = null;

export const getActive = () => activeSession.getValue();

// Several handlers change the active Session at once (a navigation, a tab switch, the VAD status). Every change
// goes through one chain so none overwrites another.
let patching: Promise<unknown> = Promise.resolve();
export function patchActive(change: (s: ActiveSession) => ActiveSession | null): Promise<ActiveSession | null> {
  const run = patching.then(async () => {
    const s = await getActive();
    if (!s) return null;
    const next = change(s);
    if (next && next !== s) await activeSession.setValue(next);
    return next ?? s;
  });
  patching = run.catch(() => {});
  return run;
}

/** The active Session if `tabId` is its tab, it is not stopping and (unless allowed) not paused. */
export async function activeFor(
  tabId: number | undefined,
  { whilePaused = false } = {},
): Promise<ActiveSession | null> {
  const s = await getActive();
  if (!s || s.tab_id !== tabId || s.stopping) return null;
  return s.paused && !whilePaused ? null : s;
}

export const offsetOf = (s: ActiveSession) => toOffset(s.t0, Date.now());

async function contentStateFor(s: ActiveSession | null): Promise<ContentSessionState | null> {
  if (!s || s.stopping) return null;
  const { fadeMs, boxDictation } = await captureSettings.getValue();
  return {
    session_id: s.id,
    t0: s.t0,
    draw_mode: s.draw_mode,
    select_mode: s.select_mode ?? null,
    fade_ms: clampFade(fadeMs),
    paused: s.paused !== null,
    muted: !!s.muted,
    voice: s.voice !== false,
    box_dictation: s.captions === 'live' ? (boxDictation ?? 'auto') : null,
  };
}

/**
 * Sends the page the Session `s` stands for as it is now (null, or ended since: none). Read at the send, so a push
 * prepared before a newer change (a mode switched while the media started) does not undo it.
 */
export async function notifyContent(tabId: number, s: ActiveSession | null): Promise<boolean> {
  const latest = s && (await getActive());
  const state = s && latest?.id === s.id ? latest : null;
  try {
    await sendMessage('contentState', await contentStateFor(state), tabId);
    return true;
  } catch {
    // No content script in the tab (e.g. a page loaded before install, or chrome:// pages). It asks on load.
    return false;
  }
}

/** Asks the Session tab to close its open Annotation; resolves once it is recorded (or after 4 s). */
export async function signalContent(s: ActiveSession, signal: ContentSignal): Promise<void> {
  await Promise.race([
    sendMessage('contentSignal', signal, s.tab_id).catch(() => {}),
    new Promise((r) => setTimeout(r, 4000)),
  ]);
}

export interface StartOptions {
  /** Record this tab (the page toolbar's or the shortcut's), not the focused window's active tab. */
  tabId?: number;
  /** Chrome: the media context records the tab's video through tabCapture (docs/spikes/toolbar-start.md). */
  tabCapture?: boolean;
  /** Chrome refused tabCapture (the tab was not invoked): the toolbar offers the picker window instead (./picker.ts). */
  onNoTabCapture?: (s: ActiveSession) => unknown;
}

/** How long Start waits for the page to take the Session before it says Recording anyway. */
const PAGE_ACK_MS = 3000;

/** The media half of the Start in progress: Stop waits for it, so it never stops a recorder that is still opening. */
let startingMedia: Promise<StartResult> | null = null;

/** Pause, Mute, Turn on voice and box dictation talk to the media context: once it has started, not before. */
const mediaStarted = async () => void (await startingMedia?.catch(() => {}));

/**
 * Start (F1): the Session is written and pushed to the page before anything slow, so the page's modes and shortcuts
 * answer from the moment the toolbar says Recording. Until the page has acknowledged it the Session is `starting`
 * and the toolbar says "Starting…". Only then come the slow steps: the tab's capture id, the media context, the
 * microphone, the transcription engine and the recorders.
 */
export async function startSession(
  video: StartVideo = { state: 'off', reason: 'unavailable' },
  clickedAt: number | null = null,
  opts: StartOptions = {},
): Promise<StartResult> {
  if (await getActive()) return { ok: false, code: 'already_recording', error: 'A Session is already recording.' };
  // Without a microphone grant the Session has no voice (E11): ink, picks, typed comments, screenshots and video.
  const voice = await micGranted.getValue();
  const target = opts.tabId === undefined ? await pickTargetTab() : await targetTab(opts.tabId);
  if (!target.ok) return { ok: false, code: 'no_tab', error: target.error };
  const { tab, mode } = target;
  if (opts.tabCapture)
    video = { state: 'recording', label: tab.title || tab.url || 'this tab', width: null, height: null };

  const t0 = Date.now();
  const id = crypto.randomUUID();
  const drafts = {
    enabled: !!(await providerKey((await readProcessingSettings()).draft.provider)),
    running: false,
    note: null,
  };
  await db.sessions.add({
    id,
    tab_id: tab.id,
    t0,
    started_at: new Date(t0).toISOString(),
    ended_at: null,
    duration_ms: null,
    start_url: tab.url ?? '',
    start_title: tab.title ?? '',
    status: 'recording',
    transcription: null,
    audio: null,
    video: null,
    video_off_reason: video.state === 'off' ? video.reason : null,
    media_deleted_at: null,
  });
  await appendEvent(id, {
    type: 'session_start',
    t: 0,
    tab_id: tab.id,
    url: tab.url ?? '',
    title: tab.title ?? '',
    t0,
    clicked_at: clickedAt,
    overlay: mode === 'no_overlay' ? 'none' : 'page',
    voice,
  });
  // Written before the media context starts, so its early messages (VAD status, speech) find the Session.
  const session: ActiveSession = {
    id,
    tab_id: tab.id,
    window_id: tab.windowId,
    t0,
    tab_title: tab.title ?? '',
    tab_url: tab.url ?? '',
    draw_mode: false,
    select_mode: null,
    mode,
    transcription: null,
    captions: 'live',
    starting: true,
    stopping: false,
    paused: null,
    muted: null,
    voice,
    paused_ms: 0,
    away: null,
    commands: 'loading',
    commands_note: null,
    last_url: tab.url ?? '',
    video:
      video.state === 'off'
        ? video
        : {
            state: 'recording',
            label: video.label,
            start_offset_ms: null,
            mime: null,
            width: video.width,
            height: video.height,
            recorder: opts.tabCapture ? 'media_context' : 'surface',
          },
    drafts,
  };
  await activeSession.setValue(session);

  // 1. The page gets the Session, and says so; only then does the toolbar say Recording.
  await Promise.race([notifyContent(tab.id, session), new Promise((r) => setTimeout(r, PAGE_ACK_MS))]);
  await patchActive((s) => (s.id === id ? { ...s, starting: false } : s));

  // 2. The slow steps. Stop waits for them (doStop).
  const media = startMedia(session, !!opts.tabCapture, opts.onNoTabCapture);
  startingMedia = media;
  try {
    return await media;
  } finally {
    if (startingMedia === media) startingMedia = null;
  }
}

async function startMedia(
  session: ActiveSession,
  tabCapture: boolean,
  onNoTabCapture?: StartOptions['onNoTabCapture'],
): Promise<StartResult> {
  const { id, t0, tab_id: tabId, voice = true } = session;
  let captureId: string | undefined;
  if (tabCapture) {
    captureId = await platform.tabVideo.captureId?.(tabId).catch((e: unknown) => {
      console.info('no tab video for this Start:', e instanceof Error ? e.message : e);
      return undefined;
    });
    if (!captureId) {
      await db.sessions.update(id, { video_off_reason: 'unavailable' });
      const off = await patchActive((s) =>
        s.id === id ? { ...s, video: { state: 'off', reason: 'unavailable' } } : s,
      );
      // Not awaited: the microphone and the engine start while the reviewer reads the picker window.
      if (off?.id === id && !off.stopping) void Promise.resolve(onNoTabCapture?.(off)).catch(console.warn);
    }
  }
  const dev = await devOverrides.getValue();
  const start = await transcriptionForStart();
  await platform.mediaContext.ensure();
  const started = await sendMessage('offscreenStart', {
    session_id: id,
    t0,
    lang: navigator.language || 'en-US',
    chunk_ms: audioChunkMs(dev),
    transcription: start.config,
    voice,
    ...(captureId ? { video_capture_id: captureId } : {}),
  }).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
  if (!started.ok) {
    // Nothing was captured: drop the half-started Session rather than leave an empty one behind. A Stop pressed
    // meanwhile finishes it instead, without media.
    if ((await getActive())?.stopping)
      return { ok: false, code: 'mic_failed', error: `Could not start recording: ${started.error}` };
    await activeSession.setValue(null);
    await notifyContent(tabId, null);
    await db.transaction('rw', db.sessions, db.events, db.blobs, async () => {
      await db.sessions.delete(id);
      await db.events.where('session_id').equals(id).delete();
      await db.blobs.where('session_id').equals(id).delete();
    });
    await platform.mediaContext.close().catch(() => {});
    return { ok: false, code: 'mic_failed', error: `Could not start recording: ${started.error}` };
  }
  // The microphone would not open: the Session goes on without voice (E11), and says why.
  const heard = started.transcription;
  if (voice && !heard) {
    await appendEvent(id, {
      type: 'transcription_fallback',
      t: offsetOf(session),
      from: start.config.adapter,
      to: 'none',
      reason: `The microphone did not open (${started.mic_error ?? 'unknown error'}); recording without voice.`,
    });
    await panelNotice.setValue(
      `Recording without voice: the microphone did not open (${started.mic_error ?? 'unknown error'}).`,
    );
  }
  const transcription = heard
    ? { engine: heard.engine, local: heard.local, timestamp_quality: heard.timestamp_quality }
    : null;
  const tabVideo = started.video;
  await db.sessions.update(id, {
    transcription,
    ...(tabVideo && !tabVideo.ok ? { video_off_reason: 'failed' as const } : {}),
  });
  if (tabVideo && !tabVideo.ok) console.warn('tab video did not start', tabVideo.error);
  // The chosen engine could not start at all (a paid tier with no key, a Whisper model not downloaded).
  if (heard && start.notice)
    await appendEvent(id, {
      type: 'transcription_fallback',
      t: offsetOf(session),
      ...start.notice,
      to: fallbackTarget(heard),
    });
  const live = (await patchActive((s) =>
    s.id !== id
      ? s
      : {
          ...s,
          transcription,
          captions: heard ? heard.captions : 'unavailable',
          voice: !!heard,
          ...(!heard ? { commands: 'unavailable' as const, commands_note: 'Voice Commands need the microphone.' } : {}),
          ...(tabVideo && s.video.state !== 'off'
            ? {
                video: tabVideo.ok
                  ? { ...s.video, width: tabVideo.width, height: tabVideo.height }
                  : { state: 'off' as const, reason: 'failed' as const },
              }
            : {}),
          ...(heard?.captions === 'unavailable'
            ? { commands: 'unavailable' as const, commands_note: 'Voice Commands need live captions.' }
            : {}),
        },
  ))!;
  if (!voice || heard) await panelNotice.setValue(null);
  // The page learns what the media decided (box dictation needs live captions); a Stop meanwhile has its own say.
  if (!live.stopping) await notifyContent(tabId, live);
  return { ok: true, session: live };
}

/**
 * `discard` (Cancel, ./discard.ts): the page's ink goes at once, and the Session is left for ./discard.ts to delete
 * or, on Undo, to finish as a Stop does: no media is queued for the Host and no review page opens here.
 */
export function stopSession(
  reason: EndReason = 'stop',
  { discard = false } = {},
): Promise<{ ok: boolean; session_id: string | null }> {
  stopping ??= doStop(reason, discard).finally(() => (stopping = null));
  return stopping;
}

/** The Stop in progress, if any: Undo of a Cancel waits for its media before queueing them. */
export const stopInProgress = () => stopping;

const audioChunkMs = (dev: { audioChunkMs?: number } | null | undefined) =>
  dev?.audioChunkMs ?? platform.mediaContext.audioChunkMs ?? AUDIO_CHUNK_MS;

/** The Session whose media context the user closed (Safari's recorder window, #9): its Stop joins the audio itself. */
let mediaContextGone: string | null = null;

/**
 * The user closed the media context (Safari's recorder window) mid-Session. The microphone went with it, so that is
 * Stop, as closing the panel is in Chrome (ADR 0001). The timeline has no end reason of its own for it: the recorder
 * window is Safari's half of what the panel is in Chrome, so it ends as `panel_closed`.
 */
export async function onMediaContextGone(): Promise<void> {
  const s = await getActive();
  if (!s) return;
  mediaContextGone = s.id;
  if (!s.stopping) await stopSession('panel_closed');
}

async function doStop(reason: EndReason, discard: boolean) {
  let s = await patchActive((a) => ({ ...a, stopping: true, draw_mode: false, select_mode: null }));
  if (!s) return { ok: false, session_id: null };
  // A Stop pressed while the microphone and recorders were still opening waits for them (F1).
  if (startingMedia) {
    await startingMedia.catch(() => {});
    s = await getActive();
    if (!s) return { ok: false, session_id: null };
  }
  // A paused Session ends at the pause: close the gap so the timeline is balanced.
  if (s.paused)
    await appendEvent(s.id, {
      type: 'session_resume',
      t: offsetOf(s),
      gap_ms: Math.max(0, offsetOf(s) - s.paused.t),
      via: 'button',
    });

  // 1. Let the page close its open Annotation (and screenshot it) while the Strokes are still on screen.
  if (reason !== 'tab_closed') {
    await Promise.race([
      sendMessage('contentFlush', undefined, s.tab_id).catch(() => {}),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
    // Cancel clears the page now; a Stop leaves the ink until the media are done.
    if (discard) await notifyContent(s.tab_id, null);
  }
  // 2. Finalize the video: the panel (or the toolbar frame) writes its last chunk, unless it was closed, which is how
  // we got here; a tabCapture recording in the media context stops before the audio does.
  const inMediaContext = s.video.state !== 'off' && s.video.recorder === 'media_context';
  const mediaVideoEnd = inMediaContext
    ? await Promise.race([
        sendMessage('offscreenVideoStop').catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 8000)),
      ])
    : null;
  const videoDone = (async () => {
    if (s.video.state === 'off') return null;
    const { stopped_at } = inMediaContext
      ? { stopped_at: mediaVideoEnd?.stopped_at ?? Date.now() }
      : await flushPanelVideo(s.id);
    return finalizeVideo(s.id, s.t0, s.video, stopped_at).catch((e: unknown) => {
      console.warn('finalizeVideo failed', e);
      return null;
    });
  })();
  // 3. Finalize audio; the offscreen document sends its last transcript segments before replying. A media context the
  // user closed cannot: the chunks it wrote are joined here.
  const gone = () => mediaContextGone === s.id;
  let audio = gone()
    ? null
    : await Promise.race([
        sendMessage('offscreenStop').catch((e: unknown) => {
          console.warn('offscreenStop failed', e);
          return null;
        }),
        new Promise<null>((r) => setTimeout(() => r(null), 15_000)),
      ]);
  if (!audio && gone()) {
    audio = await salvageAudio(s.id, audioChunkMs(await devOverrides.getValue())).catch((e: unknown) => {
      console.warn('could not join the audio of a closed recorder', e);
      return null;
    });
  }
  // A backstop, like the audio's: Stop always finishes, without the video if it cannot be assembled.
  const video = await Promise.race([videoDone, new Promise<null>((r) => setTimeout(() => r(null), 30_000))]);
  const end = Date.now();
  const duration = toOffset(s.t0, end);
  await appendEvent(s.id, { type: 'session_end', t: duration, reason, duration_ms: duration });
  await db.sessions.update(s.id, {
    status: 'ended',
    ended_at: new Date(end).toISOString(),
    duration_ms: duration,
    audio,
    video,
    ...(s.video.state !== 'off' && !video ? { video_off_reason: 'failed' as const } : {}),
  });
  await activeSession.setValue(null);
  if (reason !== 'tab_closed') await notifyContent(s.tab_id, null);
  await platform.mediaContext.close().catch(() => {});
  if (discard) return { ok: true, session_id: s.id };
  await finishStopped(s.id, s.window_id);
  return { ok: true, session_id: s.id };
}

/** What Stop does once the Session is saved: its media go to a paired Host, and its review page opens. */
export async function finishStopped(sessionId: string, windowId: number): Promise<void> {
  // Screenshots taken for an Annotation that was never recorded (#22).
  await sweepUnusedScreenshots(sessionId).catch((e: unknown) => console.warn('screenshot sweep failed', e));
  const row = await db.sessions.get(sessionId);
  // Audio and video go to a paired Host once, whole, at Stop.
  await queueBlobs(sessionId, [row?.audio?.blob_id, row?.video?.blob_id]);
  await openReview(sessionId, windowId);
}

/** Draw, Object Select and Select Text: one at a time (./modes.ts). The page and the toolbar hear the change. */
export async function setModes(request: ModeRequest): Promise<ActiveSession | null> {
  // No overlay runs on a 'no_overlay' page: there is nothing to draw on or pick.
  const s = await patchActive((a) =>
    a.stopping || a.paused || a.mode === 'no_overlay' ? a : { ...a, ...nextModes(modesOf(a), request) },
  );
  if (s && !s.stopping) await notifyContent(s.tab_id, s);
  return s;
}

export const setDrawMode = (on: boolean) => setModes({ draw: on });
export const setSelectMode = (mode: SelectMode | null) => setModes({ select: mode });
export const clearModes = () => setModes('none');

/**
 * Pause (PRD P0-1): closes the open Annotation, pauses the audio recorder and transcription, stops capturing
 * page events, and logs `session_pause`. The Voice Command watcher keeps listening for `resume`.
 */
export async function pauseSession(via: 'button' | 'voice'): Promise<ActiveSession | null> {
  await mediaStarted();
  const s = await getActive();
  if (!s || s.stopping || s.paused) return s;
  const t = offsetOf(s);
  await signalContent(s, { reason: 'pause', t });
  await sendMessage('offscreenPause').catch(() => {});
  await appendEvent(s.id, { type: 'session_pause', t, via });
  const next = await patchActive((a) => ({
    ...a,
    paused: { t, at: Date.now(), via },
    draw_mode: false,
    select_mode: null,
  }));
  if (next) await notifyContent(next.tab_id, next);
  return next;
}

export async function resumeSession(via: 'button' | 'voice'): Promise<ActiveSession | null> {
  await mediaStarted();
  const s = await getActive();
  if (!s || s.stopping || !s.paused) return s;
  const t = offsetOf(s);
  await sendMessage('offscreenResume').catch(() => {});
  const gap = Math.max(0, t - s.paused.t);
  await appendEvent(s.id, { type: 'session_resume', t, gap_ms: gap, via });
  const next = await patchActive((a) => ({ ...a, paused: null, paused_ms: (a.paused_ms ?? 0) + gap }));
  if (next) await notifyContent(next.tab_id, next);
  return next;
}

/**
 * Mute (E10): the mic track goes off, so the audio file records silence there, and transcription, the VAD and Voice
 * Commands hear nothing; video, ink, picks and screenshots go on. Logged as `mic_muted` / `mic_unmuted`. Independent
 * of Pause: a muted Session stays muted through a pause and its resume.
 */
export async function setMuted(on: boolean, via: 'button' | 'shortcut'): Promise<ActiveSession | null> {
  await mediaStarted();
  const s = await getActive();
  if (!s || s.stopping || s.voice === false || !!s.muted === on) return s;
  const t = offsetOf(s);
  await sendMessage('offscreenMute', on).catch(() => {});
  await appendEvent(s.id, { type: on ? 'mic_muted' : 'mic_unmuted', t, via });
  const next = await patchActive((a) => ({ ...a, muted: on ? { t, at: Date.now() } : null }));
  if (next) await notifyContent(next.tab_id, next);
  return next;
}

/**
 * "Turn on voice" (E11): a Session started without the microphone gets it from now on (`voice_on`). The grant has to
 * come from a visible extension page, so without one setup opens, and the grant turns voice on (onMicGranted).
 */
export async function turnOnVoice(): Promise<{ ok: true } | { ok: false; code: 'setup' | 'failed'; error: string }> {
  await mediaStarted();
  const s = await getActive();
  if (!s || s.stopping) return { ok: false, code: 'failed', error: 'No Session is recording.' };
  if (s.voice !== false) return { ok: true };
  if (!(await micGranted.getValue())) {
    await patchActive((a) => ({ ...a, voice_requested: true }));
    await chrome.tabs
      .create({ url: chrome.runtime.getURL('/onboarding.html?voice=1'), windowId: s.window_id })
      .catch(() => chrome.tabs.create({ url: chrome.runtime.getURL('/onboarding.html?voice=1') }));
    return { ok: false, code: 'setup', error: 'Allow the microphone in setup; voice turns on once it is allowed.' };
  }
  const { config } = await transcriptionForStart();
  const r = await sendMessage('offscreenVoiceOn', { transcription: config }).catch((e: unknown) => ({
    ok: false as const,
    error: String(e),
  }));
  if (!r.ok) {
    await panelNotice.setValue(`The microphone did not open: ${r.error}`);
    return { ok: false, code: 'failed', error: r.error };
  }
  const { captions, ...transcription } = r.transcription;
  await appendEvent(s.id, { type: 'voice_on', t: offsetOf(s) });
  await db.sessions.update(s.id, { transcription });
  const next = await patchActive((a) => ({
    ...a,
    voice: true,
    voice_requested: false,
    transcription,
    captions,
    commands: captions === 'live' ? 'loading' : 'unavailable',
    commands_note: captions === 'live' ? null : 'Voice Commands need live captions.',
  }));
  await panelNotice.setValue(null);
  if (next) await notifyContent(next.tab_id, next);
  return { ok: true };
}

/** Setup granted the microphone: a Session waiting for it (Turn on voice) gets its voice now. */
export async function onMicGranted(): Promise<void> {
  const s = await getActive();
  if (s?.voice === false && s.voice_requested && !s.stopping) await turnOnVoice();
}

/**
 * Comment-box dictation (E11): while on, the offscreen document sends what is said to the box (tagged with its
 * target), not to the Session transcript or Voice Commands; it works while muted, which holds again once it is off.
 */
export async function setBoxDictation(
  tabId: number | undefined,
  input: { target: DictationTarget; on: boolean },
): Promise<{ ok: boolean }> {
  await mediaStarted();
  const s = await getActive();
  if (!s || s.tab_id !== tabId || s.stopping || s.voice === false) return { ok: false };
  await sendMessage('offscreenBoxDictation', input.on ? input.target : null).catch(() => {});
  return { ok: true };
}

/** The panel's recorder started (its start offset aligns video to the Session clock), or sharing ended. */
export async function onVideoStatus(input: VideoStatusInput): Promise<void> {
  await patchActive((a) => {
    if (a.id !== input.session_id || a.video.state === 'off') return a;
    if (input.event === 'ended') return { ...a, video: { ...a.video, state: 'ended' } };
    return { ...a, video: { ...a.video, start_offset_ms: startOffset(a.t0, input.started_at), mime: input.mime } };
  });
}

/**
 * The picker window (./picker.ts) answered for a Session that started without video: a stream it now records, as the
 * toolbar frame does, or the reviewer's choice to go on without one. False once that Session has ended or is ending.
 */
export async function attachVideo(input: { session_id: string; video: StartVideo }): Promise<{ ok: boolean }> {
  const { session_id: id, video } = input;
  let taken = false;
  await patchActive((a) => {
    if (a.id !== id || a.stopping || a.video.state !== 'off') return a;
    taken = true;
    return {
      ...a,
      video:
        video.state === 'off'
          ? video
          : {
              state: 'recording',
              label: video.label,
              start_offset_ms: null,
              mime: null,
              width: video.width,
              height: video.height,
              recorder: 'surface',
            },
    };
  });
  if (!taken) return { ok: false };
  await db.sessions.update(id, { video_off_reason: video.state === 'off' ? video.reason : null });
  return { ok: true };
}

/**
 * The toolbar frame or the picker window recording the video went away: the video ends there, the Session goes on.
 * During Stop it goes once it has handed over its last chunk, which is no end of the video: a write then could also
 * put back the Session that Stop is clearing.
 */
export async function onVideoOwnerGone(sessionId: string): Promise<void> {
  await patchActive((a) =>
    a.id !== sessionId || a.stopping || a.video.state !== 'recording'
      ? a
      : { ...a, video: { ...a.video, state: 'ended' } },
  );
}

/** The panel that started the Session went away (closed, reloaded, crashed): that is Stop (ADR 0001). */
export async function onPanelGone(sessionId: string): Promise<void> {
  const s = await getActive();
  if (s?.id === sessionId && !s.stopping) await stopSession('panel_closed');
}

/** The content script asks on load (every navigation re-injects it). Only the Session's tab gets a state. */
export async function contentHello(tabId: number | undefined): Promise<ContentSessionState | null> {
  const s = await getActive();
  return s && s.tab_id === tabId ? contentStateFor(s) : null;
}

export async function onOffscreenError(message: string): Promise<void> {
  await panelNotice.setValue(message);
}
