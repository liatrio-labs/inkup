// Settings and small shared state (@wxt-dev/storage), all in storage.local. Content scripts and the offscreen document
// do not read these directly: the service worker passes what they need in messages (offscreen documents only have
// chrome.runtime). The exceptions are `toolbarPosition` and `toolbarTheme`, which the page's toolbar reads itself.
// The storage.session items are in src/session-state.ts, because defining one reads it at once: a module that a
// content script or an extension frame inside a page imports must not define one (Firefox gives neither
// storage.session, and every definition threw there, #31).

import type { ThemeSetting } from '@inkup/core/contrast';
import type { SessionMode } from '@inkup/core/target';
import type { TimestampQuality, TranscriptionInfoSchema } from '@inkup/core/timeline';
import { storage } from '@wxt-dev/storage';
import type { z } from 'zod';
import type { ModelList } from '@/adapters/llm/models';
import type { Effort } from '@/adapters/llm/types';

export type TranscriptionInfo = z.infer<typeof TranscriptionInfoSchema>;

export const FADE_MIN_MS = 1000;
export const FADE_MAX_MS = 5000;
export const clampFade = (ms: number) => Math.min(FADE_MAX_MS, Math.max(FADE_MIN_MS, Math.round(ms)));

/**
 * Comment-box dictation (E11). 'auto': while a comment box is open, speech goes into it (live captions shown, final
 * words appended), not into the Session transcript or Voice Commands; its mic button switches to typing. 'push': the
 * box opens for typing, and its mic button dictates while toggled on.
 */
export type BoxDictation = 'auto' | 'push';

export interface CaptureSettings {
  /** Strokes fade this long after pointer-up (PRD P0-2: 1–5s). */
  fadeMs: number;
  /** Absent: 'auto'. */
  boxDictation?: BoxDictation;
}

export const captureSettings = storage.defineItem<CaptureSettings>('local:captureSettings', {
  fallback: { fadeMs: 2000, boxDictation: 'auto' },
});

/**
 * Opt-in, default off: "Allow Chrome server speech recognition when on-device is unavailable". Off keeps the
 * free tier at zero network calls (P0-15): without the on-device pack a Session runs without live captions.
 */
export const allowServerSpeech = storage.defineItem<boolean>('local:allowServerSpeech', { fallback: false });

/**
 * Set by the onboarding page once getUserMedia succeeded in a visible tab. Until then a Session starts without voice
 * (E11): ink, picks, typed comments and screenshots, and "Turn on voice" asks for the microphone.
 */
export const micGranted = storage.defineItem<boolean>('local:micGranted', { fallback: false });

/**
 * The reviewer's Anthropic API key (PRD P0-14): `storage.local` only, never `sync`, never logged, never exported.
 * Empty string: no key, so a model role set to Anthropic makes no Draft Items and Process builds items in code.
 */
export const anthropicKey = storage.defineItem<string>('local:anthropicKey', { fallback: '' });

/**
 * The reviewer's Vercel AI Gateway key: the same rules as `anthropicKey`. A model role set to the Gateway calls the
 * Anthropic Messages API at ai-gateway.vercel.sh with it. Empty string: no key.
 */
export const gatewayKey = storage.defineItem<string>('local:gatewayKey', { fallback: '' });

/** Where a model role's calls go: Anthropic's API, or the Vercel AI Gateway's Anthropic-compatible API. */
export type LlmProvider = 'anthropic' | 'gateway';
export const GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh';

/** Effort per role (the Messages API's `output_config.effort`); absent, it is not sent. */
export type { Effort };
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The three calls a reviewer picks a model for: Process (P0-11), live Draft Items (P0-10) and Combine (E12). */
export type ModelRole = 'process' | 'draft' | 'merge';
export const MODEL_ROLES: readonly ModelRole[] = ['process', 'draft', 'merge'];

export interface RoleModel {
  provider: LlmProvider;
  /** Any model ID the provider accepts: `claude-sonnet-5` on Anthropic, `anthropic/claude-sonnet-5` on the Gateway. */
  model: string;
  effort?: Effort;
}

