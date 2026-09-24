// Process in the service worker (PRD P0-11): estimate, run, store. The review page asks; the worker reads the
// key (storage.local), builds session.json from Dexie, runs the LLM adapter and writes a processRuns row that
// the page watches with useLiveQuery. A failure is recorded on the run and touches nothing else.
//
// Without a key (E11) Process still runs: the items are built in code (one per Annotation and Text Comment,
// packages/core/src/process/in-code.ts), with no estimate and no network call. The run's model is IN_CODE_MODEL.

import type { CombinedChanges } from '@inkup/core/process/combine';
import type { CostEstimate } from '@inkup/core/process/cost';
import {
  type ChunkProgress,
  type CombineInput,
  type ConnectionTest,
  createAnthropicAdapter,
  type LlmAdapter,
  ProcessError,
  processWithoutModel,
  type ScreenshotImage,
} from '@/adapters/llm';
import { db, type ProcessRunRow } from '@/db';
import { queueItems } from '@/db/outbox';
import { loadSessionDocument } from '@/db/session-export';
import { anthropicKey, DEFAULT_MERGE_MODEL, devOverrides, processingSettings } from '@/settings';

export type EstimateResult = { ok: true; estimate: CostEstimate } | { ok: false; code: string; error: string };
export type RunResult =
  | { ok: true; run_id: string; items: number }
  | { ok: false; run_id: string | null; code: string; error: string };

const running = new Set<string>();

/** The adapter with the saved key and models; null without a key. Process and the live Draft Item pass share it. */
export async function llm(): Promise<{
  adapter: LlmAdapter;
  processModel: string;
  draftModel: string;
  mergeModel: string;
} | null> {
  const key = (await anthropicKey.getValue()).trim();
  if (!key) return null;
  const { processModel, draftModel, mergeModel } = await processingSettings.getValue();
  const base = (await devOverrides.getValue())?.anthropicBaseUrl ?? null;
  return {
    adapter: createAnthropicAdapter({ apiKey: key, baseURL: base }),
    processModel,
    draftModel,
    mergeModel: mergeModel?.trim() || DEFAULT_MERGE_MODEL,
  };
}

const NO_KEY = {
  ok: false as const,
  code: 'no_key',
  error: 'Add an Anthropic API key in the extension options first.',
};

/** The processRuns `model` of a run built in code, without a key. */
export const IN_CODE_MODEL = 'none (built in code)';

export async function estimateProcess(sessionId: string): Promise<EstimateResult> {
  const a = await llm();
  if (!a) return NO_KEY;
  try {
    const doc = await loadSessionDocument(db, sessionId);
    return { ok: true, estimate: await a.adapter.estimate({ doc, model: a.processModel }) };
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

async function loadScreenshot(id: string): Promise<ScreenshotImage | null> {
  const row = await db.blobs.get(id);
  if (row?.kind !== 'screenshot') return null;
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
  const a = await llm();
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
    model: a?.processModel ?? IN_CODE_MODEL,
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
    const result = a
      ? await a.adapter.process({ doc, model: a.processModel, loadScreenshot, onProgress: progress })
      : processWithoutModel(doc, IN_CODE_MODEL);
    await finish({
      status: 'done',
      finished_at: Date.now(),
      items: result.items,
      calls: result.calls,
      second_pass: result.second_pass,
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
}: { run_id: string } & Omit<CombineInput, 'model'>): Promise<CombineItemsResult> {
  const a = await llm();
  if (!a) return NO_KEY;
  try {
    const { changes, calls } = await a.adapter.combine({ into, from, model: a.mergeModel });
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

export async function testAnthropic(): Promise<ConnectionTest> {
  const a = await llm();
  if (!a) return { ok: false, message: 'Save a key first.' };
  return a.adapter.test({ process: a.processModel, draft: a.draftModel });
}
