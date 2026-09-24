// Slice 6 proof: the paid transcription tiers end to end, through the real offscreen audio graph (16 kHz
// AudioContext + pcm16 worklet), the real vendor SDKs and the local vendor stubs (tests/support/stt-stubs.ts),
// reached through the dev-only base URL overrides. The fake mic plays fixtures/audio/voice-session.wav.
//
// - Better (Deepgram): options page tier pick shows the vendor notice once, the key is saved masked and Test
//   mints a real token from the stub; a Session streams linear16 at 16 kHz on a bearer-token socket, and its
//   segments are word-level with monotonic words on the Session clock.
// - Best (ElevenLabs): the same through Scribe's manual audio mode and a single-use token.
// - The stub drops every socket 4 times: 3 retries, then one transcription_fallback and the Session goes on.
// - Re-transcribe from the review page through Deepgram's pre-recorded endpoint: a new run the page shows.
import { readFileSync } from 'node:fs';
import type { Page, Worker } from '@playwright/test';
import { SessionDocumentSchema } from '../../packages/core/src/session-document.ts';
import type { EventOf, TimelineEvent } from '../../packages/core/src/timeline.ts';
import { type SttStub, startDeepgramStub, startElevenLabsStub } from '../support/stt-stubs';
import { expect, grantMic, test } from './fixtures';
import { ofType, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'voice-session.wav' });

const KEY = 'stub-key-0123456789abcdef';
const SCRIPT = 'this button should go in the header make this card taller';

let stub: SttStub | null = null;
test.afterEach(async () => {
  await stub?.close();
  stub = null;
});

async function setOverrides(sw: Worker, overrides: Record<string, unknown>) {
  await sw.evaluate((o) => chrome.storage.local.set({ devOverrides: o }), overrides);
}

/** The radio is controlled by storage: it flips once the write comes back, so click and wait for it. */
async function pickTier(options: Page, tier: string) {
  await options.getByTestId(`tier-${tier}`).click();
  await expect(options.getByTestId(`tier-${tier}`)).toBeChecked();
}

/** Picks the tier on the options page, saves the key, and runs Test (a real token mint against the stub). */
async function configureTier(openExtensionPage: (p: string) => Promise<Page>, tier: 'better' | 'best'): Promise<void> {
  const vendor = tier === 'better' ? 'deepgram' : 'elevenlabs';
  const options = await openExtensionPage('options.html');
  await pickTier(options, tier);
  const notice = options.getByTestId('vendor-notice');
  await expect(notice).toContainText(`Your audio goes to ${tier === 'better' ? 'Deepgram' : 'ElevenLabs'}`);
  await options.getByRole('button', { name: 'Got it' }).click();
  // Shown once: picking the tier again does not bring it back.
  await pickTier(options, 'free');
  await pickTier(options, tier);
  await expect(notice).toHaveCount(0);

  await options.getByTestId(`${vendor}-key`).fill(KEY);
  await options.getByTestId(`save-${vendor}`).click();
  await expect(options.getByTestId(`${vendor}-key`)).toHaveAttribute('placeholder', /Saved \(stub…cdef\)/);
  await options.getByTestId(`test-${vendor}`).click();
  await expect(options.getByTestId(`test-${vendor}-result`)).toContainText('OK:');
  await options.close();
}

async function record(
  context: import('@playwright/test').BrowserContext,
  site: { primaryOrigin: string },
  openExtensionPage: (p: string) => Promise<Page>,
  ms: number,
  during?: (panel: Page) => Promise<void>,
) {
  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  const panel = await openExtensionPage('sidepanel.html');
  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  const startedAt = Date.now();
  await during?.(panel);
  await panel.waitForTimeout(Math.max(0, ms - (Date.now() - startedAt)));
  const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await panel.getByTestId('stop').click();
  const review = await reviewPromise;
  await expect(review.getByRole('heading', { name: 'Session review' })).toBeVisible();
  const sessionId = new URL(review.url()).searchParams.get('session')!;
  return { panel, review, sessionId, events: await sessionEvents(review, sessionId) };
}

