// Feedback batch 1, U4 proof: a long Session Processes in streamed chunks with in-progress cards, and a chunk that
// runs out of output tokens is split and recovers. The real service worker and adapter run against the local
// Anthropic stub (dev-only `anthropicBaseUrl`); the stub answers with the stand-in model that reads each chunk's
// script (tests/support/script-model.ts). The Session is seeded straight into IndexedDB.
import type { Page, Worker } from '@playwright/test';
import { buildLongSession } from '../../scripts/gen-long-session.ts';
import {
  type AnthropicStub,
  confirmAll,
  isVetRequest,
  messageReply,
  scriptOf,
  startAnthropicStub,
} from '../support/anthropic-stub';
import { scriptModel } from '../support/script-model';
import { expect, test } from './fixtures';
import { seedSession, storeRows } from './helpers/seed';

const MODEL = 'claude-sonnet-5';

async function useStub(sw: Worker, stub: AnthropicStub) {
  await sw.evaluate(async (base) => {
    const { devOverrides } = await chrome.storage.local.get('devOverrides');
    await chrome.storage.local.set({
      anthropicKey: 'sk-ant-e2e-stub-key',
      devOverrides: { ...(devOverrides ?? {}), anthropicBaseUrl: base },
    });
  }, stub.baseURL);
}

async function openSeeded(
  openExtensionPage: (path: string) => Promise<Page>,
  doc: ReturnType<typeof buildLongSession>['doc'],
  more?: (page: Page) => Promise<void>,
) {
  // The Sessions page opens (and so creates) the database; the review page then reads the seeded Session.
  const blank = await openExtensionPage('sessions.html');
  await expect
    .poll(() => blank.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === 'inkup')))
    .toBe(true);
  await seedSession(blank, doc);
  // Raw IndexedDB writes do not wake Dexie's live queries, so everything is written before the review page opens.
  await more?.(blank);
  await blank.close();
  return openExtensionPage(`review.html?session=${doc.session.id}`);
}

const expectedItems = (truth: ReturnType<typeof buildLongSession>['truth']) =>
  truth.annotations - truth.scratched.length - truth.silent.length;

test('a 40-minute Session streams in 4 parts: in-progress cards appear before the run ends, then the full merged list', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  const { doc, truth } = buildLongSession({ minutes: 40 });
  // ~150 characters every 40 ms: each part takes a few seconds to stream.
  const stub = await startAnthropicStub({
    deltaChars: 150,
    streamDelayMs: 40,
    onMessage: (req) =>
      messageReply(MODEL, isVetRequest(req) ? confirmAll(req) : JSON.stringify(scriptModel(scriptOf(req)))),
  });
  try {
    await useStub(serviceWorker, stub);
    const review = await openSeeded(openExtensionPage, doc);
    await expect(review.getByTestId('annotation')).toHaveCount(truth.annotations);

    await review.getByTestId('process-button').click();
    await expect(review.getByTestId('process-chunks')).toHaveText(', in 4 parts run two at a time');
    await review.getByTestId('process-confirm').click();

    // While it runs: 4 parts, finished items as read-only cards, a placeholder for the one being written, and no
    // final list yet.
    const progress = review.getByTestId('process-progress');
    await expect(progress.getByTestId('progress-chunk')).toHaveCount(4);
    await expect(progress.getByTestId('progress-chunk').first()).toContainText('Part 1 of 4');
    await expect(progress.getByTestId('progress-item').first()).toBeVisible();
    await expect(progress.getByTestId('progress-placeholder').first()).toBeVisible();
    await expect(review.getByTestId('process-running')).toBeVisible();
    expect(await review.getByTestId('change-item').count()).toBe(0);
    await expect(progress.locator('[data-testid="progress-chunk"][data-status="streaming"]')).toHaveCount(2);

    // Done: the merged, renumbered list replaces the cards; nothing lost.
    await expect(review.getByTestId('change-item')).toHaveCount(expectedItems(truth), { timeout: 60_000 });
    await expect(review.getByTestId('process-progress')).toHaveCount(0);
    await expect(review.getByTestId('process-coverage')).toContainText('processed in 4 parts');
    await expect(review.getByTestId('process-coverage')).not.toContainText('No item uses Annotation');
    const ids = await review
      .getByTestId('change-item')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-item-id')).sort());
    expect(ids).toEqual(
      Array.from({ length: expectedItems(truth) }, (_, i) => `item_${String(i + 1).padStart(4, '0')}`),
    );
    expect(stub.peakConcurrent()).toBe(2);
    expect(stub.messages().every((m) => m.body.stream === true && m.body.max_tokens === 128_000)).toBe(true);
    // The in-progress rows are scratch state: gone once the run is stored.
    expect(await storeRows(review, 'processProgress')).toEqual([]);
  } finally {
    await stub.close();
  }
});

