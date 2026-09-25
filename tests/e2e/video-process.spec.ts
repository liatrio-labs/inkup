// Video-grounded Process and vetting (PR D). A recorded Session is seeded with a video and an audio blob, and the
// Process role is set to the Vercel AI Gateway, which one local stub stands in for (the dev-only `gatewayBaseUrl`):
// - a model that takes video (a google/ model whose endpoints call lists "file") gets the recording through the
//   chat endpoint, the main call and the vetting call each carrying the video and audio as file parts;
// - over the cap (a dev override makes it tiny) the run falls back to the Messages API and says why;
// - a model that takes no video vets the items against their screenshots, as image blocks.
import { readFileSync } from 'node:fs';
import type { Page, Worker } from '@playwright/test';
import { type SessionDocument, SessionDocumentSchema } from '../../packages/core/src/session-document.ts';
import { fixtureFile } from '../../scripts/gen-session-fixtures.ts';
import {
  type AnthropicStub,
  chatReply,
  isVetRequest,
  messageReply,
  type StubRequest,
  scriptOf,
  startAnthropicStub,
} from '../support/anthropic-stub';
import { expect, test } from './fixtures';
import { seedSession } from './helpers/seed';

const GATEWAY_KEY = 'vck-e2e-video-spec';
const VIDEO_MODEL = 'google/gemini-3.1-pro-preview';
const TEXT_MODEL = 'anthropic/claude-sonnet-5';
const VIDEO_BYTES = 6000;
const AUDIO_BYTES = 3000;

const doc = SessionDocumentSchema.parse(JSON.parse(readFileSync(fixtureFile('a-move-here', 'word'), 'utf8')));

/** A valid item for the fixture Session: its Annotations #1 and #2 and screenshots s1 and s2. */
const item = (id: string, title: string) => ({
  id,
  title,
  category: 'layout',
  intent: 'The CTA belongs in the header, right of Docs.',
  locations: [
    {
      role: 'subject',
      selector: 'button.cta',
      element: "button 'Get started'",
      url: '/pricing.html',
      screenshot: 's1',
      annotation: 1,
    },
    {
      role: 'destination',
      selector: 'nav',
      element: "nav right of link 'Docs'",
      url: '/pricing.html',
      screenshot: 's2',
      annotation: 2,
    },
  ],
  evidence: { video: { start: 0.8, end: 9.3 }, screenshots: ['s1', 's2'] },
  transcript: 'okay so this button ... should go here in the header next to docs',
  confidence: 0.9,
  agent_prompt:
    'On /pricing.html move button.cta into the nav right of Docs. See screenshots/s1.png and screenshots/s2.png.',
  pinned: false,
});

const MAIN = JSON.stringify({ items: [item('item_0001', "Move 'Get started' into the header nav")] });
const VET = JSON.stringify({
  results: [
    {
      id: 'item_0001',
      verdict: 'corrected',
      reason: 'The footage shows the arrow ends at the nav.',
      item: item('item_0001', 'Move the Get started button right of Docs'),
    },
  ],
});

/** Answers Process and vetting on both endpoints; the Test buttons' 1-token calls get OK. */
async function stub(): Promise<AnthropicStub> {
  return startAnthropicStub({
    inputTokens: () => 3000,
    onMessage: (req) =>
      req.body.max_tokens === 1
        ? messageReply(req.body.model, 'OK', { input_tokens: 10, output_tokens: 1 })
        : messageReply(req.body.model, isVetRequest(req) ? VET : MAIN),
    onChat: (req) => chatReply(req.body.model, isVetRequest(req) ? VET : MAIN),
  });
}

async function configure(sw: Worker, stubbed: AnthropicStub, model: string, extra: Record<string, unknown> = {}) {
  await sw.evaluate(
    async ({ base, key, model, extra }) => {
      const { devOverrides } = await chrome.storage.local.get('devOverrides');
      await chrome.storage.local.set({
        devOverrides: { ...(devOverrides ?? {}), anthropicBaseUrl: base, gatewayBaseUrl: base, ...extra },
        gatewayKey: key,
        processingSettings: { process: { provider: 'gateway', model } },
      });
    },
    { base: stubbed.baseURL, key: GATEWAY_KEY, model, extra },
  );
}

