// Slice 7 proof (docs/PLAN.md, PRD P0-15): what leaves the machine, observed from every context of the extension.
//
// A second DevTools client (helpers/network-log.ts) records every request and WebSocket from the service worker,
// the offscreen document, the side panel, options and review pages, and the web page with the content script.
// A positive control first makes one request from each of those contexts to a local control server and checks
// the log saw it, so "no request" below means "none was made", not "none was seen".
//
// - Free tier, no Anthropic key: a full Session, Stop, review and Export reach only the fixture site.
// - Better tier: only the Deepgram stub is contacted besides the fixture site.
// - Local Whisper: huggingface.co is contacted only after Download is clicked in options (routed to a stub reply).
// - Keys for every vendor never appear in session.json, the export zip, any console, or the stored rows.
//
// Chrome's server speech runs in the browser process, outside any target: it is covered by the adapter unit tests
// (no recognizer is ever constructed without the opt-in) and here by the `to: none` fallback event.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { type AnthropicStub, messageReply, startAnthropicStub } from '../support/anthropic-stub';
import { type SttStub, startDeepgramStub } from '../support/stt-stubs';
import { expect, grantMic, test } from './fixtures';
import { circle } from './helpers/draw';
import { NetworkLog, type ObservedRequest, outsiders } from './helpers/network-log';
import { activeSessionId, ofType, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'voice-session.wav', extraArgs: ['--remote-debugging-port=0'] });

const VENDOR_HOSTS =
  /huggingface\.co|hf\.co|deepgram\.com|elevenlabs\.io|anthropic\.com|vercel\.sh|google\.com|googleapis\.com|gstatic\.com|jsdelivr\.net/;

/** A local server the positive-control probes hit. */
async function startControl(): Promise<{ origin: string; hits: string[]; close(): Promise<void> }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' }).end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const probe = (url: string) => `fetch(${JSON.stringify(url)}).then((r) => r.status)`;

/**
 * One request from each context, and proof the log attributed each to the right kind of target. The offscreen
 * document exists only during a Session.
 */
