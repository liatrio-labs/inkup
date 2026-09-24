// Typed messages between contexts (@webext-core/messaging). Blobs never go over messages; they go through
// Dexie. Each message type has exactly one receiving context, noted per group.

import type { ElementSnapshot } from '@inkup/core/candidates';
import type { Rgb } from '@inkup/core/contrast';
import type { Rect } from '@inkup/core/geometry';
import type { ChangeItem } from '@inkup/core/process/change-item';
import type { CostEstimate } from '@inkup/core/process/cost';
import type { CloseReason, DictationTarget, EventOf } from '@inkup/core/timeline';
import { defineExtensionMessaging } from '@webext-core/messaging';
import type { FoundHost } from '@/adapters/host';
import type { ConnectionTest } from '@/adapters/llm/types';
import type { AdapterConfig, Fallback, TranscriptionInfo } from '@/adapters/transcription';
import type { CombineItemsResult, EstimateResult, ProcessStartResult } from '@/background/process';
import type { SampleInput } from '@/background/screenshots';
import type { PageApiRequest, PageApiResult } from '@/content/page-api';
import type { AudioMedia } from '@/db';
import type { ActiveSession, BoxDictation, LiveVideo, SelectMode } from '@/settings';

export type StartResult =
  | { ok: true; session: ActiveSession }
  | { ok: false; code: 'mic_not_granted' | 'mic_failed' | 'no_tab' | 'already_recording' | 'failed'; error: string };

/** What the panel's (or the toolbar frame's) Start click got from the screen picker, sent with startSession. */
export type StartVideo =
  | { state: 'off'; reason: Extract<LiveVideo, { state: 'off' }>['reason'] }
  | { state: 'recording'; label: string; width: number | null; height: number | null };

/**
 * What the page's floating toolbar shows (src/content/toolbar.ts), pushed by the service worker to every tab that
 * shows it; null hides it. The toolbar renders only this, so it has no state of its own beyond position.
 */
export type HostPairResult = { ok: true } | { ok: false; error: string; needsCode?: boolean };

export interface ToolbarState {
  /** The live Session. `here`: it records this tab (else the toolbar offers only Stop). */
  session: {
    t0: number;
    paused_ms: number;
    /** Session time of the open pause, or null while recording. */
    paused_t: number | null;
    /** Until the page has the Session (F1): the toolbar says "Starting…". */
    starting: boolean;
    stopping: boolean;
    draw_mode: boolean;
    /** Object Select or Select Text is on (E7); never together with draw_mode. */
    select_mode: SelectMode | null;
    /** Drawing is possible on this page (not a 'no_overlay' page). */
    can_draw: boolean;
    here: boolean;
    video: LiveVideo['state'];
    /** The microphone is muted (E10). */
    muted: boolean;
    /** The microphone records (E11); false: "No mic", with "Turn on voice". */
    voice: boolean;
  } | null;
  /** The Session just cancelled (E10), until its Undo deadline (epoch ms): the toast offers Undo. */
  discard: { session_id: string; deadline: number } | null;
  /** Start is possible, and how it would get video (without a microphone grant the Session has no voice, E11). */
  start: { ok: true; video: 'tab_capture' | 'frame_picker' | 'none' } | { ok: false; reason: string };
  /** Only while paired (ADR 0004): unpaired, no host UI at all. */
  host: 'connected' | 'offline' | null;
  /** The paired Host is on another computer (network mode, ADR 0006): nothing it is sent is encrypted. */
  hostNetwork: boolean;
  /** The toast strip: the latest caption or Draft Item of the live Session. */
  toast: { id: string; kind: 'caption' | 'draft'; text: string } | null;
  /** The last error to show (a failed Start, the microphone failing mid-Session). */
  notice: string | null;
  /** The viewport control (plan E6), or null where this page cannot be resized (the control is hidden). */
  viewport: ToolbarViewport | null;
}

