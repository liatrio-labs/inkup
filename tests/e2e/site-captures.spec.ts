// Not a test: records the marketing site's product media (apps/site) from the real extension on a synthetic page,
// fixtures/site/demo-store.html. Skipped unless CAPTURE_SITE=<output dir> is set; `pnpm site:captures` sets it to
// apps/site/src/assets/captures, and .github/workflows/site-captures.yml runs it on Linux. Never run it on a Mac
// desktop: the fake media and tab capture raise macOS screen-recording prompts.
//
// One toolbar Session, scripted (fixtures/audio/site-demo.wav plays as the mic, fixtures/transcripts/site-demo.json
// stands in for Web Speech) and drafted and Processed by the local Anthropic stub, so no paid API is called:
//
//   [1.5]  "make this button the first thing people see"   the trial button is circled
//   [7.4]  "this headline is too long"                      an arrow points at the headline
//   [12.5] "the price here should say per month"            the Pro price is circled
//
// Writes toolbar-recording.png, stroke.png, drafts.png (the side panel's Draft Items), review.png (the review page's
// Change Items), the review-flow clip (mp4, webm and a poster jpg, cut from the page's recorded video with ffmpeg),
// stroke-mobile.png, and manifest.json describing them.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Page, Worker } from '@playwright/test';
import {
  type AnthropicStub,
  confirmAll,
  isDraftRequest,
  isVetRequest,
  messageReply,
  type StubRequest,
  scriptOf,
  startAnthropicStub,
} from '../support/anthropic-stub';
import { ALLOW_TAB_CAPTURE, expect, grantMic, ROOT, test, useScript, useScriptedTranscript } from './fixtures';
import { arrow, circle } from './helpers/draw';

const OUT = process.env.CAPTURE_SITE ? resolve(ROOT, process.env.CAPTURE_SITE) : null;
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const PANEL = { width: 420, height: 900 };
const VIDEO_DIR = OUT ? mkdtempSync(join(tmpdir(), 'inkup-site-video-')) : '';
const PAGE = '/demo-store.html';
const MODEL = 'claude-sonnet-5';
const DRAFT_MODEL = 'claude-haiku-4-5-20251001';

test.use({
  fakeAudio: 'site-demo.wav',
  extraArgs: [ALLOW_TAB_CAPTURE],
  persistentOptions: OUT ? { viewport: DESKTOP, recordVideo: { dir: VIDEO_DIR, size: DESKTOP } } : {},
});
// Both tests add to one manifest.json.
test.describe.configure({ mode: 'serial' });

/** What each note becomes, as a Draft Item and then a Change Item. */
const NOTES = [
  {
    title: "Make 'Start free trial' the primary button",
    category: 'layout',
    intent: 'The trial button should be the first thing a visitor sees, ahead of the tour.',
    transcript: 'make this button the first thing people see',
    element: "button 'Start free trial'",
    selector: 'button.cta',
    agent_prompt:
      "On /demo-store.html make button.cta ('Start free trial') the primary, filled button and put it first in .actions; demote the tour button to secondary.",
  },
  {
    title: 'Shorten the hero headline',
    category: 'copy',
    intent: 'The headline runs to five lines; it should read at a glance.',
    transcript: 'this headline is too long',
    element: "heading 'Invoicing software that finally…'",
    selector: '#hero-title',
    agent_prompt: 'On /demo-store.html cut #hero-title to one short line (under 8 words) that keeps the promise.',
  },
  {
    title: 'Show the Pro price per month',
    category: 'copy',
    intent: 'The Pro price has no period, unlike the other plans.',
    transcript: 'the price here should say per month',
    element: "text '$12'",
    selector: '#pro-price',
    agent_prompt:
      "On /demo-store.html add '<small>per month</small>' to #pro-price, matching the Solo and Studio plans.",
  },
] as const;

