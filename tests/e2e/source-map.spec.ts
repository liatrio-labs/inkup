// E4 proof: source mapping and element crops. fixtures/site/react.html renders with React's development build
// (vendored, no network). A circle around its button resolves to a Candidate whose `source` names the component
// file, line and owner chain, read by the MAIN-world bridge; the service worker crops the Annotation's screenshot to
// that button plus 16 px. After Process (stubbed LLM) the Change Item's Location carries the source and its Evidence
// the crop, review.md and the agent_prompt cite both, and the export zip holds the crop at its element's size. Runs
// standalone and paired with the real host, where an agent reads the same over MCP.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { SessionDocumentSchema } from '../../packages/core/src/session-document.ts';
import type { EventOf, TimelineEvent } from '../../packages/core/src/timeline.ts';
import { messageReply, startAnthropicStub } from '../support/anthropic-stub';
import { expect, grantMic, test, useScriptedTranscript } from './fixtures';
import { circle } from './helpers/draw';
import { exportAndUnzip, pngSize } from './helpers/export';
import { HostProcess, pairThroughOptions, tempDataDir } from './helpers/host';
import { McpClient } from './helpers/mcp';
import { storeRows } from './helpers/seed';
import { activeSessionId, ofType, screenshotPixel, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'review-two-notes.wav', captureSourceTitle: 'React Fixture' });

const SOURCE = { file: 'src/App.js', line: 6, components: ['CtaButton', 'PricingCard', 'App'] };
const PROMPT_SOURCE = 'Source in the codebase: #cta is rendered at src/App.js:6 (CtaButton ← PricingCard ← App).';

function stub() {
  return startAnthropicStub({
    onMessage: (req) =>
      messageReply(
        req.body.model,
        JSON.stringify({
          items: [
            {
              id: 'item_0001',
              title: "Move 'Get started' into the header",
              category: 'layout',
              intent: 'The primary CTA should sit in the site header.',
              locations: [
                {
                  role: 'subject',
                  selector: '#cta',
                  element: "button 'Get started'",
                  url: '/react.html',
                  screenshot: 's1',
                  annotation: 1,
                },
              ],
              evidence: { video: null, screenshots: ['s1'] },
              transcript: 'this button should go in the header',
              confidence: 0.9,
              agent_prompt: 'On /react.html move #cta into the header. See screenshots/s1.png.',
              pinned: false,
            },
          ],
        }),
      ),
  });
}

async function record(
  context: BrowserContext,
  sw: Worker,
  site: { primaryOrigin: string },
  openExtensionPage: (p: string) => Promise<Page>,
  anthropicBase: string,
) {
  await useScriptedTranscript(sw, 'pricing-cta.json', 2000);
  await grantMic(openExtensionPage);
  await sw.evaluate(async (base) => {
    const { devOverrides } = await chrome.storage.local.get('devOverrides');
    await chrome.storage.local.set({
      anthropicKey: 'sk-ant-e2e-source',
      devOverrides: { ...(devOverrides ?? {}), anthropicBaseUrl: base },
    });
  }, anthropicBase);
  const page = await context.newPage();
  await page.goto(`${site.primaryOrigin}/react.html`);
  await expect(page.locator('#cta')).toHaveText('Get started');
  const panel = await openExtensionPage('sidepanel.html');
  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  await panel.getByTestId('draw-toggle').click();
  const sessionId = (await activeSessionId(sw))!;
  await page.bringToFront();
  const cta = (await page.locator('#cta').boundingBox())!;
  await circle(page, cta);
  await expect(panel.getByTestId('annotation-count')).toHaveText('1', { timeout: 10_000 });
  // The Annotation event is written after its crop: wait for it.
  await expect
    .poll(async () => ofType(await sessionEvents(panel, sessionId), 'annotation').length, { timeout: 10_000 })
    .toBe(1);
  return { page, panel, sessionId, cta };
}

/** The Annotation resolves to the button, with its source, and its crop is the button plus 16 px of the screenshot. */
async function expectSourceAndCrop(
  extPage: Page,
  events: TimelineEvent[],
  cta: { x: number; y: number; width: number; height: number },
) {
  const annotation = ofType(events, 'annotation')[0]!;
  const pick = annotation.candidates[annotation.pick!]!;
  expect(pick.selector).toBe('#cta');
  expect(pick.source).toEqual(SOURCE);
  // The ancestors the Strokes enclose report the file and line where they were created too.
  expect(
    annotation.candidates.find((c) => c.relation === 'ancestor' && c.classes.includes('hero-card'))?.source,
  ).toMatchObject({ file: 'src/App.js', components: ['PricingCard', 'App'] });

  const shot = ofType(events, 'screenshot').find(
    (s) => s.screenshot_id === annotation.screenshot_id,
  )! as EventOf<'screenshot'>;
  const crop = annotation.crop!;
  expect(crop).toMatchObject({
    blob_id: `${shot.screenshot_id}.crop`,
    path: `screenshots/${shot.screenshot_id}.crop.png`,
  });
  const dpr = shot.dpr;
  // The element's box plus 16 CSS px on each side, in image pixels (rounded out to whole pixels).
  expect(Math.abs(crop.rect.width - (cta.width + 32) * dpr)).toBeLessThanOrEqual(2);
  expect(Math.abs(crop.rect.height - (cta.height + 32) * dpr)).toBeLessThanOrEqual(2);
  expect(Math.abs(crop.rect.x - (cta.x - 16) * dpr)).toBeLessThanOrEqual(1);
  expect(Math.abs(crop.rect.y - (cta.y - 16) * dpr)).toBeLessThanOrEqual(1);
  // Its pixels are that part of the screenshot: the button's centre matches.
  const [cx, cy] = [crop.rect.width / 2, crop.rect.height / 2];
  expect(await screenshotPixel(extPage, crop.blob_id, cx, cy)).toEqual(
    await screenshotPixel(extPage, shot.screenshot_id, crop.rect.x + cx, crop.rect.y + cy),
  );
  return { annotation, shot, crop };
}