async function positiveControl(net: NetworkLog, control: string, sw: Worker, pages: Record<string, Page>) {
  expect(await sw.evaluate((u) => fetch(u).then((r) => r.status), `${control}/probe/service-worker`)).toBe(200);
  const offscreen = net.sessionFor((t) => t.url.endsWith('/offscreen.html'));
  expect(offscreen, `offscreen target among ${JSON.stringify(net.targets())}`).not.toBeNull();
  expect(await net.evaluate(offscreen!, probe(`${control}/probe/offscreen`))).toBe(200);
  for (const [name, page] of Object.entries(pages))
    expect(await page.evaluate((u) => fetch(u).then((r) => r.status), `${control}/probe/${name}`)).toBe(200);
  await expect
    .poll(() =>
      net.requests
        .filter((r) => r.url.startsWith(`${control}/probe/`))
        .map((r) => `${r.url.slice(control.length + 7)}@${r.target.type}`)
        .sort(),
    )
    .toEqual(
      [
        'service-worker@service_worker',
        `offscreen@${net.targets().find((t) => t.url.endsWith('/offscreen.html'))!.type}`,
        ...Object.keys(pages).map((n) => `${n}@page`),
      ].sort(),
    );
  // The offscreen document is its own target, not a page Playwright drives.
  expect(net.targets().find((t) => t.url.endsWith('/offscreen.html'))!.url).toMatch(/^chrome-extension:\/\//);
}

const describe = (rs: readonly ObservedRequest[]) =>
  rs.map((r) => `${r.kind} ${r.url} from ${r.target.type} ${r.target.url}`).join('\n');

async function exportZip(review: Page, sw: Worker): Promise<{ zip: string; dir: string }> {
  await review.getByTestId('export-zip').click();
  await expect(review.getByTestId('export-done')).toBeVisible({ timeout: 30_000 });
  const id = Number(await review.evaluate(() => document.body.dataset.exportDownloadId));
  await expect
    .poll(() => sw.evaluate(async (i) => (await chrome.downloads.search({ id: i }))[0]?.state, id))
    .toBe('complete');
  const zip = await sw.evaluate(async (i) => (await chrome.downloads.search({ id: i }))[0]!.filename, id);
  const dir = mkdtempSync(join(tmpdir(), 'var-privacy-'));
  execFileSync('unzip', ['-q', zip, '-d', dir]);
  return { zip, dir };
}

async function downloadSessionJson(review: Page, sw: Worker): Promise<string> {
  await review.evaluate(() => delete document.body.dataset.downloadId);
  await review.getByTestId('download-session').click();
  await expect.poll(() => review.evaluate(() => document.body.dataset.downloadId ?? null)).not.toBeNull();
  const id = Number(await review.evaluate(() => document.body.dataset.downloadId));
  await expect
    .poll(() => sw.evaluate(async (i) => (await chrome.downloads.search({ id: i }))[0]?.state, id))
    .toBe('complete');
  return readFileSync(
    await sw.evaluate(async (i) => (await chrome.downloads.search({ id: i }))[0]!.filename, id),
    'utf8',
  );
}

/** Every row of every IndexedDB store, serialized (Blobs as their size). */
function dumpDatabase(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const out: Record<string, unknown[]> = {};
    for (const name of Array.from(idb.objectStoreNames)) {
      out[name] = await new Promise<unknown[]>((res, rej) => {
        const r = idb.transaction(name).objectStore(name).getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return JSON.stringify(out, (_k, v) => (v instanceof Blob ? `[Blob ${v.size}]` : v));
  });
}

/** Opens the pricing page and the panel, starts a Session and draws one circle on the CTA. */
async function startAndDraw(
  context: BrowserContext,
  primaryOrigin: string,
  openExtensionPage: (p: string) => Promise<Page>,
) {
  const pricing = await context.newPage();
  await pricing.goto(`${primaryOrigin}/pricing.html`);
  const panel = await openExtensionPage('sidepanel.html');
  await pricing.bringToFront();
  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  await panel.getByTestId('draw-toggle').click();
  await pricing.bringToFront();
  await circle(pricing, (await pricing.locator('button.cta').boundingBox())!);
  await expect(panel.getByTestId('annotation-count')).toHaveText('1', { timeout: 10_000 });
  return { pricing, panel };
}

async function stop(context: BrowserContext, panel: Page): Promise<Page> {
  const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await panel.getByTestId('stop').click();
  const review = await reviewPromise;
  await expect(review.getByTestId('session-name')).toBeVisible();
  return review;
}

let net: NetworkLog | null = null;
let control: Awaited<ReturnType<typeof startControl>> | null = null;
test.afterEach(async () => {
  net?.close();
  net = null;
  await control?.close();
  control = null;
});

test('Free tier with no Anthropic key: a full Session, review and Export contact nothing but the site under review', async ({
  context,
  serviceWorker,
  userDataDir,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  net = await NetworkLog.attach(userDataDir);
  control = await startControl();
  await grantMic(openExtensionPage);
  const { pricing, panel } = await startAndDraw(context, site.primaryOrigin, openExtensionPage);
  const sessionId = (await activeSessionId(serviceWorker))!;
  // Positive control while every context is alive, the offscreen document included.
  await positiveControl(net, control.origin, serviceWorker, { panel, content: pricing });

  const review = await stop(context, panel);
  await review.evaluate((u) => fetch(u).then((r) => r.status), `${control.origin}/probe/review`);
  await expect
    .poll(() => net!.requests.some((r) => r.url.endsWith('/probe/review') && r.target.type === 'page'))
    .toBe(true);
  await exportZip(review, serviceWorker);
  await downloadSessionJson(review, serviceWorker);

  // Speech stayed on the device: without the pack there are no captions, and no server recognizer.
  const events = await sessionEvents(review, sessionId);
  expect(ofType(events, 'transcription_fallback')).toEqual([
    expect.objectContaining({ from: 'webspeech-on-device', to: 'none' }),
  ]);

  // The only requests outside the site under review are the control probes: the detector flags them (so it would
  // flag a real leak from the worker or the offscreen document), and nothing else went out.
  const leaks = outsiders(net.requests, [site.primaryOrigin, site.secondOrigin]);
  expect(leaks.map((r) => r.url).sort(), describe(leaks)).toEqual(
    ['content', 'offscreen', 'panel', 'review', 'service-worker'].map((n) => `${control!.origin}/probe/${n}`),
  );
  expect(net.requests.filter((r) => VENDOR_HOSTS.test(r.url))).toEqual([]);
  // The log saw real traffic: the fixture pages themselves, and the extension's own files.
  expect(net.requests.some((r) => r.url.startsWith(site.primaryOrigin))).toBe(true);
  expect(
    net.requests.some((r) => r.url.startsWith('chrome-extension://') && r.target.url.endsWith('/offscreen.html')),
  ).toBe(true);
});

test('Better tier: only the Deepgram stub is contacted besides the site under review', async ({
  context,
  serviceWorker,
  userDataDir,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  net = await NetworkLog.attach(userDataDir);
  const KEY = 'dg-privacy-key-0123456789abcdef';
  const stub: SttStub = await startDeepgramStub({ key: KEY, script: 'this button should go in the header' });
  try {
    await serviceWorker.evaluate(
      async ({ base, key }) => {
        await chrome.storage.local.set({
          devOverrides: { deepgramBaseUrl: base },
          deepgramKey: key,
          transcriptionSettings: { tier: 'better', freeEngine: 'webspeech', whisperModel: 'base' },
          vendorNoticeShown: { deepgram: true, elevenlabs: false },
        });
      },
      { base: stub.baseURL, key: KEY },
    );
    await grantMic(openExtensionPage);
    const { panel } = await startAndDraw(context, site.primaryOrigin, openExtensionPage);
    await expect(panel.getByTestId('active-engine')).toContainText('Deepgram');
    await expect(panel.getByTestId('captions')).toContainText('this button', { timeout: 10_000 });
    const review = await stop(context, panel);
    await exportZip(review, serviceWorker);

    const toStub = net.requests.filter((r) => new URL(r.url).host === new URL(stub.baseURL).host);
    // The token mint (REST) and the audio socket, both from the offscreen document.
    expect(
      toStub.some(
        (r) => r.kind === 'http' && r.url.includes('/v1/auth/grant') && r.target.url.endsWith('/offscreen.html'),
      ),
    ).toBe(true);
    expect(
      toStub.some(
        (r) => r.kind === 'websocket' && r.url.includes('/v1/listen') && r.target.url.endsWith('/offscreen.html'),
      ),
    ).toBe(true);
    const leaks = outsiders(net.requests, [site.primaryOrigin, site.secondOrigin, stub.baseURL]);
    expect(leaks, describe(leaks)).toEqual([]);
    expect(net.requests.filter((r) => VENDOR_HOSTS.test(r.url))).toEqual([]);
  } finally {
    await stub.close();
  }
});

test('local Whisper: huggingface.co is contacted only after Download is clicked in options', async ({
  context,
  serviceWorker,
  userDataDir,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  net = await NetworkLog.attach(userDataDir);
  // Stand-in for huggingface.co: answer every request with a 404 at once, so nothing is downloaded.
  const hf: string[] = [];
  await context.route(/^https:\/\/(huggingface\.co|hf\.co|[\w-]+\.hf\.co)\//, async (route) => {
    hf.push(route.request().url());
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'stub: not found' });
  });
  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({ transcriptionSettings: { tier: 'free', freeEngine: 'whisper', whisperModel: 'base' } }),
  );
  await grantMic(openExtensionPage);

  // A Session with the model not downloaded falls back, and never fetches it.
  const { panel } = await startAndDraw(context, site.primaryOrigin, openExtensionPage);
  const sessionId = (await activeSessionId(serviceWorker))!;
  const review = await stop(context, panel);
  const events = await sessionEvents(review, sessionId);
  // Whisper is not downloaded, so the Session starts on the free default (here: no captions, no pack).
  expect(ofType(events, 'transcription_fallback')).toContainEqual(
    expect.objectContaining({ from: 'whisper', reason: 'whisper_model_missing' }),
  );
  const beforeClick = net.requests.filter((r) => /huggingface\.co|hf\.co/.test(r.url));
  expect(beforeClick, describe(beforeClick)).toEqual([]);
  expect(outsiders(net.requests, [site.primaryOrigin, site.secondOrigin])).toEqual([]);

  // Download is the one path to the hub.
  const options = await openExtensionPage('options.html');
  await expect(options.getByTestId('whisper-download-base')).toBeVisible();
  const clickedAt = Date.now();
  await options.getByTestId('whisper-download-base').click();
  await expect
    .poll(() => net!.requests.filter((r) => /huggingface\.co/.test(r.url)).length, { timeout: 20_000 })
    .toBeGreaterThan(0);
  const hub = net.requests.filter((r) => /huggingface\.co|hf\.co/.test(r.url));
  expect(
    hub.every((r) => r.at >= clickedAt && r.target.url.endsWith('/options.html')),
    describe(hub),
  ).toBe(true);
  expect(hf.length).toBeGreaterThan(0);
  expect(hub.every((r) => r.url.includes('onnx-community/whisper-base_timestamped'))).toBe(true);
});

test('stored keys for every vendor never reach session.json, the export zip, any console or the stored rows', async ({
  context,
  serviceWorker,
  userDataDir,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(150_000);
  net = await NetworkLog.attach(userDataDir);
  const KEYS = {
    anthropic: 'sk-ant-api03-PRIVACY-anthropic-key-0123456789',
    deepgram: 'dg-PRIVACY-deepgram-key-0123456789',
    elevenlabs: 'el-PRIVACY-elevenlabs-key-0123456789',
    gateway: 'vck-PRIVACY-gateway-key-0123456789',
  };
  const consoleLines: string[] = [];
  context.on('console', (m) => consoleLines.push(m.text()));
  const dg: SttStub = await startDeepgramStub({ key: KEYS.deepgram, script: 'this button should go in the header' });
  const anthropic: AnthropicStub = await startAnthropicStub({
    onMessage: (req) => {
      const shot = /screenshot (s\d+)/.exec(JSON.stringify(req.body))?.[1] ?? 's1';
      if (req.body.max_tokens === 2000) return messageReply(req.body.model, JSON.stringify({ items: [] }));
      return messageReply(
        req.body.model,
        JSON.stringify({
          items: [
            {
              id: 'item_0001',
              title: "Move 'Get started' into the header",
              category: 'layout',
              intent: 'The CTA belongs in the header.',
              locations: [
                {
                  role: 'subject',
                  selector: 'button.cta',
                  element: "button 'Get started'",
                  url: '/pricing.html',
                  screenshot: shot,
                  annotation: 1,
                },
              ],
              evidence: { video: { start: 1, end: 3 }, screenshots: [shot] },
              transcript: 'this button should go in the header',
              confidence: 0.9,
              agent_prompt: `Move button.cta into the header. See screenshots/${shot}.png.`,
              pinned: false,
            },
          ],
        }),
      );
    },
  });
  try {
    await serviceWorker.evaluate(
      async ({ keys, dgBase, anthropicBase }) => {
        await chrome.storage.local.set({
          anthropicKey: keys.anthropic,
          gatewayKey: keys.gateway,
          deepgramKey: keys.deepgram,
          elevenlabsKey: keys.elevenlabs,
          anthropicNoticeShown: true,
          vendorNoticeShown: { deepgram: true, elevenlabs: true },
          transcriptionSettings: { tier: 'better', freeEngine: 'webspeech', whisperModel: 'base' },
          devOverrides: { deepgramBaseUrl: dgBase, anthropicBaseUrl: anthropicBase, gatewayBaseUrl: anthropicBase },
        });
      },
      { keys: KEYS, dgBase: dg.baseURL, anthropicBase: anthropic.baseURL },
    );
    await grantMic(openExtensionPage);
    const { panel } = await startAndDraw(context, site.primaryOrigin, openExtensionPage);
    await expect(panel.getByTestId('captions')).toContainText('this button', { timeout: 10_000 });
    const sessionId = (await activeSessionId(serviceWorker))!;
    const review = await stop(context, panel);
    await review.getByTestId('process-button').click();
    await review.getByTestId('process-confirm').click();
    await expect(review.getByTestId('change-item')).toHaveCount(1, { timeout: 30_000 });
    // The Gateway key's Test call (the same stub stands in for the Gateway).
    const options = await openExtensionPage('options.html');
    await options.getByTestId('test-gateway').click();
    await expect(options.getByTestId('gateway-test-result')).toBeVisible();
    await options.close();
    await review.bringToFront();
    const sessionJson = await downloadSessionJson(review, serviceWorker);
    const { zip, dir } = await exportZip(review, serviceWorker);
    // The keys were really used, so their absence below means something.
    expect(dg.rest.some((r) => JSON.stringify(r.headers).includes(KEYS.deepgram))).toBe(true);
    expect(anthropic.requests.some((r) => r.headers['x-api-key'] === KEYS.anthropic)).toBe(true);
    expect(anthropic.requests.some((r) => r.headers['x-api-key'] === KEYS.gateway)).toBe(true);

    const zipped = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => readFileSync(join(d.parentPath, d.name)).toString('latin1'));
    const haystacks: Record<string, string> = {
      'session.json': sessionJson,
      'export zip (raw)': readFileSync(zip).toString('latin1'),
      'export zip (unpacked)': zipped.join('\n'),
      'console (every target)': net.console.map((c) => c.text).join('\n'),
      'console (Playwright pages)': consoleLines.join('\n'),
      'IndexedDB rows': await dumpDatabase(review),
    };
    expect(haystacks['session.json']).toContain(sessionId);
    expect(haystacks['IndexedDB rows']).toContain('transcript_segment');
    for (const [where, text] of Object.entries(haystacks)) {
      for (const [vendor, key] of Object.entries(KEYS))
        expect(text.includes(key), `${vendor} key in ${where}`).toBe(false);
    }
  } finally {
    await dg.close();
    await anthropic.close();
  }
});