function expectWordSegments(events: TimelineEvent[], engine: string) {
  const end = ofType(events, 'session_end')[0]!;
  const segs = ofType(events, 'transcript_segment').filter((s) => s.run_id === null);
  expect(segs.length).toBeGreaterThan(1);
  for (const s of segs) {
    expect(s).toMatchObject({ engine, local: false, timestamp_quality: 'word' });
    expect(s.words!.length).toBeGreaterThan(0);
  }
  const words = segs.flatMap((s) => s.words!);
  const starts = words.map((w) => w.t);
  expect(starts).toEqual([...starts].sort((a, b) => a - b));
  for (const w of words) {
    expect(w.t_end).toBeGreaterThanOrEqual(w.t);
    expect(w.t_end).toBeLessThanOrEqual(end.t);
  }
  expect(
    words
      .slice(0, 7)
      .map((w) => w.text)
      .join(' '),
  ).toBe('this button should go in the header');
  return { segs, words, end };
}

/** Audio that reached the stub ≈ 32,000 bytes (16 kHz × 2 bytes) per second streamed: proves the PCM16 graph's rate. */
function expectPcm16Rate(stub: SttStub, streamedMs: number) {
  const bytes = stub.sockets.reduce((n, s) => n + s.audioBytes, 0);
  const rate = bytes / (streamedMs / 1000);
  expect(rate).toBeGreaterThan(32000 * 0.75);
  expect(rate).toBeLessThan(32000 * 1.15);
}

test('Better tier: Deepgram streams 16 kHz PCM16 on a minted token and logs word-level segments', async ({
  context,
  site,
  openExtensionPage,
  serviceWorker,
}) => {
  test.setTimeout(90_000);
  stub = await startDeepgramStub({ key: KEY, script: SCRIPT });
  await setOverrides(serviceWorker, { deepgramBaseUrl: stub.baseURL });
  await grantMic(openExtensionPage);
  await configureTier(openExtensionPage, 'better');

  const { events, review, sessionId } = await record(context, site, openExtensionPage, 8000, async (panel) => {
    await expect(panel.getByTestId('active-engine')).toContainText('Deepgram Nova-3');
    // Captions come from the stub's finals as they arrive over the socket.
    await expect(panel.getByTestId('captions')).toContainText('this button', { timeout: 8000 });
  });
  expectWordSegments(events, 'deepgram');
  const grant = stub.rest.find((r) => r.path === '/v1/auth/grant')!;
  expect(JSON.parse(grant.body.toString())).toEqual({ ttl_seconds: 60 });
  expect(stub.sockets).toHaveLength(1);
  const socket = stub.sockets[0]!;
  expect(socket.protocols[0]).toBe('bearer');
  expect(socket.protocols).not.toContain(KEY);
  expect(socket.query).toMatchObject({
    model: 'nova-3',
    encoding: 'linear16',
    sample_rate: '16000',
    interim_results: 'true',
  });
  expect(socket.closeCode).toBe(1000); // CloseStream on Stop, not a drop
  expectPcm16Rate(stub, socket.closedAt! - socket.openedAt);
  expect(ofType(events, 'transcription_fallback')).toEqual([]);

  const [session] = await review.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>(
      (res) => (indexedDB.open('inkup').onsuccess = (e) => res((e.target as IDBOpenDBRequest).result)),
    );
    return new Promise<unknown[]>(
      (res) =>
        (idb.transaction('sessions').objectStore('sessions').get(id).onsuccess = (e) =>
          res([(e.target as IDBRequest).result])),
    );
  }, sessionId);
  expect((session as { transcription: unknown }).transcription).toEqual({
    engine: 'deepgram',
    local: false,
    timestamp_quality: 'word',
  });
  // The key never lands in the Session.
  expect(JSON.stringify(events)).not.toContain(KEY);
});

