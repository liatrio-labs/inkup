// E7 proof: Object Select. From the toolbar, hover outlines the element under the pointer, ↑ goes to its parent and ↓
// back, ⏎ picks it, and a small comment box opens next to it; "Make this roomier" + Enter records an Annotation with
// close reason object_select, one definite Candidate and the typed comment. Esc in the box drops a pick; Esc on the
// page turns the mode off. The page never gets the pick's clicks and is never modified (its computed styles are the
// same at the end). On the React fixture a spoken-only pick (Alt+Shift+O, Enter with nothing typed) carries the
// speech said during it and the Candidate's `source` from the E4 bridge. Process (stubbed LLM) sees OBJECT SELECT and
// the COMMENT. Paired, an agent sees the pick as a Signal whose intent is the comment.
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { messageReply, startAnthropicStub } from '../support/anthropic-stub';
import {
  ALLOW_TAB_CAPTURE,
  expect,
  grantMic,
  test,
  useBoxDictation,
  useScript,
  useScriptedTranscript,
} from './fixtures';
import { HostProcess, pairThroughOptions, tempDataDir } from './helpers/host';
import { McpClient } from './helpers/mcp';
import { activeSessionId, ofType, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'review-two-notes.wav', extraArgs: [ALLOW_TAB_CAPTURE] });

type Box = { x: number; y: number; width: number; height: number };
const near = (a: Box, b: Box) =>
  Math.abs(a.x - b.x) <= 2 &&
  Math.abs(a.y - b.y) <= 2 &&
  Math.abs(a.width - b.width) <= 2 &&
  Math.abs(a.height - b.height) <= 2;
const SPEECH = 'this button should go in the header';

/** Events read by the service worker, which is always there (no extension page needed while recording). */
function swEvents(sw: Worker, sessionId: string): Promise<{ type: string; [k: string]: unknown }[]> {
  return sw.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const rows = await new Promise<{ type: string; t: number; seq: number }[]>((res, rej) => {
      const r = idb.transaction('events').objectStore('events').index('session_id').getAll(id);
      r.onsuccess = () => res(r.result as { type: string; t: number; seq: number }[]);
      r.onerror = () => rej(r.error);
    });
    idb.close();
    return rows.sort((a, b) => a.t - b.t || a.seq - b.seq);
  }, sessionId);
}

const selectMode = (sw: Worker) =>
  sw.evaluate(
    async () =>
      ((await chrome.storage.session.get('activeSession')).activeSession as { select_mode?: string | null } | null)
        ?.select_mode ?? null,
  );

/** A mode shortcut on the page, once: the page has the Session by the time anything says Recording (F1). */
async function shortcut(page: Page, sw: Worker, key: string, want: string | null) {
  await page.keyboard.press(key);
  await expect.poll(() => selectMode(sw)).toBe(want);
}

/** Every computed style (and the text) of the elements a pick touches: nothing may change. */
const pageStyles = (page: Page) =>
  page.evaluate(() =>
    ['button.cta', '.hero .card', '#hero-title'].map((sel) => {
      const cs = getComputedStyle(document.querySelector(sel)!);
      return `${[...cs].map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';')}|${document.querySelector(sel)!.textContent}`;
    }),
  );

async function startFromToolbar(
  context: BrowserContext,
  sw: Worker,
  site: { primaryOrigin: string },
): Promise<{ pricing: Page; sessionId: string }> {
  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://*/pricing.html' });
    (chrome.action.onClicked as unknown as { dispatch(tab: chrome.tabs.Tab): void }).dispatch(tab!);
  });
  await pricing.getByTestId('toolbar-start').click();
  await expect(pricing.getByTestId('toolbar')).toHaveAttribute('data-state', 'recording');
  return { pricing, sessionId: (await activeSessionId(sw))! };
}

