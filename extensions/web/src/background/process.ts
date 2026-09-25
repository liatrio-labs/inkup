// Process in the service worker (PRD P0-11): estimate, run, store. The review page asks; the worker reads the
// key (storage.local), builds session.json from Dexie, runs the LLM adapter and writes a processRuns row that
// the page watches with useLiveQuery. A failure is recorded on the run and touches nothing else.
//
// Video-grounded Process: when the Process model is on the Gateway and takes video (videoCapable), and the Session
// has a recording under VIDEO_INLINE_MAX_BYTES, the video and audio go with the calls through the Gateway's chat
// endpoint. Over the cap, Process falls back to the script and screenshots and says so on the run (`notes`).
// Vetting (on unless turned off in the options) checks every item against the recording after Process.
//
// Without a key (E11) Process still runs: the items are built in code (one per Annotation and Text Comment,
// packages/core/src/process/in-code.ts), with no estimate and no network call. The run's model is IN_CODE_MODEL.

import type { CombinedChanges } from '@inkup/core/process/combine';
import { type CostEstimate, type LimitWarning, limitWarnings } from '@inkup/core/process/cost';
import type { SessionDocument } from '@inkup/core/session-document';
import {
  type ChunkProgress,
  type CombineInput,
  type ConnectionTest,
  createAnthropicAdapter,
  type LlmAdapter,
  ProcessError,
  type ProcessMedia,
  processWithoutModel,
  type ScreenshotImage,
} from '@/adapters/llm';
import { createChatTransport } from '@/adapters/llm/chat';
import {
  catalogOf,
  gatewayInputModalities,
  listAnthropicModels,
  listGatewayModels,
  type ModelList,
  takesVideo,
} from '@/adapters/llm/models';
import { db, type ProcessRunRow } from '@/db';
import { queueItems } from '@/db/outbox';
import { loadSessionDocument } from '@/db/session-export';
import {
  DEFAULT_MODELS,
  devOverrides,
  type Effort,
  GATEWAY_BASE_URL,
  type LlmProvider,
  MODEL_ROLES,
  type ModelRole,
  modelCapabilities,
  modelLists,
  providerKey,
  readProcessingSettings,
} from '@/settings';

export type ListModelsResult = { ok: true; list: ModelList } | { ok: false; error: string };
/** `warnings`: calls of the estimate near a model limit (the review page asks before running those). */
export type EstimateResult =
  | { ok: true; estimate: CostEstimate; warnings: LimitWarning[] }
  | { ok: false; code: string; error: string };
export type RunResult =
  | { ok: true; run_id: string; items: number }
  | { ok: false; run_id: string | null; code: string; error: string };

const running = new Set<string>();

const PROVIDER_NAME: Record<LlmProvider, string> = { anthropic: 'Anthropic', gateway: 'Vercel AI Gateway' };

/** An adapter for one provider with its saved key; null without a key. */
async function adapterFor(provider: LlmProvider): Promise<LlmAdapter | null> {
  const key = await providerKey(provider);
  if (!key) return null;
  const dev = await devOverrides.getValue();
  const baseURL = provider === 'gateway' ? (dev?.gatewayBaseUrl ?? GATEWAY_BASE_URL) : (dev?.anthropicBaseUrl ?? null);
  return createAnthropicAdapter({
    apiKey: key,
    baseURL,
    vendor: PROVIDER_NAME[provider],
    catalog: catalogOf(await modelLists.getValue()),
    // Only the Gateway's chat endpoint takes video; Process uses it when it sends the recording.
    chat:
      provider === 'gateway' && baseURL
        ? createChatTransport({ apiKey: key, baseURL, vendor: PROVIDER_NAME.gateway })
        : null,
  });
}

/**
 * A model role's adapter (its provider, with that provider's saved key), model and effort; null when that provider
 * has no key. Process, the live Draft Item pass and Combine each ask for their own role.
 */
export async function llm(
  role: ModelRole,
): Promise<{ adapter: LlmAdapter; provider: LlmProvider; model: string; effort?: Effort } | null> {
  const { provider, model, effort } = (await readProcessingSettings())[role];
  const adapter = await adapterFor(provider);
  return adapter ? { adapter, provider, model, ...(effort ? { effort } : {}) } : null;
}