test('Best tier: ElevenLabs Scribe streams pcm_16000 on a single-use token and logs word-level segments', async ({
  context,
  site,
  openExtensionPage,
  serviceWorker,
}) => {
  test.setTimeout(90_000);
  stub = await startElevenLabsStub({ key: KEY, script: SCRIPT });
  await setOverrides(serviceWorker, { elevenlabsBaseUrl: stub.baseURL });
  await grantMic(openExtensionPage);
  await configureTier(openExtensionPage, 'best');

  const { events } = await record(context, site, openExtensionPage, 8000, async (panel) => {
    await expect(panel.getByTestId('active-engine')).toContainText('ElevenLabs Scribe');
  });
  expectWordSegments(events, 'elevenlabs');
  // Test minted one token, the Session another; each opens one socket.
  expect(stub.rest.filter((r) => r.path === '/v1/single-use-token/realtime_scribe')).toHaveLength(2);
  expect(stub.sockets).toHaveLength(1);
  const socket = stub.sockets[0]!;
  expect(socket.query).toMatchObject({
    model_id: 'scribe_v2_realtime',
    token: 'sutkn_stub2',
    audio_format: 'pcm_16000',
    commit_strategy: 'vad',
    include_timestamps: 'true',
  });
  expectPcm16Rate(stub, socket.closedAt! - socket.openedAt);
  expect(JSON.stringify(events)).not.toContain(KEY);
});

test('four dropped sockets: three retries, one fallback to the free default, and the Session continues', async ({
  context,
  site,
  openExtensionPage,
  serviceWorker,
}) => {
  test.setTimeout(90_000);
  stub = await startDeepgramStub({ key: KEY, script: SCRIPT, dropAfterMs: 400, dropConnections: 4 });
  await setOverrides(serviceWorker, { deepgramBaseUrl: stub.baseURL, sttRetryBaseMs: 100 });
  await serviceWorker.evaluate(
    (key) =>
      chrome.storage.local.set({
        transcriptionSettings: { tier: 'better', freeEngine: 'webspeech', whisperModel: 'base' },
        deepgramKey: key,
      }),
    KEY,
  );
  await grantMic(openExtensionPage);

  const { events, review } = await record(context, site, openExtensionPage, 9000, async (panel) => {
    // Headless Chromium has no on-device speech pack, so the free default has no captions (privacy rule: no server speech).
    await expect(panel.getByTestId('captions-off')).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByTestId('active-engine')).toContainText('off');
    await expect(panel.getByTestId('status')).toHaveText('Recording');
  });
  expect(stub.sockets).toHaveLength(4);
  expect(stub.sockets.every((s) => s.closeCode === 1011)).toBe(true);
  const fallbacks = ofType(events, 'transcription_fallback');
  expect(fallbacks).toEqual([
    expect.objectContaining({ from: 'deepgram', to: 'none', reason: expect.stringContaining('socket_closed: 1011') }),
  ]);
  expect(fallbacks[0]!.reason).toContain('after 3 retries');
  // Segments heard before the fallback are kept; the Session ended normally with its audio.
  const end = ofType(events, 'session_end')[0]!;
  expect(end.reason).toBe('stop');
  expect(fallbacks[0]!.t).toBeLessThan(end.t);
  const meta = await review.getByTestId('session-meta').textContent();
  expect(meta).toContain('audio');
});