async function stopAndProcess(context: BrowserContext, panel: Page): Promise<Page> {
  await panel.waitForTimeout(2500);
  const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await panel.getByTestId('stop').click();
  const review = await reviewPromise;
  await review.getByTestId('process-button').click();
  await review.getByTestId('process-confirm').click();
  await expect(review.getByTestId('change-item')).toHaveCount(1, { timeout: 20_000 });
  return review;
}

test('standalone: the React fixture button carries its source file, line and components; the crop is exported at its size', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(150_000);
  const llm = await stub();
  try {
    const { panel, sessionId, cta } = await record(context, serviceWorker, site, openExtensionPage, llm.baseURL);
    const { shot, crop } = await expectSourceAndCrop(panel, await sessionEvents(panel, sessionId), cta);
    const review = await stopAndProcess(context, panel);

    const { dir, files } = await exportAndUnzip(review, serviceWorker);
    expect(files).toContain(`screenshots/${shot.screenshot_id}.png`);
    expect(files).toContain(`screenshots/${shot.screenshot_id}.crop.png`);
    expect(pngSize(join(dir, 'screenshots', `${shot.screenshot_id}.crop.png`))).toEqual({
      width: crop.rect.width,
      height: crop.rect.height,
    });
    const full = pngSize(join(dir, 'screenshots', `${shot.screenshot_id}.png`));
    expect(crop.rect.width).toBeLessThan(full.width / 2);

    const doc = SessionDocumentSchema.parse(JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')));
    const [item] = doc.change_items!;
    expect(item!.locations[0]!.source).toEqual(SOURCE);
    expect(item!.evidence.crops).toEqual([crop.blob_id]);
    expect(item!.agent_prompt).toContain(PROMPT_SOURCE);
    expect(item!.agent_prompt).toContain(`screenshots/${crop.blob_id}.png`);
    expect(doc.blobs.find((b) => b.id === crop.blob_id)).toMatchObject({ kind: 'screenshot_crop', path: crop.path });
    const md = readFileSync(join(dir, 'review.md'), 'utf8');
    expect(md).toContain(
      '`#cta` on /react.html (Annotation #1) · source `src/App.js:6 (CtaButton ← PricingCard ← App)`',
    );
    expect(md).toContain(`![Close-up ${crop.blob_id}](${crop.path})`);
    expect(await storeRows(review, 'outbox')).toEqual([]);
  } finally {
    await llm.close();
  }
});

test('paired: the host and an agent over MCP get the source and the crop', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(150_000);
  const llm = await stub();
  const data = tempDataDir();
  const host = await HostProcess.start(data.dir);
  try {
    const { options, token } = await pairThroughOptions(serviceWorker, openExtensionPage, host);
    await options.close();
    const { panel, sessionId, cta } = await record(context, serviceWorker, site, openExtensionPage, llm.baseURL);
    const { crop } = await expectSourceAndCrop(panel, await sessionEvents(panel, sessionId), cta);

    // Live: the Signal names the source and the crop, and the crop's bytes are on the host.
    const agent = await McpClient.connect(host.url);
    type Signal = { kind: string; element_source?: unknown; crop?: string };
    await expect
      .poll(async () => (await agent.json<{ signals: Signal[] }>('read_items', { url: site.primaryOrigin })).signals, {
        timeout: 15_000,
      })
      .toEqual([expect.objectContaining({ kind: 'annotation', element_source: SOURCE, crop: crop.blob_id })]);
    await expect.poll(async () => (await host.blob(crop.blob_id, token)).status, { timeout: 15_000 }).toBe(200);

    await stopAndProcess(context, panel);
    type AgentItem = { agent_prompt: string; crops: string[]; locations: { selector: string; source?: unknown }[] };
    await expect
      .poll(
        async () => (await agent.json<{ items: AgentItem[] }>('read_items', { url: site.primaryOrigin })).items.length,
        { timeout: 15_000 },
      )
      .toBe(1);
    const [item] = (await agent.json<{ items: AgentItem[] }>('read_items', { url: site.primaryOrigin })).items;
    expect(item!.locations[0]).toMatchObject({ selector: '#cta', source: SOURCE });
    expect(item!.crops).toEqual([crop.blob_id]);
    expect(item!.agent_prompt).toContain(PROMPT_SOURCE);
    const image = await agent.call('get_screenshot', { id: `screenshots/${crop.blob_id}.png` });
    expect(image.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  } finally {
    await host.kill();
    data.remove();
    await llm.close();
  }
});