/** The fixture Session with a video and an audio recording (bytes that only need to arrive intact). */
async function openWithRecording(openExtensionPage: (path: string) => Promise<Page>, session: SessionDocument) {
  const blank = await openExtensionPage('sessions.html');
  await expect
    .poll(() => blank.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === 'inkup')))
    .toBe(true);
  await seedSession(blank, session);
  await blank.evaluate(
    async ({ id, videoBytes, audioBytes }) => {
      const idb = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('inkup');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const bytes = (n: number, first: number) => Uint8Array.from({ length: n }, (_, i) => (i === 0 ? first : i % 251));
      const tx = idb.transaction(['sessions', 'blobs'], 'readwrite');
      const blob = (kind: 'video' | 'audio', mime: string, n: number, first: number) => ({
        id: `${id}:${kind}`,
        session_id: id,
        kind,
        mime,
        size: n,
        t: 0,
        seq: 0,
        blob: new Blob([bytes(n, first)], { type: mime }),
      });
      tx.objectStore('blobs').put(blob('video', 'video/webm;codecs=vp9', videoBytes, 0x1a));
      tx.objectStore('blobs').put(blob('audio', 'audio/webm;codecs=opus', audioBytes, 0x1b));
      const sessions = tx.objectStore('sessions');
      const row = await new Promise<Record<string, unknown>>((res) => {
        const r = sessions.get(id);
        r.onsuccess = () => res(r.result);
      });
      sessions.put({
        ...row,
        video: {
          blob_id: `${id}:video`,
          mime: 'video/webm;codecs=vp9',
          start_offset_ms: 350,
          duration_ms: 12_000,
          chunk_count: 1,
          seekable: true,
          label: 'Pricing',
          width: 1280,
          height: 720,
          path: 'video.webm',
        },
        audio: {
          blob_id: `${id}:audio`,
          mime: 'audio/webm;codecs=opus',
          start_offset_ms: 120,
          duration_ms: 12_000,
          chunk_count: 1,
          path: 'audio.webm',
        },
      });
      await new Promise<void>((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      idb.close();
    },
    { id: session.session.id, videoBytes: VIDEO_BYTES, audioBytes: AUDIO_BYTES },
  );
  await blank.close();
  return openExtensionPage(`review.html?session=${session.session.id}`);
}

async function runProcess(review: Page) {
  await review.getByTestId('process-button').click();
  await expect(review.getByTestId('process-estimate')).toBeVisible();
  await review.getByTestId('process-confirm').click();
  await expect(review.getByTestId('change-item')).toHaveCount(1, { timeout: 30_000 });
}

const fileParts = (req: StubRequest) =>
  (req.body.messages[1].content as { type: string; file?: { filename: string; file_data: string } }[]).filter(
    (p) => p.type === 'file',
  );
const processCalls = (s: AnthropicStub) => s.messages().filter((m) => m.body.max_tokens !== 1);

test('a model that takes video gets the recording through the chat endpoint, and the items are vetted on it', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  test.setTimeout(90_000);
  const s = await stub();
  try {
    await configure(serviceWorker, s, VIDEO_MODEL);
    const review = await openWithRecording(openExtensionPage, doc);
    await review.getByTestId('process-button').click();
    await expect(review.getByTestId('process-estimate')).toContainText('the recording goes with each call');
    await expect(review.getByTestId('process-estimate')).toContainText('includes checking every item');
    await review.getByTestId('process-confirm').click();
    await expect(review.getByTestId('change-item')).toHaveCount(1, { timeout: 30_000 });

    // The capability came from the model's endpoints call (a google/ model that takes files).
    expect(s.requests.some((r) => r.path === `/v1/models/${VIDEO_MODEL}/endpoints`)).toBe(true);
    expect(processCalls(s)).toHaveLength(0);
    const chats = s.chats();
    expect(chats).toHaveLength(2);
    const [main, vet] = chats as [StubRequest, StubRequest];
    expect(isVetRequest(main)).toBe(false);
    expect(isVetRequest(vet)).toBe(true);
    for (const req of chats) {
      expect(req.headers.authorization).toBe(`Bearer ${GATEWAY_KEY}`);
      expect(req.body.model).toBe(VIDEO_MODEL);
      const files = fileParts(req);
      expect(files.map((f) => f.file!.filename)).toEqual(['video.webm', 'audio.webm']);
      expect(files[0]!.file!.file_data).toMatch(/^data:video\/webm;base64,/);
      expect(files[1]!.file!.file_data).toMatch(/^data:audio\/webm;base64,/);
      // The bytes arrive intact: the seeded first byte and length.
      const video = Buffer.from(files[0]!.file!.file_data.split(',')[1]!, 'base64');
      expect([video.length, video[0]]).toEqual([VIDEO_BYTES, 0x1a]);
      const audio = Buffer.from(files[1]!.file!.file_data.split(',')[1]!, 'base64');
      expect([audio.length, audio[0]]).toEqual([AUDIO_BYTES, 0x1b]);
      expect(scriptOf(req)).toContain('(start_offset_ms 350)');
    }
    expect(main.body.messages[0].content).toContain('## Recording (attached)');

    const card = review.getByTestId('change-item');
    await expect(card.getByTestId('item-title')).toHaveText('Move the Get started button right of Docs');
    await expect(card.getByTestId('vetting')).toHaveAttribute('data-verdict', 'corrected');
    await expect(card.getByTestId('vetting')).toHaveText('Corrected: The footage shows the arrow ends at the nav.');
    await expect(review.getByTestId('process-video')).toBeVisible();
    await expect(review.getByTestId('process-note')).toHaveCount(0);
  } finally {
    await s.close();
  }
});