async function noKey(role: ModelRole) {
  const { provider } = (await readProcessingSettings())[role];
  const key = provider === 'gateway' ? 'a Vercel AI Gateway key' : 'an Anthropic API key';
  return { ok: false as const, code: 'no_key', error: `Add ${key} in the extension options first.` };
}

/** The processRuns `model` of a run built in code, without a key. */
export const IN_CODE_MODEL = 'none (built in code)';

/** The most recording (video plus audio, decoded bytes) one video-grounded request carries inline. */
export const VIDEO_INLINE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Whether a Gateway model takes video (models.ts, takesVideo): its cached list tags, else the model's endpoints
 * call. The answer is cached per model id in `modelCapabilities`; a failed endpoints call is not.
 */
export async function videoCapable(model: string): Promise<boolean> {
  const cached = (await modelCapabilities.getValue())[model];
  if (cached) return cached.video;
  const tags = (await modelLists.getValue()).gateway?.models.find((m) => m.id === model)?.tags ?? [];
  let video = takesVideo(model, tags, null);
  if (!video) {
    const apiKey = await providerKey('gateway');
    if (!apiKey) return false;
    const dev = await devOverrides.getValue();
    try {
      const modalities = await gatewayInputModalities({
        apiKey,
        baseURL: dev?.gatewayBaseUrl ?? GATEWAY_BASE_URL,
        model,
      });
      video = takesVideo(model, tags, modalities);
    } catch (e) {
      console.warn('video capability', e);
      return false;
    }
  }
  await modelCapabilities.setValue({
    ...(await modelCapabilities.getValue()),
    [model]: { video, checked_at: Date.now() },
  });
  return video;
}

const MB = 1024 * 1024;
const formatMb = (bytes: number) =>
  bytes < MB ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
/** `video/webm;codecs=vp9` → `video/webm`. */
const baseMime = (mime: string) => mime.split(';')[0]!.trim();
const extensionOf = (mime: string) => baseMime(mime).split('/')[1] ?? 'bin';

/**
 * What a Process run sends of the recording: nothing when the model takes no video or the Session has none; a
 * note instead when the recording is over the cap. `load` false: sizes only (the estimate).
 */
async function planMedia(
  doc: SessionDocument,
  a: { provider: LlmProvider; model: string },
  load: boolean,
): Promise<{ media: ProcessMedia | null; video: boolean; note: string | null }> {
  const none = { media: null, video: false, note: null };
  const v = doc.media.video;
  if (a.provider !== 'gateway' || !v || !(await videoCapable(a.model))) return none;
  const videoRow = await db.blobs.get(v.blob_id);
  if (!videoRow) return none;
  const audioRow = doc.media.audio ? await db.blobs.get(doc.media.audio.blob_id) : undefined;
  const bytes = videoRow.blob.size + (audioRow?.blob.size ?? 0);
  const cap = (await devOverrides.getValue())?.videoInlineMaxBytes ?? VIDEO_INLINE_MAX_BYTES;
  if (bytes > cap)
    return {
      media: null,
      video: false,
      note: `The recording (${formatMb(bytes)}) is over the ${formatMb(cap)} a request can carry, so ${a.model} worked from the transcript and screenshots instead of the video.`,
    };
  if (!load) return { media: null, video: true, note: null };
  const file = async (row: NonNullable<typeof videoRow>, kind: 'video' | 'audio', start: number, duration: number) => ({
    media_type: baseMime(row.mime),
    filename: `${kind}.${extensionOf(row.mime)}`,
    data: toBase64(new Uint8Array(await row.blob.arrayBuffer())),
    bytes: row.blob.size,
    start_offset_ms: start,
    duration_ms: duration,
  });
  const audio = doc.media.audio;
  return {
    media: {
      video: await file(videoRow, 'video', v.start_offset_ms, v.duration_ms),
      audio: audioRow && audio ? await file(audioRow, 'audio', audio.start_offset_ms, audio.duration_ms) : null,
    },
    video: true,
    note: null,
  };
}