/** Object Select on from the toolbar, hover the CTA, ↑ to its card and ↓ back, then pick it with ⏎ (or a click). */
async function pickCta(pricing: Page, how: 'enter' | 'click') {
  await pricing.getByTestId('toolbar-object-select').click();
  await expect(pricing.getByTestId('toolbar-object-select')).toHaveAttribute('aria-pressed', 'true');
  const cta = (await pricing.locator('button.cta').boundingBox())!;
  const card = (await pricing.locator('.hero .card').boundingBox())!;
  const outline = pricing.getByTestId('object-select-highlight');
  await pricing.mouse.move(cta.x + 10, cta.y + 10);
  await pricing.mouse.move(cta.x + cta.width / 2, cta.y + cta.height / 2, { steps: 3 });
  await expect.poll(async () => near((await outline.boundingBox())!, cta)).toBe(true);
  await expect(pricing.getByTestId('object-select-label')).toContainText('button.cta');
  await pricing.keyboard.press('ArrowUp');
  await expect.poll(async () => near((await outline.boundingBox())!, card)).toBe(true);
  await pricing.keyboard.press('ArrowDown');
  await expect.poll(async () => near((await outline.boundingBox())!, cta)).toBe(true);
  if (how === 'enter') await pricing.keyboard.press('Enter');
  else await pricing.mouse.click(cta.x + cta.width / 2, cta.y + cta.height / 2);
  const box = pricing.getByTestId('object-select-box');
  await expect(box).toBeVisible({ timeout: 15_000 });
  await expect(pricing.getByTestId('object-select-input')).toBeFocused();
  // The box sits next to the element: just below it (or above, without room).
  const at = (await box.boundingBox())!;
  expect(Math.abs(at.y - (cta.y + cta.height)) <= 12 || Math.abs(at.y + at.height - cta.y) <= 12).toBe(true);
  return cta;
}

function itemStub() {
  return startAnthropicStub({
    onMessage: (req) =>
      messageReply(
        req.body.model,
        JSON.stringify({
          items: [
            {
              id: 'item_0001',
              title: "Give the 'Get started' button more room",
              category: 'style',
              intent: 'Make this roomier.',
              locations: [
                {
                  role: 'subject',
                  selector: 'button.cta',
                  element: "button 'Get started'",
                  url: '/pricing.html',
                  screenshot: 's1',
                  annotation: 1,
                },
              ],
              evidence: { video: null, screenshots: ['s1'] },
              transcript: 'Make this roomier',
              confidence: 0.9,
              agent_prompt: 'On /pricing.html give button.cta more padding. See screenshots/s1.png.',
              pinned: false,
            },
          ],
        }),
      ),
  });
}

async function useStub(sw: Worker, base: string) {
  await sw.evaluate(async (b) => {
    const { devOverrides } = await chrome.storage.local.get('devOverrides');
    await chrome.storage.local.set({
      anthropicKey: 'sk-ant-e2e-object-select',
      devOverrides: { ...(devOverrides ?? {}), anthropicBaseUrl: b },
    });
  }, base);
}