export interface ToolbarViewport {
  /** The size the page is resized to, or null at the tab's own size. */
  current: { width: number; height: number; scale: number } | null;
  /** The tab's own size: "Fit to tab", and the limit past which a size is shown scaled down. */
  tab: { width: number; height: number };
  /** The last size used on this origin. */
  last: { width: number; height: number } | null;
  /** Why this page cannot be resized (it refuses framing): the control says so instead of offering sizes. */
  blocked?: string;
}

/** The panel's video MediaRecorder started (its first moment, as epoch ms) or the shared tab stopped. */
export type VideoStatusInput =
  | { session_id: string; event: 'started'; started_at: number; mime: string }
  | { session_id: string; event: 'ended' };

export type StrokeInput = Omit<EventOf<'stroke'>, 'id' | 'type'>;

export interface ConnectorEndInput {
  point: { x: number; y: number };
  /** Region the end resolves: the mark at that end, or a small box around the point. */
  bbox: Rect;
  snapshots: ElementSnapshot[];
}

export interface AnnotationInput {
  annotation_id: string;
  stroke_ids: string[];
  t: number;
  t_end: number;
  close_reason: CloseReason;
  bbox: Rect;
  url: string;
  scroll: { x: number; y: number };
  viewport: { width: number; height: number };
  dpr: number;
  snapshots: ElementSnapshot[];
  connector: { stroke_ids: string[]; tail: ConnectorEndInput; head: ConnectorEndInput } | null;
  /**
   * The screenshot the page took while the Strokes were on screen (captureAnnotation); null when none could be
   * taken. Omitted, the service worker shoots at close.
   */
  screenshot_id?: string | null;
  /** The note typed in its comment box, in a Session without voice (E11). */
  comment?: string | null;
}

export interface AnnotationShotInput {
  annotation_id: string;
  /** Read in the same turn as the request. */
  page: Pick<EventOf<'screenshot'>, 'url' | 'scroll' | 'viewport' | 'dpr'>;
}

/**
 * An element picked with Object Select (E7), recorded as an Annotation of its own (close reason object_select) once
 * the reviewer is done with it: from the pick (`t`) to Enter in its comment box, a click elsewhere or the mode ending.
 */
export interface ObjectSelectInput {
  annotation_id: string;
  t: number;
  t_end: number;
  /** Read at the pick, while the element's outline is on screen. */
  page: Pick<EventOf<'screenshot'>, 'url' | 'scroll' | 'viewport' | 'dpr'>;
  element: ElementSnapshot;
  /** What they typed in the comment box; null when they only spoke. */
  comment: string | null;
}

/** A dictated caption for the open comment box (E11): `final` words are appended, an interim one only shown. */
export interface DictationText {
  target: DictationTarget;
  text: string;
  final: boolean;
}

export type ClickInput = Omit<EventOf<'click'>, 'id' | 'type'>;
export type ClickPage = Pick<ClickInput, 'url' | 'scroll' | 'viewport' | 'dpr'>;
export type ScrollSettleInput = Omit<EventOf<'scroll_settle'>, 'id' | 'type'>;
export type OverlayClearedInput = Omit<EventOf<'overlay_cleared'>, 'id' | 'type'>;
/** A Text Comment as the page saw it; the service worker numbers it and takes its screenshot. */
export type TextCommentInput = Omit<EventOf<'text_comment'>, 'id' | 'type' | 'index' | 'screenshot_id'>;

/** Close the open Annotation for this reason; resolves once it is recorded. */
export interface ContentSignal {
  reason: 'speech_boundary' | 'voice_command' | 'pause' | 'text_comment';
  /** Session time of the signal. */
  t: number;
  /** Speech Boundary: close only if the open Annotation began before this. */
  if_opened_before?: number;
}

/** A Voice Command that passed the silence gate (packages/core/src/voice-commands.ts). */
export interface VoiceCommandInput {
  command: EventOf<'voice_command'>['command'];
  phrase: string;
  segment_id: string | null;
  t: number;
  t_end: number;
}