test('a part that runs out of output tokens is split in two and retried; the Session still processes completely', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  // A dense 12-minute Session is one part; its answer (one token per character here) is ~30k tokens, and the stub
  // stops every answer at 20k, as a model whose thinking ate the budget would.
  const { doc, truth } = buildLongSession({ minutes: 12, everyMs: 12_000 });
  const stub = await startAnthropicStub({
    charsPerToken: 1,
    maxOutputTokens: 20_000,
    onMessage: (req) =>
      messageReply(MODEL, isVetRequest(req) ? confirmAll(req) : JSON.stringify(scriptModel(scriptOf(req)))),
  });
  try {
    await useStub(serviceWorker, stub);
    const review = await openSeeded(openExtensionPage, doc);
    await review.getByTestId('process-button').click();
    await expect(review.getByTestId('process-estimate')).toBeVisible();
    await expect(review.getByTestId('process-chunks')).toHaveCount(0);
    await review.getByTestId('process-confirm').click();
    await expect(review.getByTestId('change-item')).toHaveCount(expectedItems(truth), { timeout: 60_000 });
    await expect(review.getByTestId('process-error')).toHaveCount(0);
    await expect(review.getByTestId('process-coverage')).toContainText('processed in 2 parts');
    // One cut-off answer, then the two halves, then one check against the recording per half; the cut-off answer
    // was never sent back.
    const [main, vet] = [stub.messages().filter((m) => !isVetRequest(m)), stub.messages().filter(isVetRequest)];
    expect([main.length, vet.length]).toEqual([3, 2]);
    expect(stub.messages().every((m) => m.body.messages.length === 1)).toBe(true);
    const [run] = await storeRows<{ calls: { kind: string }[] }>(review, 'processRuns');
    expect(run!.calls.map((c) => c.kind).sort()).toEqual(['main', 'main', 'truncated', 'vet', 'vet']);
    // Every item was checked, in the half it came from.
    await expect(review.getByTestId('vetting')).toHaveCount(expectedItems(truth));
    await expect(review.locator('[data-testid="vetting"][data-verdict="confirmed"]')).toHaveCount(expectedItems(truth));
  } finally {
    await stub.close();
  }
});

test('a run left running by a restarted service worker is marked failed with a plain reason', async ({
  context,
  openExtensionPage,
}) => {
  const { doc } = buildLongSession({ minutes: 5 });
  const review = await openSeeded(openExtensionPage, doc, (page) =>
    page.evaluate(async (sessionId) => {
      const idb = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('inkup');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const tx = idb.transaction(['processRuns', 'processProgress'], 'readwrite');
      tx.objectStore('processRuns').put({
        id: 'run-stale',
        session_id: sessionId,
        created_at: Date.now(),
        finished_at: null,
        status: 'running',
        model: 'claude-sonnet-5',
        estimate: null,
        items: null,
        calls: [],
        second_pass: [],
        error: null,
        error_code: null,
      });
      tx.objectStore('processProgress').put({
        run_id: 'run-stale',
        session_id: sessionId,
        chunk: 0,
        start: 0,
        end: null,
        status: 'streaming',
        items: [],
        updated_at: Date.now(),
      });
      await new Promise<void>((res) => (tx.oncomplete = () => res()));
      idb.close();
    }, doc.session.id),
  );
  // Stop the service worker as Chrome does when it goes idle. The review page's keep-alive (sent while a run shows
  // as running) or the side panel starts a new one, which sweeps the stale run. The first worker never saw this row
  // being written, so any worker start is a restart for it.
  const cdp = await context.newCDPSession(review);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  const panel = await openExtensionPage('sidepanel.html');
  await panel.close();
  const again = await openExtensionPage(`review.html?session=${doc.session.id}`);
  await expect(again.getByTestId('process-error')).toContainText(
    'Process stopped because the extension restarted before it finished. Run it again.',
  );
  await expect(again.getByTestId('process-progress')).toHaveCount(0);
  expect(await storeRows(again, 'processProgress')).toEqual([]);
});