/** The Draft model answers from the NEW EVENTS it was sent: a draft per Annotation it names. */
function draftReply(req: StubRequest) {
  const fresh = scriptOf(req).split('NEW EVENTS:')[1] ?? '';
  const items = NOTES.flatMap((n, i) =>
    new RegExp(`ANNOTATION #${i + 1} `).test(fresh)
      ? [
          {
            title: n.title,
            category: n.category,
            intent: n.intent,
            transcript: n.transcript,
            locations: [{ role: 'subject', element: n.element, selector: n.selector, annotation: i + 1 }],
          },
        ]
      : [],
  );
  return messageReply(DRAFT_MODEL, JSON.stringify({ items }), { input_tokens: 700, output_tokens: 90 });
}

/** Process: one Change Item per note, each on its Annotation's screenshot. */
function processReply(req: StubRequest) {
  const text = scriptOf(req);
  const items = NOTES.map((n, i) => {
    const shot = new RegExp(`ANNOTATION #${i + 1} .*screenshot (s\\d+)`).exec(text)?.[1] ?? null;
    return {
      id: `item_000${i + 1}`,
      title: n.title,
      category: n.category,
      intent: n.intent,
      locations: [
        { role: 'subject', selector: n.selector, element: n.element, url: PAGE, screenshot: shot, annotation: i + 1 },
      ],
      evidence: { video: null, screenshots: shot ? [shot] : [] },
      transcript: n.transcript,
      confidence: 0.9,
      agent_prompt: shot ? `${n.agent_prompt} See screenshots/${shot}.png.` : n.agent_prompt,
      pinned: false,
    };
  });
  return messageReply(MODEL, JSON.stringify({ items }));
}

/** The toolbar icon, clicked on the tab showing `path` (as in toolbar-session.spec.ts). */
async function clickToolbarIcon(sw: Worker, path: string) {
  await sw.evaluate(async (p) => {
    const [tab] = await chrome.tabs.query({ url: `*://*${p}` });
    (chrome.action.onClicked as unknown as { dispatch(tab: chrome.tabs.Tab): void }).dispatch(tab!);
  }, path);
}

/** `page` with a pause after every mouse move, so a Stroke is drawn at hand speed in the video. */
function paced(page: Page, ms = 12): Page {
  const mouse = {
    down: () => page.mouse.down(),
    up: () => page.mouse.up(),
    move: async (x: number, y: number, o?: { steps?: number }) => {
      await page.mouse.move(x, y, o);
      await new Promise((r) => setTimeout(r, ms));
    },
  };
  return new Proxy(page, { get: (target, key) => (key === 'mouse' ? mouse : Reflect.get(target, key)) });
}

const sleepUntil = (t: number) => new Promise((r) => setTimeout(r, Math.max(0, t - Date.now())));

interface Entry {
  name: string;
  file: string;
  width: number;
  height: number;
  kind: 'screenshot' | 'video' | 'poster';
}