export type VoiceCommandsStatus = { status: 'loading' | 'ready' } | { status: 'unavailable'; reason: string };

/** What the content script needs to know about the Session; null when its tab is not being recorded. */
export interface ContentSessionState {
  session_id: string;
  t0: number;
  draw_mode: boolean;
  /** Object Select or Select Text is on (E7); never together with draw_mode. */
  select_mode: SelectMode | null;
  fade_ms: number;
  /** Paused: no drawing, clicks or scrolls are captured. */
  paused: boolean;
  /** The microphone is muted (E10): Alt+Shift+M turns it back on. */
  muted: boolean;
  /** The microphone records (E11). False: comment boxes have no mic button, and a drawn Annotation asks for a note. */
  voice: boolean;
  /** How comment boxes take speech (E11). */
  /** Null without live captions (no engine to dictate with: Firefox without Whisper). */
  box_dictation: BoxDictation | null;
}

export type SegmentInput = Omit<EventOf<'transcript_segment'>, 'id' | 'type' | 'run_id' | 'target'> & {
  target?: DictationTarget | null;
};

export interface OffscreenStartConfig {
  session_id: string;
  t0: number;
  lang: string;
  chunk_ms: number;
  transcription: AdapterConfig;
  /** False: no microphone (E11); only the tab video, if any, is recorded until offscreenVoiceOn. */
  voice: boolean;
  /** Chrome's tabCapture id for the Session tab: the media context records its video too. */
  video_capture_id?: string;
}

/** The media context's tab video: its size once open, or why it could not open. */
export type OffscreenVideo = { ok: true; width: number | null; height: number | null } | { ok: false; error: string };

/**
 * `transcription` null: no microphone (asked without voice, or `mic_error` when it would not open, so the Session goes
 * on without voice).
 */
export type OffscreenStartResult =
  | { ok: true; transcription: TranscriptionInfo | null; mic_error?: string; video?: OffscreenVideo }
  | { ok: false; error: string };

export interface ProtocolMap {
  // Side panel and extension pages → service worker
  /**
   * `clicked_at`: epoch ms of the Start click, before the picker (PRD §8 Start→recording latency). `from_toolbar`:
   * sent by the toolbar's Start frame, which records the tab it sits in (the sender's), not the focused one.
   */
  startSession(input: { video: StartVideo; clicked_at?: number; from_toolbar?: boolean }): StartResult;
  /** Side panel → service worker: its video recorder started, or sharing ended. */
  videoStatus(input: VideoStatusInput): void;
  stopSession(): { ok: boolean; session_id: string | null };
  /** Cancel (E10): stop at once and discard the Session unless undone within the window. */
  cancelSession(): { ok: boolean; session_id: string | null };
  /** Keep a cancelled Session after all, as if it had been stopped. */
  undoDiscard(sessionId: string): { ok: boolean };
  /** Mute (E10): the toolbar's mic button, the panel's, or Alt+Shift+M on the page. */
  setMuted(input: { on: boolean; via: 'button' | 'shortcut' }): ActiveSession | null;
  /** "Turn on voice" (E11): the microphone for a Session without one; opens setup when it has not been granted. */
  turnOnVoice(): { ok: true } | { ok: false; code: 'setup' | 'failed'; error: string };
  setDrawMode(on: boolean): ActiveSession | null;
  /** Object Select or Select Text on (null: off); turns Draw off (E7). */
  setSelectMode(mode: SelectMode | null): ActiveSession | null;
  /** Esc on the page: Draw, Object Select and Select Text all off. */
  clearModes(): ActiveSession | null;
  pauseSession(): ActiveSession | null;
  resumeSession(): ActiveSession | null;
  /** Panel Snap button (P0-6). */
  snapScreenshot(): { screenshot_id: string | null };
  /** Review page: token count and cost before Process (P0-11). */
  estimateProcess(sessionId: string): EstimateResult;
  /** Review page: start Process; answers once the run row exists. The page follows the row, not this reply. */
  startProcess(input: { session_id: string; estimate: CostEstimate | null }): ProcessStartResult;
  /** Review page, after a merge: the merge model rewrites the two items as one (E12). */
  combineItems(input: { run_id: string; into: ChangeItem; from: ChangeItem }): CombineItemsResult;
  /** Side panel: discard or pin a Draft Item card (P0-10). */
  draftAction(input: { draft_id: string; action: 'discard' | 'pin' }): { ok: boolean };
  /** Options page: a cheap real call with the saved key and models. */
  testAnthropic(): ConnectionTest;
  /**
   * Options page: ask the Host at `url` to pair; answers once its user approved or refused. A Host on another machine
   * (ADR 0006) wants the 6-digit code it shows: without one (or with a wrong one) the answer has `needsCode`.
   */
  hostPair(input: { url: string; code?: string }): HostPairResult;
  /** Options page, Find hubs: the Hosts that answer at the `.local` names and the saved addresses. */
  hostFind(): FoundHost[];
  /**
   * Options page: forget the Host, its token and anything still waiting to be sent. The Host is asked to revoke the
   * token first; `revoked` is false when it could not be reached (it is asked again once it can be).
   */
  hostForget(): { revoked: boolean };
  /** How many stored Sessions the paired Host lacks (recorded before pairing): "Upload N earlier Sessions". */
  hostBackfillOffer(): { sessions: number };
  /** Queues those Sessions whole for the Host; answers how many. */
  hostBackfill(): { queued: number };
  /** Any extension page that wrote to the outbox (review edits): send it now if connected. */
  hostDrain(): void;