export type ProcessingSettings = Record<ModelRole, RoleModel> & {
  /**
   * Process runs without its confirm step when the estimate is priced and under this many USD (and no call is near
   * a model limit, and nothing would be replaced). Absent: always ask.
   */
  autoRunBelowUsd?: number;
};

/** A saved auto-run threshold as a positive dollar amount; anything else is off. */
export const readAutoRunBelowUsd = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

export const DEFAULT_MODELS: Readonly<Record<LlmProvider, Record<ModelRole, string>>> = {
  anthropic: { process: 'claude-sonnet-5', draft: 'claude-haiku-4-5-20251001', merge: 'claude-haiku-4-5-20251001' },
  gateway: {
    process: 'anthropic/claude-sonnet-5',
    draft: 'anthropic/claude-haiku-4.5',
    merge: 'anthropic/claude-haiku-4.5',
  },
};
export const DEFAULT_PROCESS_MODEL = DEFAULT_MODELS.anthropic.process;
export const DEFAULT_DRAFT_MODEL = DEFAULT_MODELS.anthropic.draft;
export const DEFAULT_MERGE_MODEL = DEFAULT_MODELS.anthropic.merge;

/**
 * What storage may hold: the per-role shape, or the one saved before the Gateway existed (Anthropic model ids, no
 * effort; `mergeModel` absent before E12). Read it through normalizeProcessingSettings.
 */
export type StoredProcessingSettings = Partial<ProcessingSettings> & {
  processModel?: string;
  draftModel?: string;
  mergeModel?: string;
};

const isProvider = (p: unknown): p is LlmProvider => p === 'anthropic' || p === 'gateway';
const isEffort = (e: unknown): e is Effort => EFFORTS.includes(e as Effort);

/** Any saved shape (or none) as the per-role settings; a blank or missing model is the provider's default. */
export function normalizeProcessingSettings(raw: StoredProcessingSettings | null | undefined): ProcessingSettings {
  const legacy: Record<ModelRole, string | undefined> = {
    process: raw?.processModel,
    draft: raw?.draftModel,
    merge: raw?.mergeModel,
  };
  const role = (r: ModelRole): RoleModel => {
    const saved = raw?.[r];
    const provider = isProvider(saved?.provider) ? saved.provider : 'anthropic';
    const model = (typeof saved?.model === 'string' ? saved.model : legacy[r])?.trim() || DEFAULT_MODELS[provider][r];
    return { provider, model, ...(isEffort(saved?.effort) ? { effort: saved.effort } : {}) };
  };
  const autoRunBelowUsd = readAutoRunBelowUsd(raw?.autoRunBelowUsd);
  return {
    process: role('process'),
    draft: role('draft'),
    merge: role('merge'),
    ...(autoRunBelowUsd !== undefined ? { autoRunBelowUsd } : {}),
  };
}

export const processingSettings = storage.defineItem<StoredProcessingSettings>('local:processingSettings', {
  fallback: {},
});

export const readProcessingSettings = async (): Promise<ProcessingSettings> =>
  normalizeProcessingSettings(await processingSettings.getValue());

/** The saved key of a provider, trimmed ('' without one). */
export const providerKey = async (provider: LlmProvider): Promise<string> =>
  (await (provider === 'gateway' ? gatewayKey : anthropicKey).getValue()).trim();

/**
 * Each provider's model list as last fetched from the options page: the model selects, Gateway prices for cost
 * estimates, output caps and context windows (src/adapters/llm/models.ts has the fields).
 */
export const modelLists = storage.defineItem<Partial<Record<LlmProvider, ModelList>>>('local:modelLists', {
  fallback: {},
});

/** P0-15: the Anthropic notice is shown once, the first time a key is saved. */
export const anthropicNoticeShown = storage.defineItem<boolean>('local:anthropicNoticeShown', { fallback: false });
/** The same notice for Vercel, the first time a Gateway key is saved. */
export const gatewayNoticeShown = storage.defineItem<boolean>('local:gatewayNoticeShown', { fallback: false });