/** A PNG's size, from its IHDR chunk. */
function pngSize(path: string) {
  const b = readFileSync(path);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function videoSize(path: string) {
  const [width, height] = execFileSync('ffprobe', [
    ...['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0'],
    path,
  ])
    .toString()
    .trim()
    .split(',')
    .map(Number);
  return { width: width!, height: height! };
}

async function shoot(page: Page, name: string): Promise<Entry> {
  const file = `${name}.png`;
  await page.screenshot({ path: join(OUT!, file) });
  return { name, file, ...pngSize(join(OUT!, file)), kind: 'screenshot' };
}

/** Adds `entries` to manifest.json, replacing earlier ones of the same file. */
function record(entries: Entry[]) {
  const path = join(OUT!, 'manifest.json');
  let prior: { assets: (Entry & { capturedAt: string })[] } = { assets: [] };
  try {
    prior = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    /* first run */
  }
  const versions = JSON.parse(readFileSync(join(ROOT, '.release-please-manifest.json'), 'utf8'));
  const capturedAt = new Date().toISOString();
  const files = new Set(entries.map((e) => e.file));
  const assets = [
    ...prior.assets.filter((a) => !files.has(a.file)),
    ...entries.map((e) => ({ ...e, capturedAt, extensionVersion: versions['extensions/web'] as string })),
  ].sort((a, b) => a.file.localeCompare(b.file));
  writeFileSync(path, `${JSON.stringify({ source: 'site-captures.spec.ts', assets }, null, 2)}\n`);
}

/**
 * The review-flow clip: cuts of the page's recorded video (seconds from its start), joined and encoded as H.264
 * mp4 (yuv420p, faststart) and VP9 webm, both without audio, plus a poster frame at `posterAt` (seconds into the clip).
 */
function encodeClip(raw: string, cuts: [number, number][], posterAt: number): Entry[] {
  const name = 'review-flow';
  const parts = cuts.map(
    ([a, b], i) => `[0:v]trim=start=${a.toFixed(2)}:end=${b.toFixed(2)},setpts=PTS-STARTPTS[c${i}]`,
  );
  const joined = `${cuts.map((_, i) => `[c${i}]`).join('')}concat=n=${cuts.length}:v=1:a=0,fps=30,format=yuv420p[v]`;
  const mp4 = join(OUT!, `${name}.mp4`);
  const ffmpeg = (...args: string[]) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]);
  ffmpeg(
    ...['-i', raw, '-filter_complex', `${parts.join(';')};${joined}`, '-map', '[v]'],
    ...['-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an'],
    mp4,
  );
  ffmpeg(
    ...['-i', mp4, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '36', '-row-mt', '1', '-deadline', 'good', '-an'],
    join(OUT!, `${name}.webm`),
  );
  ffmpeg('-ss', posterAt.toFixed(2), '-i', mp4, '-frames:v', '1', '-q:v', '3', join(OUT!, `${name}.jpg`));
  return [
    { name, file: `${name}.mp4`, ...videoSize(mp4), kind: 'video' },
    { name, file: `${name}.webm`, ...videoSize(join(OUT!, `${name}.webm`)), kind: 'video' },
    { name, file: `${name}.jpg`, ...videoSize(join(OUT!, `${name}.jpg`)), kind: 'poster' },
  ];
}