// Field bug (2026-09-23): "Process failed: Error: A listener indicated an asynchronous response by returning true, but
// the message channel closed before a response was received". The review page held one message open for the whole
// run, and Chrome ends an extension event after 5 minutes (and a worker idle for 30 s). Playwright keeps a debugger
// on the worker, which lifts those limits, so the kill itself cannot happen here. What is proven instead: the
// request is answered while the run is still streaming, the run finishes with the review page closed, and the worker
// calls an extension API on its own while the run lasts, which is what resets Chrome's idle timer.
test('Process answers as soon as the run starts, finishes with the review page closed, and keeps the worker alive itself', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  test.setTimeout(150_000);
  const { doc } = buildLongSession({ minutes: 5 });
  // Every answer streams in 100 deltas 250 ms apart: about 25 s, longer than the worker's 20 s heartbeat.
  const opts: Parameters<typeof startAnthropicStub>[0] = {
    streamDelayMs: 250,
    onMessage: (req) => {
      const text = isVetRequest(req) ? confirmAll(req) : JSON.stringify(scriptModel(scriptOf(req)));
      opts.deltaChars = Math.ceil(text.length / 100);
      return messageReply(MODEL, text);
    },
  };
  const stub = await startAnthropicStub(opts);
  try {
    await useStub(serviceWorker, stub);
    await serviceWorker.evaluate(() => {
      const g = globalThis as unknown as { __heartbeats: number };
      g.__heartbeats = 0;
      const original = chrome.runtime.getPlatformInfo.bind(chrome.runtime);
      (chrome.runtime as { getPlatformInfo: unknown }).getPlatformInfo = () => {
        g.__heartbeats++;
        return original();
      };
    });
    const review = await openSeeded(openExtensionPage, doc);
    const started = Date.now();
    const reply = await review.evaluate(
      (sessionId) =>
        chrome.runtime.sendMessage({
          id: 1,
          type: 'startProcess',
          data: { session_id: sessionId, estimate: null },
          timestamp: Date.now(),
        }) as Promise<{
          res?: { ok: boolean; run_id: string | null };
        }>,
      doc.session.id,
    );
    const answeredMs = Date.now() - started;
    expect(reply.res).toMatchObject({ ok: true, run_id: expect.any(String) });
    const [atReply] = await storeRows<{ id: string; status: string }>(review, 'processRuns');
    expect(atReply).toMatchObject({ id: reply.res!.run_id, status: 'running' });
    expect(answeredMs, 'answered long before the ~25 s answer finished streaming').toBeLessThan(5_000);

    // No page is waiting on the run any more.
    await review.close();
    const watcher = await openExtensionPage('sessions.html');
    await expect
      .poll(async () => (await storeRows<{ status: string }>(watcher, 'processRuns'))[0]?.status, {
        timeout: 120_000,
        intervals: [1_000],
      })
      .toBe('done');
    expect(Date.now() - started, 'the run outlasted one heartbeat period').toBeGreaterThan(20_000);
    expect(
      await serviceWorker.evaluate(() => (globalThis as unknown as { __heartbeats: number }).__heartbeats),
    ).toBeGreaterThanOrEqual(1);

    // Reopened, the page shows the run the worker finished on its own.
    const [run] = await storeRows<{ items: unknown[] }>(watcher, 'processRuns');
    expect(run!.items.length).toBeGreaterThan(0);
    const again = await openExtensionPage(`review.html?session=${doc.session.id}`);
    await expect(again.getByTestId('change-item')).toHaveCount(run!.items.length);
    await expect(again.getByTestId('process-error')).toHaveCount(0);
  } finally {
    await stub.close();
  }
});