test('re-transcribe from the review page makes a new run through Deepgram pre-recorded, and the page shows it', async ({
  context,
  site,
  openExtensionPage,
  serviceWorker,
}) => {
  test.setTimeout(90_000);
  stub = await startDeepgramStub({ key: KEY, script: SCRIPT, batchSeconds: 5 });
  // The live Session uses the free tier (no captions headless); the Deepgram key is only for the re-run.
  await setOverrides(serviceWorker, { deepgramBaseUrl: stub.baseURL });
  await serviceWorker.evaluate((key) => chrome.storage.local.set({ deepgramKey: key }), KEY);
  await grantMic(openExtensionPage);

  const { review, sessionId } = await record(context, site, openExtensionPage, 6000);
  await expect(review.getByTestId('transcript-run')).toHaveAttribute('data-run-id', 'live');
  await review.getByTestId('retranscribe-engine').selectOption('deepgram');
  await review.getByTestId('retranscribe').click();
  await expect(review.getByTestId('retranscribe-status')).toContainText('New transcript', { timeout: 20_000 });

  // The pre-recorded request carried the stored audio with the key as `Token` auth.
  const req = stub.rest.find((r) => r.method === 'POST' && r.path === '/v1/listen')!;
  expect(req.headers.authorization).toBe(`Token ${KEY}`);
  expect(req.query).toMatchObject({ model: 'nova-3', utterances: 'true' });
  expect(req.body.length).toBeGreaterThan(10_000);
  expect(String(req.headers['content-type'])).toContain('audio/webm');

  const events = await sessionEvents(review, sessionId);
  const run = ofType(events, 'transcription_run')[0]!;
  expect(run).toMatchObject({ engine: 'deepgram', model: 'nova-3', local: false, timestamp_quality: 'word' });
  const segs = ofType(events, 'transcript_segment').filter(
    (s): s is EventOf<'transcript_segment'> => s.run_id === run.run_id,
  );
  expect(segs.length).toBe(run.segment_count);
  expect(segs.length).toBeGreaterThan(1);
  const words = segs.flatMap((s) => s.words!);
  expect(words.map((w) => w.t)).toEqual(words.map((w) => w.t).sort((a, b) => a - b));

  // The review page switched to the new run and shows its segments.
  await expect(review.getByTestId('transcript-run')).toHaveAttribute('data-run-id', run.run_id);
  await expect(review.getByTestId('transcript-segment')).toHaveCount(segs.length);
  await expect(review.getByTestId('segment-text').first()).toHaveValue(segs[0]!.text);
  expect(segs.map((s) => s.text).join(' ')).toContain('this button should go in the header');
  // session.json still validates and carries both runs.
  const doc = SessionDocumentSchema.parse(await downloadDoc(review, serviceWorker));
  expect(doc.events.filter((e) => e.type === 'transcription_run')).toHaveLength(1);
  expect(doc.events.filter((e) => e.type === 'transcript_segment' && e.run_id === run.run_id)).toHaveLength(
    segs.length,
  );

  // Switching back to the live run is one click and is logged.
  await review.getByTestId('transcript-run-select').selectOption('live');
  await expect(review.getByTestId('transcript-run')).toHaveAttribute('data-run-id', 'live');
  expect(ofType(await sessionEvents(review, sessionId), 'transcript_select').at(-1)).toMatchObject({ run_id: null });

  // With the media deleted (after an export, P0-13) there is nothing to re-transcribe.
  await review.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>(
      (res) => (indexedDB.open('inkup').onsuccess = (e) => res((e.target as IDBOpenDBRequest).result)),
    );
    const store = idb.transaction('sessions', 'readwrite').objectStore('sessions');
    await new Promise<void>((res) => {
      store.get(id).onsuccess = (e) => {
        const row = (e.target as IDBRequest).result;
        store.put({ ...row, audio: null, video: null, media_deleted_at: new Date().toISOString() }).onsuccess = () =>
          res();
      };
    });
  }, sessionId);
  await review.reload();
  await expect(review.getByTestId('retranscribe')).toBeDisabled();
  await expect(review.getByTestId('retranscribe-off')).toContainText('deleted after an export');
});

/** Downloads session.json through the review page's button and reads the file chrome.downloads wrote. */
async function downloadDoc(review: Page, sw: Worker): Promise<unknown> {
  await review.evaluate(() => delete document.body.dataset.downloadId);
  await review.getByTestId('download-session').click();
  const id = Number(
    await review.evaluate(async () => {
      for (let i = 0; i < 50 && !document.body.dataset.downloadId; i++) await new Promise((r) => setTimeout(r, 100));
      return document.body.dataset.downloadId;
    }),
  );
  await expect
    .poll(() => sw.evaluate(async (i) => (await chrome.downloads.search({ id: i }))[0]?.state, id))
    .toBe('complete');
  const file = await sw.evaluate(async (i) => (await chrome.downloads.search({ id: i }))[0]!.filename, id);
  return JSON.parse(readFileSync(file, 'utf8'));
}