/**
 * Transcription tier (PRD P0-7, P0-14). Free runs on this machine: on-device Web Speech (default) or local
 * Whisper. Better streams to Deepgram and Best to ElevenLabs, with the reviewer's own key.
 */
export type TranscriptionTier = 'free' | 'better' | 'best';
export type FreeEngine = 'webspeech' | 'whisper';
export type WhisperModelId = 'base' | 'small' | 'turbo';
export interface TranscriptionSettings {
  tier: TranscriptionTier;
  freeEngine: FreeEngine;
  whisperModel: WhisperModelId;
}
export const transcriptionSettings = storage.defineItem<TranscriptionSettings>('local:transcriptionSettings', {
  fallback: { tier: 'free', freeEngine: 'webspeech', whisperModel: 'base' },
});

/** Vendor keys (PRD P0-14): storage.local only, never sync, never logged, never exported. Empty: no key. */
export const deepgramKey = storage.defineItem<string>('local:deepgramKey', { fallback: '' });
export const elevenlabsKey = storage.defineItem<string>('local:elevenlabsKey', { fallback: '' });

/** P0-15: the "audio streams to <vendor> while live" notice is shown once per vendor, when its tier is first chosen. */
export const vendorNoticeShown = storage.defineItem<{ deepgram: boolean; elevenlabs: boolean }>(
  'local:vendorNoticeShown',
  {
    fallback: { deepgram: false, elevenlabs: false },
  },
);

/**
 * Local Whisper models the reviewer downloaded from the options page (explicit action only, P0-15). The weights
 * live in transformers.js's Cache Storage; this records what finished, for the options page and Start.
 */
export const whisperDownloads = storage.defineItem<
  Partial<Record<WhisperModelId, { downloaded_at: string; bytes: number }>>
>('local:whisperDownloads', {
  fallback: {},
});

/** One cue of a scripted transcript: emitted `at_ms` after the adapter starts, spanning `duration_ms` before it. */
export interface ScriptedCue {
  at_ms: number;
  duration_ms: number;
  text: string;
}
export interface ScriptedTranscript {
  timestamp_quality: TimestampQuality;
  cues: ScriptedCue[];
}

/**
 * Dev/test-only overrides. Never shown in production UI; tests set it through the service worker.
 * - `transcription: 'scripted'` replays `script` instead of using Web Speech (headless Chromium has no
 *   on-device speech pack).
 * - `audioChunkMs` shortens the 30s audio chunk interval so a short test exercises chunking.
 * - `anthropicBaseUrl` points the Anthropic adapter at a local stub server (tests/e2e/process.spec.ts), and
 *   `gatewayBaseUrl` the Gateway's (tests/e2e/gateway.spec.ts).
 * - `deepgramBaseUrl`, `elevenlabsBaseUrl` point the paid tiers at local stub servers (tests/support/stt-stubs.ts),
 *   and `sttRetryBaseMs` shortens their reconnect backoff (tests/e2e/stt-tiers.spec.ts).
 */
export interface DevOverrides {
  transcription?: 'scripted';
  script?: ScriptedTranscript;
  audioChunkMs?: number;
  anthropicBaseUrl?: string;
  /** The Vercel AI Gateway's base (tests point it at the same stub). */
  gatewayBaseUrl?: string;
  /** Deepgram REST base (http[s]://host:port); the listen WebSocket uses the same host with ws[s]. */
  deepgramBaseUrl?: string;
  /** ElevenLabs REST base; the Scribe WebSocket uses the same host with ws[s]. */
  elevenlabsBaseUrl?: string;
  /** First reconnect delay for the paid tiers (default 500 ms; doubles per retry). */
  sttRetryBaseMs?: number;
  /** Offer the viewport control, or not, whatever the browser's capability says (manual check S6 in Safari). */
  viewport?: boolean;
  /** How long a cancelled Session can be undone (default 10 s; tests shorten it). */
  discardUndoMs?: number;
  /** How long anything drawn on a page may stay without activity (plan E9; default 30 s). */
  maxOverlayMs?: number;
  /** The Annotation screenshot the page asks for never answers (e2e: a hung capture must not leave ink up). */
  hangAnnotationShots?: boolean;
}
export const devOverrides = storage.defineItem<DevOverrides | null>('local:devOverrides', { fallback: null });