test('capture the site media: toolbar, Stroke, Draft Items, Change Items and the review-flow clip', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.skip(!OUT, 'set CAPTURE_SITE=<dir> to capture');
  test.setTimeout(180_000);
  mkdirSync(OUT!, { recursive: true });
  const stub: AnthropicStub = await startAnthropicStub({
    onMessage: (req) => {
      if (isDraftRequest(req)) return draftReply(req);
      if (isVetRequest(req)) return messageReply(MODEL, confirmAll(req));
      return processReply(req);
    },
  });
  try {
    await useScriptedTranscript(serviceWorker, 'site-demo.json');
    await serviceWorker.evaluate(async (baseUrl) => {
      const { devOverrides } = await chrome.storage.local.get('devOverrides');
      await chrome.storage.local.set({
        anthropicKey: 'sk-ant-e2e-stub-key',
        devOverrides: { ...(devOverrides ?? {}), anthropicBaseUrl: baseUrl },
      });
    }, stub.baseURL);
    await grantMic(openExtensionPage);
    const panel = await openExtensionPage('sidepanel.html');
    await panel.setViewportSize(PANEL);

    const demo = await context.newPage();
    const videoT0 = Date.now();
    const at = (t: number) => (t - videoT0) / 1000;
    await demo.goto(`${site.primaryOrigin}${PAGE}`);
    await demo.evaluate(() => document.fonts.ready);
    await demo.bringToFront();
    await demo.waitForTimeout(800);

    await clickToolbarIcon(serviceWorker, PAGE);
    const toolbar = demo.getByTestId('toolbar');
    await expect(toolbar).toHaveAttribute('data-state', 'idle');
    await demo.waitForTimeout(600);
    const startedAt = Date.now();
    await demo.getByTestId('toolbar-start').click();
    await expect(toolbar).toHaveAttribute('data-state', 'recording');
    await demo.getByTestId('toolbar-draw').click();
    await expect(demo.getByTestId('toolbar-draw')).toHaveAttribute('aria-pressed', 'true');
    const pen = paced(demo);

    // Note 1: circle the trial button while it is spoken, and catch the ink before it fades.
    await sleepUntil(startedAt + 1800);
    await circle(pen, (await demo.locator('button.cta').boundingBox())!, 1.25, { jitter: 1, wobble: 3, seed: 7 });
    const circledAt = Date.now();
    const shots = [await shoot(demo, 'stroke')];

    // Note 2: an arrow at the end of the headline's first line.
    await sleepUntil(startedAt + 7600);
    const arrowFrom = Date.now();
    const h1 = (await demo.locator('#hero-title').boundingBox())!;
    await arrow(pen, [h1.x + h1.width + 60, h1.y - 36], [h1.x + h1.width - 70, h1.y + 26], {
      jitter: 0.8,
      wobble: 3,
      seed: 3,
    });
    // Its caption reaches the toolbar's toast: the toolbar mid-Session.
    await expect(demo.getByTestId('toolbar-toast')).toHaveText(NOTES[1].transcript, { timeout: 15_000 });
    const captionedAt = Date.now();
    await demo.waitForTimeout(300);
    shots.push(await shoot(demo, 'toolbar-recording'));

    // Note 3: circle the Pro price.
    await sleepUntil(startedAt + 12_800);
    await circle(pen, (await demo.locator('#pro-price').boundingBox())!, 1.6, { jitter: 1, wobble: 2, seed: 5 });

    // The side panel's Draft Items: a card per note, newest first.
    await expect(panel.getByTestId('draft-card')).toHaveCount(3, { timeout: 30_000 });
    await panel.waitForTimeout(500);
    shots.push(await shoot(panel, 'drafts'));

    // Stop: the review page opens; Process through the stub.
    await demo.bringToFront();
    await demo.waitForTimeout(800);
    const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
    const stoppedAt = Date.now();
    await demo.getByTestId('toolbar-stop').click();
    const review = await reviewPromise;
    await expect(toolbar).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
    await demo.waitForTimeout(1500);
    await demo.close();
    const raw = join(VIDEO_DIR, 'review-flow-raw.webm');
    await demo.video()!.saveAs(raw);

    await review.bringToFront();
    await review.getByTestId('process-button').click();
    await review.getByTestId('process-confirm').click();
    await expect(review.getByTestId('change-item')).toHaveCount(3, { timeout: 30_000 });
    // From the Session's title down to the Change Items.
    await review.evaluate(() => {
      const title = document.querySelector('h1')!;
      window.scrollTo(0, title.getBoundingClientRect().top + window.scrollY - 32);
    });
    await review.waitForTimeout(500);
    shots.push(await shoot(review, 'review'));

    // Start and the first note with its caption, the second note with its caption, then Stop: about 11 s.
    const cuts: [number, number][] = [
      [at(startedAt) - 0.4, at(circledAt) + 3.2],
      [at(arrowFrom) - 0.4, at(captionedAt) + 0.8],
      [at(stoppedAt) - 0.3, at(stoppedAt) + 1.4],
    ];
    const clip = encodeClip(raw, cuts, at(circledAt) - cuts[0]![0] + 0.1);
    record([...shots, ...clip]);
  } finally {
    await stub.close();
  }
});

test('capture the site media: a Stroke on a phone-sized page', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.skip(!OUT, 'set CAPTURE_SITE=<dir> to capture');
  await useScript(serviceWorker, { timestamp_quality: 'approximate', cues: [] });
  await grantMic(openExtensionPage);
  const demo = await context.newPage();
  await demo.setViewportSize(MOBILE);
  await demo.goto(`${site.primaryOrigin}${PAGE}`);
  await demo.evaluate(() => document.fonts.ready);
  await clickToolbarIcon(serviceWorker, PAGE);
  await demo.getByTestId('toolbar-start').click();
  await expect(demo.getByTestId('toolbar')).toHaveAttribute('data-state', 'recording');
  await demo.getByTestId('toolbar-draw').click();
  await circle(demo, (await demo.locator('button.cta').boundingBox())!, 1.3, { jitter: 1, wobble: 2, seed: 7 });
  record([await shoot(demo, 'stroke-mobile')]);
});