  // Content script → service worker
  /** On every page load: the Session state if this tab records, and the toolbar if it shows one. */
  contentHello(): { session: ContentSessionState | null; toolbar: ToolbarState | null };
  recordStroke(stroke: StrokeInput): void;
  closeAnnotation(input: AnnotationInput): { screenshot_id: string | null; index: number };
  /** Screenshot the open Annotation now, Strokes held on screen (after each Stroke's pointer-up). */
  captureAnnotation(input: AnnotationShotInput): { screenshot_id: string | null };
  /** A click on an interactive element (never keystrokes). */
  recordClick(input: ClickInput): void;
  /** A press on an interactive element: its click screenshot is taken now, before the click can navigate away. */
  pressInteractive(page: ClickPage): void;
  recordScrollSettle(input: ScrollSettleInput): void;
  /** Clear all (E9) emptied the page's overlay while it records. */
  overlayCleared(input: OverlayClearedInput): void;
  /** The page's mean colour in a rect (or the band around it) from a capture, where computed styles cannot tell (E8). */
  sampleBackground(input: SampleInput): Rgb | null;
  /** Object Select: the pick is done (its comment typed, or not); logged as an Annotation with the screenshot captureAnnotation took at the pick. */
  objectSelect(input: ObjectSelectInput & { screenshot_id: string | null }): { index: number };
  /** Object Select: the pick was dropped (Esc, Clear all): the screenshot taken at the pick goes (#22). */
  dropPick(input: { screenshot_id: string }): void;
  /** A comment typed on selected text; the selection is on screen for its screenshot. */
  recordTextComment(input: TextCommentInput): { screenshot_id: string | null; index: number };
  /** A comment box's dictation on or off (E11): speech goes into it while on. False when there is no voice. */
  boxDictation(input: { target: DictationTarget; on: boolean }): { ok: boolean };
  /** A `window.__inkup` call from the page (E5), checked against the Session recording the sender's tab. */
  pageApi(req: PageApiRequest): PageApiResult;