/** Why a Session has no video (P0-1: the picker was cancelled → "video off"). */
export type VideoOffReason = 'picker_cancelled' | 'unavailable' | 'failed';

/**
 * The Session's tab video (P0-5, ADR 0001). `recording`: a MediaRecorder runs; `start_offset_ms` is set once it has
 * started. `ended`: the reviewer stopped sharing from the browser's bar (or the toolbar frame recording it went away
 * with its page), and the Session goes on without video. `recorder` is where it runs: 'surface', a page holding the
 * panel Port (the side panel, or the toolbar's Start frame), or 'media_context' (Chrome's tabCapture, opened by the
 * offscreen document). Absent means 'surface'.
 */
export type LiveVideo =
  | { state: 'off'; reason: VideoOffReason }
  | {
      state: 'recording' | 'ended';
      label: string;
      start_offset_ms: number | null;
      mime: string | null;
      width: number | null;
      height: number | null;
      recorder?: 'surface' | 'media_context';
    };

/** The page modes besides Draw (E7): pick an element (Object Select) or select text (Select Text) to comment on. */
export type SelectMode = 'object' | 'text';

/** The live Session, owned by the service worker; the panel watches it. */
export interface ActiveSession {
  id: string;
  tab_id: number;
  window_id: number;
  t0: number;
  tab_title: string;
  tab_url: string;
  draw_mode: boolean;
  /** Object Select or Select Text is on (E7); at most one of it and draw_mode (background/modes.ts). Absent: none. */
  select_mode?: SelectMode | null;
  /**
   * What the Session can do on the tab's current page: 'page' (content-script overlay), 'own_page' (our own
   * extension page mounts the overlay) or 'no_overlay' (another extension's page or chrome://: no drawing,
   * screenshots only through the `snap` shortcut). Follows navigations.
   */
  mode: SessionMode;
  transcription: TranscriptionInfo | null;
  /** 'unavailable': no live captions this Session (no on-device speech pack and no server opt-in). */
  captions: 'live' | 'unavailable';
  /**
   * Set from Start until the page under review has the Session (F1): the toolbar says "Starting…" meanwhile, so it
   * never says Recording while the page's modes and shortcuts would not answer. Absent: false.
   */
  starting?: boolean;
  /** Set while Stop is finalizing media. */
  stopping: boolean;
  /** Set while paused: Session time and epoch ms of the pause, and how it was asked for. */
  paused: { t: number; at: number; via: 'button' | 'voice' } | null;
  /**
   * Set while the microphone is muted (E10): Session time and epoch ms it went off. The audio records silence and
   * nothing is transcribed or heard as a Voice Command; everything else goes on. Independent of `paused`.
   */
  muted?: { t: number; at: number } | null;
  /**
   * The microphone is recording (E11). False: the Session started without one (no grant, or it failed to open); the
   * toolbar says "No mic" and offers "Turn on voice". `voice_requested`: that was pressed and setup is open for the
   * grant, which turns it on. Absent: true (a Session from before E11).
   */
  voice?: boolean;
  voice_requested?: boolean;
  /** Total ms of the pauses already resumed; the open pause is `paused`. The timer counts only active time. */
  paused_ms: number;
  /** The reviewer is looking at another tab of the Session's window; capture stays bound to the Session tab. */
  away: { tab_id: number; title: string } | null;
  /** Voice Commands: loading while the VAD model loads; unavailable without live captions or the VAD. */
  commands: 'loading' | 'ready' | 'unavailable';
  commands_note: string | null;
  /** Last URL logged as a navigation (or the start URL). */
  last_url: string;
  video: LiveVideo;
  /**
   * Live Draft Items (P0-10): enabled when the Draft model's provider had a key at Start; otherwise the panel shows
   * Annotation cards. `note`: why the last pass failed (non-fatal).
   */
  drafts: { enabled: boolean; running: boolean; note: string | null };
}