test('standalone: pick the CTA, type "Make this roomier"; the page is never modified; Process sees OBJECT SELECT and the COMMENT', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(150_000);
  const stub = await itemStub();
  try {
    await useScriptedTranscript(serviceWorker, 'pricing-cta.json', 2000);
    // Speech while the box is open is meant for the Session transcript here, not the box (E11).
    await useBoxDictation(serviceWorker, 'push');
    await grantMic(openExtensionPage);
    const { pricing, sessionId } = await startFromToolbar(context, serviceWorker, site);
    const before = await pageStyles(pricing);
    await pricing.evaluate(() => {
      (window as unknown as { pageClicks: number }).pageClicks = 0;
      // The picked elements' own clicks (the toolbar's clicks bubble to the document too).
      for (const sel of ['button.cta', '.hero .card', '#hero-title'])
        document
          .querySelector(sel)!
          .addEventListener('click', () => (window as unknown as { pageClicks: number }).pageClicks++);
    });

    const picked = await pickCta(pricing, 'enter');
    await pricing.getByTestId('object-select-input').pressSequentially('Make this roomier');
    await pricing.getByTestId('object-select-input').press('Enter');
    await expect(pricing.getByTestId('object-select-box')).toBeHidden();
    await expect
      .poll(async () => (await swEvents(serviceWorker, sessionId)).filter((e) => e.type === 'annotation').length, {
        timeout: 15_000,
      })
      .toBe(1);

    // A second pick, by click on the heading, dropped with Esc in its box: nothing is recorded.
    const title = (await pricing.locator('#hero-title').boundingBox())!;
    await pricing.mouse.move(title.x + 20, title.y + title.height / 2, { steps: 2 });
    await pricing.mouse.click(title.x + 20, title.y + title.height / 2);
    await expect(pricing.getByTestId('object-select-box')).toBeVisible({ timeout: 15_000 });
    await pricing.getByTestId('object-select-input').press('Escape');
    await expect(pricing.getByTestId('object-select-box')).toBeHidden();
    await expect(pricing.getByTestId('toolbar-object-select')).toHaveAttribute('aria-pressed', 'true');
    // Esc on the page turns Object Select off.
    await pricing.keyboard.press('Escape');
    await expect(pricing.getByTestId('toolbar-object-select')).toHaveAttribute('aria-pressed', 'false');
    await expect(pricing.getByTestId('object-select-highlight')).toBeHidden();

    // The page got none of the picks' clicks and looks exactly as before.
    expect(await pricing.evaluate(() => (window as unknown as { pageClicks: number }).pageClicks)).toBe(0);
    expect(await pageStyles(pricing)).toEqual(before);
    // The spoken cue: a Session of typed comments alone would be processed in code, without the model (E11).
    await expect
      .poll(
        async () => (await swEvents(serviceWorker, sessionId)).filter((e) => e.type === 'transcript_segment').length,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
    await pricing.getByTestId('toolbar-stop').click();
    const review = await reviewPromise;

    const events = await sessionEvents(review, sessionId);
    const annotations = ofType(events, 'annotation');
    expect(annotations).toHaveLength(1);
    const pick = annotations[0]!;
    expect(pick).toMatchObject({
      index: 1,
      close_reason: 'object_select',
      comment: 'Make this roomier',
      stroke_ids: [],
      resolution: 'element',
      pick: 0,
    });
    expect(pick.t_end).toBeGreaterThan(pick.t);
    expect(pick.candidates).toHaveLength(1);
    expect(pick.candidates[0]).toMatchObject({ selector: 'button.cta', tag: 'button', relation: 'pick', coverage: 1 });
    expect(near(pick.bbox, { ...picked, x: picked.x + pick.scroll.x, y: picked.y + pick.scroll.y })).toBe(true);
    expect(pick.screenshot_id).not.toBeNull();
    expect(pick.crop).toBeDefined();
    expect(ofType(events, 'screenshot').find((s) => s.screenshot_id === pick.screenshot_id)?.annotation_id).toBe(
      pick.annotation_id,
    );
    expect(ofType(events, 'click')).toHaveLength(0);
    expect(ofType(events, 'style_edit')).toHaveLength(0);
    await expect(review.getByTestId('annotation').first()).toContainText('picked with Object Select');
    await expect(review.getByTestId('annotation-comment')).toHaveText('“Make this roomier”');

    await useStub(serviceWorker, stub.baseURL);
    await review.getByTestId('process-button').click();
    await review.getByTestId('process-confirm').click();
    await expect(review.getByTestId('change-item')).toHaveCount(1, { timeout: 20_000 });
    const script = stub.messages().at(-1)!.body.messages[0].content as string;
    expect(script).toMatch(/ANNOTATION #1 OBJECT SELECT · \d\d:\d\d\.\d–\d\d:\d\d\.\d · at \/pricing\.html/);
    expect(script).toContain('    COMMENT "Make this roomier"');
    expect(script).not.toMatch(/INSPECT|STYLE EDITS/);
  } finally {
    await stub.close();
  }
});

test.describe('on the React fixture', () => {
  test.use({ captureSourceTitle: 'React Fixture' });

  test('spoken only: Alt+Shift+O, pick the button, say it, Enter with nothing typed; the Candidate carries its source', async ({
    context,
    serviceWorker,
    site,
    openExtensionPage,
  }) => {
    test.setTimeout(150_000);
    const stub = await itemStub();
    try {
      await useScript(serviceWorker, {
        timestamp_quality: 'approximate',
        cues: [{ at_ms: 8000, duration_ms: 1500, text: SPEECH }],
      });
      // Speech while the box is open is meant for the Session transcript here, not the box (E11).
      await useBoxDictation(serviceWorker, 'push');
      await grantMic(openExtensionPage);
      const page = await context.newPage();
      await page.goto(`${site.primaryOrigin}/react.html`);
      await expect(page.locator('#cta')).toHaveText('Get started');
      const panel = await openExtensionPage('sidepanel.html');
      await panel.getByTestId('start').click();
      await expect(panel.getByTestId('status')).toHaveText('Recording');
      const sessionId = (await activeSessionId(serviceWorker))!;
      await page.bringToFront();
      const ctaStyle = () =>
        page
          .locator('#cta')
          .evaluate((el) => [...getComputedStyle(el)].map((p) => getComputedStyle(el).getPropertyValue(p)).join(';'));
      const before = await ctaStyle();

      await shortcut(page, serviceWorker, 'Alt+Shift+KeyO', 'object');
      const cta = (await page.locator('#cta').boundingBox())!;
      await page.mouse.move(cta.x + cta.width / 2, cta.y + cta.height / 2, { steps: 3 });
      await page.mouse.click(cta.x + cta.width / 2, cta.y + cta.height / 2);
      await expect(page.getByTestId('object-select-box')).toBeVisible({ timeout: 15_000 });
      // The reviewer says it instead of typing: the speech lands while the pick is open.
      await expect(panel.getByTestId('captions')).toContainText(SPEECH, { timeout: 30_000 });
      await page.getByTestId('object-select-input').press('Enter');
      await expect(page.getByTestId('object-select-box')).toBeHidden();
      await expect
        .poll(async () => ofType(await sessionEvents(panel, sessionId), 'annotation').length, { timeout: 15_000 })
        .toBe(1);
      // Alt+Shift+O again turns it off.
      await shortcut(page, serviceWorker, 'Alt+Shift+KeyO', null);
      expect(await ctaStyle()).toBe(before);

      const events = await sessionEvents(panel, sessionId);
      const pick = ofType(events, 'annotation')[0]!;
      expect(pick).toMatchObject({ close_reason: 'object_select', comment: null, stroke_ids: [], pick: 0 });
      expect(pick.candidates[0]).toMatchObject({
        selector: '#cta',
        relation: 'pick',
        source: { file: 'src/App.js', line: 6, components: ['CtaButton', 'PricingCard', 'App'] },
      });
      const said = ofType(events, 'transcript_segment').find((s) => s.text === SPEECH)!;
      expect(said.t).toBeGreaterThanOrEqual(pick.t);
      expect(said.t).toBeLessThanOrEqual(pick.t_end);

      await useStub(serviceWorker, stub.baseURL);
      const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
      await panel.getByTestId('stop').click();
      const review = await reviewPromise;
      await review.getByTestId('process-button').click();
      await review.getByTestId('process-confirm').click();
      await expect(review.getByTestId('change-item')).toHaveCount(1, { timeout: 20_000 });
      const script = stub.messages().at(-1)!.body.messages[0].content as string;
      expect(script).toContain('ANNOTATION #1 OBJECT SELECT');
      expect(script).not.toMatch(/^ +COMMENT /m);
      expect(script).toContain('src/App.js:6');
      expect(script).toContain(SPEECH);
    } finally {
      await stub.close();
    }
  });
});

test('paired: an Object Select pick reaches an agent as a Signal whose intent is the typed comment', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  const data = tempDataDir();
  const host = await HostProcess.start(data.dir);
  try {
    const { token } = await pairThroughOptions(serviceWorker, openExtensionPage, host);
    await useScriptedTranscript(serviceWorker, 'pricing-cta.json', 2000);
    // Speech while the box is open is meant for the Session transcript here, not the box (E11).
    await useBoxDictation(serviceWorker, 'push');
    await grantMic(openExtensionPage);
    const { pricing, sessionId } = await startFromToolbar(context, serviceWorker, site);
    await expect(pricing.getByTestId('toolbar-host')).toHaveAttribute('data-state', 'connected');

    await pickCta(pricing, 'click');
    await pricing.getByTestId('object-select-input').pressSequentially('Make this roomier');
    await pricing.getByTestId('object-select-input').press('Enter');
    await expect(pricing.getByTestId('object-select-box')).toBeHidden();

    const agent = await McpClient.connect(host.url);
    type Signal = { kind: string; selector?: string; element?: string; intent?: string; screenshot?: string };
    await expect
      .poll(async () => (await agent.json<{ signals: Signal[] }>('read_items', { url: site.primaryOrigin })).signals, {
        timeout: 15_000,
      })
      .toEqual([
        expect.objectContaining({
          kind: 'annotation',
          selector: 'button.cta',
          element: "button 'Get started'",
          intent: 'Make this roomier',
          screenshot: expect.any(String),
        }),
      ]);
    const stored = await host.get<{ type: string; close_reason?: string; comment?: string | null }[]>(
      `/api/sessions/${sessionId}/events`,
      token,
    );
    expect(stored.filter((e) => e.type === 'annotation').map((e) => [e.close_reason, e.comment])).toEqual([
      ['object_select', 'Make this roomier'],
    ]);
    await pricing.getByTestId('toolbar-stop').click();
    await expect(pricing.getByTestId('toolbar')).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
  } finally {
    await host.kill();
    data.remove();
  }
});
