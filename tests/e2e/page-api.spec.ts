// E5 proof: the page API. While a Session records a tab, a script on that page can call
// `window.__inkup.annotate('#cta', { comment })`; the call becomes an Annotation with no Strokes, tagged
// `source: 'page_api'`, and after Process (stubbed LLM) the Change Item grounded on it carries `source: 'page_api'`.
// Before Start and after Stop the global is undefined, and a page in another tab never sees it. Paired, the
// host's Signal and the agent's item carry the same tag.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { SessionDocumentSchema } from '../../packages/core/src/session-document.ts';
import { isDraftRequest, messageReply, scriptOf, startAnthropicStub } from '../support/anthropic-stub';
import { expect, grantMic, test, useScriptedTranscript } from './fixtures';
import { exportAndUnzip } from './helpers/export';
import { HostProcess, pairThroughOptions, tempDataDir } from './helpers/host';
import { McpClient } from './helpers/mcp';
import { activeSessionId, ofType, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'review-two-notes.wav', captureSourceTitle: 'React Fixture' });

const COMMENT = 'Make the primary CTA purple so it stands out';
const hasApi = (page: Page) => page.evaluate(() => typeof (window as unknown as { __inkup?: unknown }).__inkup);

function stub() {
  return startAnthropicStub({
    onMessage: (req) =>
      messageReply(
        req.body.model,
        JSON.stringify({
          items: [
            {
              id: 'item_0001',
              title: 'Make the CTA purple',
              category: 'style',
              intent: COMMENT,
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
              transcript: '',
              confidence: 0.9,
              agent_prompt: 'On /react.html give #cta a purple background. See screenshots/s1.png.',
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
      anthropicKey: 'sk-ant-e2e-page-api',
      devOverrides: { ...(devOverrides ?? {}), anthropicBaseUrl: base },
    });
  }, anthropicBase);
  const page = await context.newPage();
  await page.goto(`${site.primaryOrigin}/react.html`);
  await expect(page.locator('#cta')).toHaveText('Get started');
  // Another page of the same site, open in a second tab, that the Session does not record.
  const other = await context.newPage();
  await other.goto(`${site.primaryOrigin}/index.html`);
  // No Session yet: no global, on either page.
  expect(await hasApi(page)).toBe('undefined');
  await page.bringToFront();
  const panel = await openExtensionPage('sidepanel.html');
  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  const sessionId = (await activeSessionId(sw))!;
  await expect.poll(() => hasApi(page), { timeout: 10_000 }).toBe('object');
  return { page, other, panel, sessionId };
}

/** The script's call, as a page would make it, and what it recorded. */
async function annotateFromPage(page: Page, other: Page, panel: Page, sessionId: string) {
  const result = await page.evaluate(
    (comment) => window.__inkup!.annotate('#cta', { comment, styleChanges: { backgroundColor: 'rebeccapurple' } }),
    COMMENT,
  );
  expect(result).toEqual({ annotation: 1, selector: '#cta' });
  expect(await page.evaluate(() => window.__inkup!.list())).toEqual([
    expect.objectContaining({ annotation: 1, selector: '#cta', comment: COMMENT }),
  ]);
  expect(await page.evaluate(() => window.__inkup!.status())).toMatchObject({
    recording: true,
    session_id: sessionId,
    page_api_annotations: 1,
  });
  // A bad selector is an error the script can catch; nothing is recorded.
  await expect(page.evaluate(() => window.__inkup!.annotate('#nope', { comment: 'x' }))).rejects.toThrow(
    'no element matches "#nope"',
  );
  // The tab the Session does not record never sees the API.
  expect(await hasApi(other)).toBe('undefined');

  await expect(panel.getByTestId('annotation-count')).toHaveText('1', { timeout: 10_000 });
  const [annotation] = ofType(await sessionEvents(panel, sessionId), 'annotation');
  expect(annotation).toMatchObject({ index: 1, stroke_ids: [], close_reason: 'page_api', source: 'page_api' });
  expect(annotation!.page_api).toEqual({ comment: COMMENT });
  // The style change is a style_edit on the Annotation.
  const [edit] = ofType(await sessionEvents(panel, sessionId), 'style_edit');
  expect(edit).toMatchObject({
    annotation_id: annotation!.annotation_id,
    selector: '#cta',
    changes: { 'background-color': { from: expect.stringMatching(/^rgb/), to: 'rebeccapurple' } },
  });
  expect(annotation!.candidates[annotation!.pick!]!.selector).toBe('#cta');
  expect(annotation!.screenshot_id).toBeTruthy();
  return annotation!;
}

async function stopAndProcess(context: BrowserContext, panel: Page, page: Page): Promise<Page> {
  await panel.waitForTimeout(2500);
  const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await panel.getByTestId('stop').click();
  const review = await reviewPromise;
  // The Session is over: the global is gone.
  await expect.poll(() => hasApi(page), { timeout: 10_000 }).toBe('undefined');
  await expect(review.getByTestId('annotation-page-api')).toHaveText(`“${COMMENT}”`);
  await review.getByTestId('process-button').click();
  await review.getByTestId('process-confirm').click();
  await expect(review.getByTestId('change-item')).toHaveCount(1, { timeout: 20_000 });
  await expect(review.getByTestId('item-source')).toHaveText('page API');
  return review;
}

declare global {
  interface Window {
    __inkup?: {
      annotate(selector: string, options: unknown): Promise<unknown>;
      list(): Promise<unknown>;
      status(): Promise<unknown>;
    };
  }
}

test('standalone: __inkup.annotate during a Session becomes a Change Item with source page_api', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(150_000);
  const llm = await stub();
  try {
    const { page, other, panel, sessionId } = await record(
      context,
      serviceWorker,
      site,
      openExtensionPage,
      llm.baseURL,
    );
    await annotateFromPage(page, other, panel, sessionId);
    const review = await stopAndProcess(context, panel, page);

    // The script's Annotation reached the model as one, and the item came back tagged.
    const script = scriptOf(
      llm
        .messages()
        .filter((r) => !isDraftRequest(r))
        .at(-1)!,
    );
    expect(script).toContain('ANNOTATION #1 PAGE API');
    expect(script).toContain(`says: "${COMMENT}"`);
    expect(script).toMatch(/STYLE CHANGES .*background-color: rgb\([^)]*\) → rebeccapurple/);

    const { dir } = await exportAndUnzip(review, serviceWorker);
    const doc = SessionDocumentSchema.parse(JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')));
    expect(doc.change_items![0]!.source).toBe('page_api');
    // E2's pass-through carries the change exactly.
    expect(doc.change_items![0]!.style_changes).toEqual([
      expect.objectContaining({
        annotation: 1,
        selector: '#cta',
        changes: { 'background-color': expect.objectContaining({ to: 'rebeccapurple' }) },
      }),
    ]);
    expect(readFileSync(join(dir, 'review.md'), 'utf8')).toContain('**Category:** style · from the page API');
  } finally {
    await llm.close();
  }
});

test('paired: the host Signal and the agent item carry source page_api', async ({
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
    const { options } = await pairThroughOptions(serviceWorker, openExtensionPage, host);
    await options.close();
    const { page, other, panel, sessionId } = await record(
      context,
      serviceWorker,
      site,
      openExtensionPage,
      llm.baseURL,
    );
    await annotateFromPage(page, other, panel, sessionId);

    const agent = await McpClient.connect(host.url);
    type Signal = { kind: string; source?: string; intent?: string; selector?: string; style_changes?: unknown };
    await expect
      .poll(async () => (await agent.json<{ signals: Signal[] }>('read_items', { url: site.primaryOrigin })).signals, {
        timeout: 15_000,
      })
      .toEqual([
        expect.objectContaining({
          kind: 'annotation',
          source: 'page_api',
          intent: COMMENT,
          selector: '#cta',
          style_changes: { changes: { 'background-color': expect.objectContaining({ to: 'rebeccapurple' }) } },
        }),
      ]);

    await stopAndProcess(context, panel, page);
    type AgentItem = { source?: string; locations: { selector: string }[] };
    await expect
      .poll(
        async () => (await agent.json<{ items: AgentItem[] }>('read_items', { url: site.primaryOrigin })).items.length,
        { timeout: 15_000 },
      )
      .toBe(1);
    const [item] = (await agent.json<{ items: AgentItem[] }>('read_items', { url: site.primaryOrigin })).items;
    expect(item).toMatchObject({ source: 'page_api', locations: [expect.objectContaining({ selector: '#cta' })] });
  } finally {
    await host.kill();
    data.remove();
    await llm.close();
  }
});