/**
 * Sessions the reviewer cancelled (E10), kept until `deadline` (epoch ms) so Cancel can be undone. The service worker
 * deletes each at its deadline (a timer, an alarm, and a sweep when it starts, so a restarted worker still does); the
 * host outbox holds its rows meanwhile. storage.local, not session: a browser closed inside the window would otherwise
 * forget the discard and keep the Session; the next start's sweep deletes it instead.
 */
export interface DiscardPending {
  session_id: string;
  deadline: number;
  window_id: number;
}
export const discardPending = storage.defineItem<DiscardPending[]>('local:discardPending', { fallback: [] });

/** Where the toolbar sits (viewport px, its top-left corner) and whether it is collapsed to a pill; every page shares it. */
export interface ToolbarPosition {
  x: number;
  y: number;
  collapsed: boolean;
}
export const toolbarPosition = storage.defineItem<ToolbarPosition | null>('local:toolbarPosition', { fallback: null });

/** The toolbar's look (plan E8): 'auto' follows the page behind it; 'light' or 'dark' fixes it. Every page shares it. */
export const toolbarTheme = storage.defineItem<ThemeSetting>('local:toolbarTheme', { fallback: 'auto' });

/**
 * A tab whose page viewport the toolbar's viewport control resized (plan E6), by tab id. `url` is the page being
 * reviewed: the framed page, which the tab's own URL (the frame host's) does not show.
 */
export interface TabViewport {
  width: number;
  height: number;
  scale: number;
  url: string;
}

/** Where the frame host page (src/entrypoints/viewport) shows the frame, by tab id: its CSS px, for cropping screenshots. */
export interface FrameHostLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

/** The last viewport size used on each origin, offered first the next time the control opens there. */
export const viewportSizes = storage.defineItem<Record<string, { width: number; height: number }>>(
  'local:viewportSizes',
  { fallback: {} },
);

/**
 * Pairing with a Host (ADR 0004, ADR 0005): its address and the token it issued. null: never paired, or
 * forgotten. The extension is the whole product without it; while it is set, events and blobs also go to the
 * Host through the outbox.
 */
export interface HostPairing {
  url: string;
  token: string;
  client_id: string;
  paired_at: string;
}
export const hostPairing = storage.defineItem<HostPairing | null>('local:hostPairing', { fallback: null });

/**
 * Tokens Forget could not revoke because the Host was unreachable: the service worker asks each Host to revoke its
 * token when it can reach it again, and drops the entry once the Host has (or says it never knew the token).
 */
export const hostRevokePending = storage.defineItem<{ url: string; token: string }[]>('local:hostRevokePending', {
  fallback: [],
});

/** The pairing (its client id) whose one-time "Upload earlier Sessions" notice was answered, Upload or Not now. */
export const hostBackfillNoticed = storage.defineItem<string | null>('local:hostBackfillNoticed', { fallback: null });

/** Hosts this browser has paired with, newest first: Find hubs probes them with the `.local` names (ADR 0006). */
export const hostAddresses = storage.defineItem<string[]>('local:hostAddresses', { fallback: [] });

/** Tests only: what Find hubs probes instead of the `.local` names and saved addresses. */
export const hostProbeOverride = storage.defineItem<string[] | null>('local:hostProbeOverride', { fallback: null });

/** The address the options page pairs with (the default port unless the reviewer changed it). */
export const hostUrl = storage.defineItem<string>('local:hostUrl', { fallback: 'http://127.0.0.1:47823' });

/** The service worker's connection to the paired Host. Only meaningful while `hostPairing` is set. */
export type HostStatus =
  | { state: 'unpaired' }
  | { state: 'pairing' }
  | { state: 'connecting' }
  | { state: 'connected'; host_version: string; capabilities: string[] }
  | { state: 'offline'; error: string; retry: boolean };