  // The page's floating toolbar (content script) → service worker
  /** The toolbar for this tab, or null when it is not shown here. Also its keep-alive ping while recording. */
  toolbarHello(): ToolbarState | null;
  /** Start from the toolbar (no picker: Chrome's tabCapture, or audio only). */
  toolbarStart(input: { clicked_at: number }): StartResult;
  /** Open the control surface (panel), or setup when the microphone is not granted yet. */
  toolbarOpen(what: 'panel' | 'setup'): void;
  /** The toolbar's close button: hide it in this tab (the icon brings it back). */
  toolbarHide(): void;
  /** The viewport control: resize this tab's page viewport; answers with why not, when it cannot. */
  viewportSet(size: { width: number; height: number }): { ok: true } | { ok: false; error: string };
  /** Give the page the tab's own size again. */
  viewportReset(): void;

  // The frame host (the page's frame and our page around it) → service worker
  /** The frame host's frame loaded a page (a manifest content script in every frame; only ours asks). */
  viewportFrameLoaded(input: { url: string; title: string }): void;
  /** The frame host page laid the frame out: where it is in the tab, for cropping screenshots. */
  viewportHostLayout(layout: { x: number; y: number; width: number; height: number; scale: number }): void;

  // Offscreen document → service worker
  transcriptSegment(segment: SegmentInput): void;
  offscreenError(message: string): void;
  /** Logged as `transcription_fallback`; may arrive before offscreenStart has replied. */
  transcriptionFallback(input: Fallback & { session_id: string }): void;
  /** A VAD speech span, logged as `speech_activity` (not sent while paused). */
  speechActivity(span: { t: number; t_end: number }): void;
  /** The VAD heard speech begin (not sent while paused); holds back a Draft Item pass. */
  speechStart(input: { t: number }): void;
  voiceCommand(hit: VoiceCommandInput): void;
  voiceCommandsStatus(status: VoiceCommandsStatus): void;
  /** An interim caption while a comment box dictates (E11); finals come as transcriptSegment with their target. */
  boxInterim(input: { target: DictationTarget; text: string }): void;

  // Service worker → offscreen document
  offscreenStart(config: OffscreenStartConfig): OffscreenStartResult;
  offscreenStop(): AudioMedia | null;
  /** Stop the tab video (if it records one) and write its last chunk: the chunk count and when it stopped. */
  offscreenVideoStop(): { chunks: number; stopped_at: number } | null;
  offscreenPause(): void;
  offscreenResume(): void;
  /** Mute (E10): the mic track off (the audio records silence), transcription and Voice Commands deaf; or back on. */
  offscreenMute(on: boolean): void;
  /** Comment-box dictation (E11): speech goes to `target` (null: back to the Session), even while muted. */
  offscreenBoxDictation(target: DictationTarget | null): void;
  /** "Turn on voice" (E11): open the microphone for a Session started without one. */
  offscreenVoiceOn(input: {
    transcription: AdapterConfig;
  }): { ok: true; transcription: TranscriptionInfo } | { ok: false; error: string };
  /** Build-integrity check of the bundled ORT/VAD assets (tests only; see tests/e2e/ort-assets.spec.ts). */
  ortSelfTest(check: 'vad' | 'transformers'): unknown;

  // Service worker → content script, or the overlay our own extension pages mount (tabs.sendMessage reaches both)
  contentState(state: ContentSessionState | null): void;
  /** Close the open Annotation (reason session_end) and resolve once the service worker has recorded it. */
  contentFlush(): void;
  contentSignal(signal: ContentSignal): void;
  /** Dictated words for the open comment box (E11). */
  contentDictation(input: DictationText): void;
  /** The page's url, scroll, viewport and dpr (our own extension pages, where scripts cannot be injected). */
  /** A live content script answers (#18): background/inject.ts leaves its tab alone. */
  contentPing(): true;
  contentPageContext(): Pick<EventOf<'screenshot'>, 'url' | 'scroll' | 'viewport' | 'dpr'>;
  toolbarState(state: ToolbarState | null): void;
  /** Hide the toolbar and the Text Comment chip for a screenshot (true; resolves once off screen) and show them again (false). */
  toolbarCapture(hidden: boolean): void;
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