export async function estimateProcess(sessionId: string): Promise<EstimateResult> {
  const a = await llm('process');
  if (!a) return noKey('process');
  try {
    const doc = await loadSessionDocument(db, sessionId);
    const { vet } = await readProcessingSettings();
    const { video } = await planMedia(doc, a, false);
    const estimate = await a.adapter.estimate({ doc, model: a.model, effort: a.effort, vet, video });
    return { ok: true, estimate, warnings: limitWarnings(estimate, catalogOf(await modelLists.getValue())) };
  } catch (e) {
    const err = e instanceof ProcessError ? e : new ProcessError('api', e instanceof Error ? e.message : String(e));
    return { ok: false, code: err.code, error: err.message };
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** A screenshot or element crop, for vetting against screenshots. */
async function loadScreenshot(id: string): Promise<ScreenshotImage | null> {
  const row = await db.blobs.get(id);
  if (row?.kind !== 'screenshot' && row?.kind !== 'screenshot_crop') return null;
  const type = row.mime === 'image/jpeg' || row.mime === 'image/webp' ? row.mime : 'image/png';
  return { media_type: type, data: toBase64(new Uint8Array(await row.blob.arrayBuffer())) };
}

export type ProcessStartResult =
  | { ok: true; run_id: string }
  | { ok: false; run_id: null; code: string; error: string };

// Chrome stops an extension service worker after 30 s without an event or extension API call, and ends any single
// event that takes longer than 5 minutes (developer.chrome.com, "The extension service worker lifecycle"). A
// Process run streams for minutes and makes no extension API calls, so while one runs the worker calls a cheap
// API every 20 s, and the review page's request is answered as soon as the run starts, not when it ends.
export const HEARTBEAT_MS = 20_000;
let heartbeat: ReturnType<typeof setInterval> | null = null;
function heartbeatWhileRunning() {
  if (running.size > 0 && !heartbeat) {
    heartbeat = setInterval(() => void chrome.runtime.getPlatformInfo().catch(() => {}), HEARTBEAT_MS);
  } else if (running.size === 0 && heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

/**
 * Review page: start a run and answer at once with its id. The run carries on in the worker and writes its
 * processRuns row, which the page watches; its outcome never travels back on this message.
 */
export async function startProcess(sessionId: string, estimate: CostEstimate | null): Promise<ProcessStartResult> {
  let started!: (r: ProcessStartResult) => void;
  const answer = new Promise<ProcessStartResult>((r) => (started = r));
  void runProcess(sessionId, estimate, (run_id) => started({ ok: true, run_id })).then(
    (r) => {
      if (!r.ok && r.run_id === null) started({ ok: false, run_id: null, code: r.code, error: r.error });
    },
    (e: unknown) =>
      started({ ok: false, run_id: null, code: 'api', error: e instanceof Error ? e.message : String(e) }),
  );
  return answer;
}

export async function runProcess(
  sessionId: string,
  estimate: CostEstimate | null,
  onStarted?: (runId: string) => void,
): Promise<RunResult> {
  const a = await llm('process');
  if (running.has(sessionId))
    return { ok: false, run_id: null, code: 'busy', error: 'Process is already running for this Session.' };
  running.add(sessionId);
  heartbeatWhileRunning();
  const id = crypto.randomUUID();
  const created = db.processRuns.add({
    id,
    session_id: sessionId,
    created_at: Date.now(),
    finished_at: null,
    status: 'running',
    model: a?.model ?? IN_CODE_MODEL,
    estimate,
    items: null,
    calls: [],
    second_pass: [],
    error: null,
    error_code: null,
  });
  try {
    await created;
  } catch (e) {
    running.delete(sessionId);
    heartbeatWhileRunning();
    throw e;
  }
  // In-progress cards: each chunk's row is rewritten as its items stream in. Writes queue in order per chunk
  // (IndexedDB runs read-write transactions on one store in the order they were created).
  const progress = (p: ChunkProgress) =>
    void db.processProgress
      .put({ ...p, run_id: id, session_id: sessionId, updated_at: Date.now() })
      .catch((e: unknown) => console.warn('process progress', e));
  const finish = async (changes: Partial<ProcessRunRow>) =>
    db.transaction('rw', db.processRuns, db.processProgress, async () => {
      await db.processRuns.update(id, changes);
      await db.processProgress.where('run_id').equals(id).delete();
    });
  onStarted?.(id);
  try {
    const doc = await loadSessionDocument(db, sessionId);
    const { vet } = await readProcessingSettings();
    const { media, note } = a ? await planMedia(doc, a, true) : { media: null, note: null };
    const result = a
      ? await a.adapter.process({
          doc,
          model: a.model,
          effort: a.effort,
          loadScreenshot,
          onProgress: progress,
          media,
          vet,
        })
      : processWithoutModel(doc, IN_CODE_MODEL);
    await finish({
      status: 'done',
      finished_at: Date.now(),
      items: result.items,
      calls: result.calls,
      second_pass: result.second_pass,
      video: result.video,
      notes: note ? [note] : [],
      pins_converted: result.pins_converted,
      pins_dropped: result.pins_dropped,
      windows: result.windows,
      duplicates_merged: result.duplicates_merged,
      dropped_annotations: result.dropped_annotations,
      unaccounted_annotations: result.unaccounted_annotations,
    });
    await queueItems(sessionId).catch((e: unknown) => console.warn('host: could not queue the items', e));
    return { ok: true, run_id: id, items: result.items.length };
  } catch (e) {
    const err = e instanceof ProcessError ? e : new ProcessError('api', e instanceof Error ? e.message : String(e));
    await finish({ status: 'failed', finished_at: Date.now(), error: err.message, error_code: err.code });
    return { ok: false, run_id: id, code: err.code, error: err.message };
  } finally {
    running.delete(sessionId);
    heartbeatWhileRunning();
  }
}

/**
 * A run still marked running when the service worker starts was cut off by a restart (Process runs only in the
 * worker, so nothing is carrying it on). Mark it failed and drop its in-progress cards.
 */
export async function sweepInterruptedRuns(): Promise<number> {
  return db.transaction('rw', db.processRuns, db.processProgress, async () => {
    const stale = await db.processRuns.filter((r) => r.status === 'running' && !running.has(r.session_id)).toArray();
    for (const r of stale) {
      await db.processRuns.update(r.id, {
        status: 'failed',
        finished_at: Date.now(),
        error: 'Process stopped because the extension restarted before it finished. Run it again.',
        error_code: 'interrupted',
      });
      await db.processProgress.where('run_id').equals(r.id).delete();
    }
    return stale.length;
  });
}

export type CombineItemsResult = { ok: true; changes: CombinedChanges } | { ok: false; code: string; error: string };

/**
 * Review page, right after a merge (E12): the merge model rewrites the two items as one. The page logs the answer
 * as an `edit` op, or keeps the concatenated merge on a failure. The calls go onto the run row with Process's.
 */
export async function combineItems({
  run_id,
  into,
  from,
}: { run_id: string } & Omit<CombineInput, 'model' | 'effort'>): Promise<CombineItemsResult> {
  const a = await llm('merge');
  if (!a) return noKey('merge');
  try {
    const { changes, calls } = await a.adapter.combine({ into, from, model: a.model, effort: a.effort });
    await db.processRuns
      .where('id')
      .equals(run_id)
      .modify((r) => void r.calls.push(...calls))
      .catch((e: unknown) => console.warn('combine calls', e));
    return { ok: true, changes };
  } catch (e) {
    const err = e instanceof ProcessError ? e : new ProcessError('api', e instanceof Error ? e.message : String(e));
    return { ok: false, code: err.code, error: err.message };
  }
}

/**
 * Options page, a provider's Test button: its saved key against the models the roles on it use (the provider's
 * default Process and Draft models when no role uses it).
 */
export async function testProvider(provider: LlmProvider): Promise<ConnectionTest> {
  const adapter = await adapterFor(provider);
  if (!adapter) return { ok: false, message: 'Save a key first.' };
  const settings = await readProcessingSettings();
  const used = MODEL_ROLES.filter((r) => settings[r].provider === provider).map((r) => settings[r].model);
  const models = used.length ? used : [DEFAULT_MODELS[provider].process, DEFAULT_MODELS[provider].draft];
  return adapter.test([...new Set(models)]);
}

/** Options page, after a key is saved: the provider's model list, cached in `modelLists`. */
export async function listModels(provider: LlmProvider): Promise<ListModelsResult> {
  const apiKey = await providerKey(provider);
  if (!apiKey) return { ok: false, error: 'Save a key first.' };
  const dev = await devOverrides.getValue();
  try {
    const models =
      provider === 'gateway'
        ? await listGatewayModels({ apiKey, baseURL: dev?.gatewayBaseUrl ?? GATEWAY_BASE_URL })
        : await listAnthropicModels({ apiKey, baseURL: dev?.anthropicBaseUrl ?? null });
    const list = { fetched_at: Date.now(), models };
    await modelLists.setValue({ ...(await modelLists.getValue()), [provider]: list });
    // A fresh list may bring new tags: find out again which models take video.
    if (provider === 'gateway') await modelCapabilities.setValue({});
    return { ok: true, list };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