test('over the size cap, Process falls back to the script and screenshots and says so', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  test.setTimeout(90_000);
  const s = await stub();
  try {
    await configure(serviceWorker, s, VIDEO_MODEL, { videoInlineMaxBytes: 4000 });
    const review = await openWithRecording(openExtensionPage, doc);
    await runProcess(review);
    expect(s.chats()).toHaveLength(0);
    const calls = processCalls(s);
    expect(calls).toHaveLength(2);
    expect(calls.map(isVetRequest)).toEqual([false, true]);
    await expect(review.getByTestId('process-note')).toContainText('The recording (8.8 KB');
    await expect(review.getByTestId('process-video')).toHaveCount(0);
    await expect(review.getByTestId('vetting')).toHaveAttribute('data-verdict', 'corrected');
  } finally {
    await s.close();
  }
});

test('a model that takes no video vets the items against their screenshots', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  test.setTimeout(90_000);
  const s = await stub();
  try {
    await configure(serviceWorker, s, TEXT_MODEL);
    const review = await openWithRecording(openExtensionPage, doc);
    await runProcess(review);
    expect(s.chats()).toHaveLength(0);
    const [main, vet] = processCalls(s) as [StubRequest, StubRequest];
    expect(isVetRequest(main)).toBe(false);
    expect(isVetRequest(vet)).toBe(true);
    expect(vet.headers['x-api-key']).toBe(GATEWAY_KEY);
    const content = vet.body.messages[0].content as { type: string; text?: string; source?: { media_type: string } }[];
    const images = content.filter((b) => b.type === 'image');
    expect(images).toHaveLength(2);
    expect(images[0]!.source!.media_type).toBe('image/png');
    expect(content.filter((b) => b.type === 'text').map((b) => b.text)).toEqual(
      expect.arrayContaining(['Screenshot s1:', 'Screenshot s2:']),
    );
    await expect(review.getByTestId('vetting')).toHaveAttribute('data-verdict', 'corrected');
    await expect(review.getByTestId('process-notes')).toHaveCount(0);
  } finally {
    await s.close();
  }
});

test('turning the check off in the options: Process makes no vetting call and the cards carry no verdict', async ({
  serviceWorker,
  openExtensionPage,
}) => {
  test.setTimeout(90_000);
  const s = await stub();
  try {
    await configure(serviceWorker, s, TEXT_MODEL);
    const options = await openExtensionPage('options.html');
    await expect(options.getByTestId('vet-items')).toBeChecked();
    await options.getByTestId('vet-items').uncheck();
    await options.getByTestId('save-processing').click();
    await expect(options.getByRole('status')).toHaveText('Saved.');
    expect(
      await serviceWorker.evaluate(
        async () =>
          ((await chrome.storage.local.get('processingSettings')).processingSettings as { vet?: boolean }).vet,
      ),
    ).toBe(false);
    await options.close();

    const review = await openWithRecording(openExtensionPage, doc);
    await review.getByTestId('process-button').click();
    await expect(review.getByTestId('process-estimate')).not.toContainText('includes checking');
    await review.getByTestId('process-confirm').click();
    await expect(review.getByTestId('change-item')).toHaveCount(1, { timeout: 30_000 });
    expect(processCalls(s).map(isVetRequest)).toEqual([false]);
    await expect(review.getByTestId('vetting')).toHaveCount(0);
  } finally {
    await s.close();
  }
});
