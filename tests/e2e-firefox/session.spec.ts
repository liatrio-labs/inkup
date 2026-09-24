// F1 proof: the Firefox build records a Session on the fixture site, processes it and exports the zip. The media
// context (mic, recorder, transcription) runs in the background page's iframe; the scripted transcript stands in
// for speech, as in the Chrome suite. Video is off: see fixtures.ts.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionDocumentSchema } from '../../packages/core/src/session-document.ts';
import type { TimelineEvent } from '../../packages/core/src/timeline.ts';
import { circle } from '../e2e/helpers/draw';
import { messageReply, scriptOf, startAnthropicStub } from '../support/anthropic-stub';
import { type ExtPage, expect, ROOT, test } from './fixtures';

/** Every stored event of a Session (any extension page shares the add-on's IndexedDB). */
function sessionEvents(page: ExtPage, sessionId: string): Promise<TimelineEvent[]> {
  return page.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return new Promise<TimelineEvent[]>((res, rej) => {
      const r = idb.transaction('events').objectStore('events').index('session_id').getAll(id);
      r.onsuccess = () => res(r.result as TimelineEvent[]);
      r.onerror = () => rej(r.error);
    });
  }, sessionId);
}

const activeSessionId = (page: ExtPage) =>
  page.waitFor(
    async () =>
      ((await chrome.storage.session.get('activeSession')).activeSession as { id: string } | undefined)?.id ?? null,
    undefined,
    {
      what: 'an active Session',
    },
  );

/** Onboarding's microphone step, which Start requires. */
async function grantMic(onboarding: ExtPage) {
  await onboarding.click('allow-mic');
  await onboarding.waitFor(() => !!document.querySelector('[data-testid="mic-status"]'), undefined, {
    timeout: 20_000,
    what: 'the mic grant',
  });
}

test('Firefox: Start, draw on the fixture site, Stop, Process, Export: the zip is a working handoff', async ({
  context,
  extPage,
  openExtensionWindow,
  site,
}) => {
  test.setTimeout(120_000);
  const stub = await startAnthropicStub({
    onMessage: (req) => {
      const shot = /screenshot (s\d+)/.exec(scriptOf(req))?.[1] ?? 's1';
      const item = {
        id: 'item_0001',
        title: "Move 'Get started' into the header",
        category: 'layout',
        intent: 'The primary CTA should sit in the site header instead of the hero card.',
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
        evidence: { video: null, screenshots: [shot] },
        transcript: 'this button should go in the header',
        confidence: 0.85,
        agent_prompt: `On /pricing.html move button.cta into the header. See screenshots/${shot}.png for the circled button.`,
        pinned: false,
      };
      return messageReply(req.body.model, JSON.stringify({ items: [item] }));
    },
  });
  try {
    const onboarding = await extPage('/onboarding.html');
    const script = JSON.parse(readFileSync(join(ROOT, 'fixtures/transcripts/pricing-cta.json'), 'utf8'));
    await onboarding.evaluate(
      ({ script, base }) =>
        chrome.storage.local.set({
          anthropicKey: 'sk-ant-e2e-firefox',
          devOverrides: { transcription: 'scripted', script, anthropicBaseUrl: base },
        }),
      { script, base: stub.baseURL },
    );
    await grantMic(onboarding);

    const pricing = await context.newPage();
    await pricing.goto(`${site.primaryOrigin}/pricing.html`);
    const panel = await openExtensionWindow('sidepanel.html');
    await panel.click('start');
    await panel.waitForText('status', /^Recording$/);
    const sessionId = await activeSessionId(panel);

    await panel.click('draw-toggle');
    await pricing.bringToFront();
    await circle(pricing, (await pricing.locator('button.cta').boundingBox())!);
    await panel.waitForText('annotation-count', /^1$/);
    await panel.waitForText('captions', /this button/);

    await panel.click('stop');
    const review = await extPage('/review.html', 20_000);
    await review.click('process-button');
    await review.click('process-confirm');
    await review.waitFor(() => document.querySelectorAll('[data-testid="change-item"]').length === 1, undefined, {
      timeout: 20_000,
      what: 'one Change Item',
    });

    // The Session timeline: a screenshot of the circled button, the scripted speech, audio from the media context.
    const events = await sessionEvents(review, sessionId);
    expect(events.filter((e) => e.type === 'annotation')).toHaveLength(1);
    expect(events.some((e) => e.type === 'screenshot' && e.trigger === 'annotation')).toBe(true);
    expect(events.some((e) => e.type === 'transcript_segment' && e.text.includes('this button'))).toBe(true);

    await review.evaluate(() => delete document.body.dataset.exportDownloadId);
    await review.click('export-zip');
    await review.waitFor(() => !!document.querySelector('[data-testid="export-done"]'), undefined, {
      timeout: 30_000,
      what: 'the export',
    });
    const download = await review.waitFor(
      async () => {
        const id = Number(document.body.dataset.exportDownloadId);
        const [item] = id ? await chrome.downloads.search({ id }) : [];
        return item?.state === 'complete' ? { filename: item.filename } : null;
      },
      undefined,
      { timeout: 30_000, what: 'the download to complete' },
    );

    const dir = mkdtempSync(join(tmpdir(), 'var-ff-export-'));
    execFileSync('unzip', ['-q', download.filename, '-d', dir]);
    const files = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => join(d.parentPath, d.name).slice(dir.length + 1))
      .sort();
    const doc = SessionDocumentSchema.parse(JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')));
    const shots = [...new Set(doc.events.flatMap((e) => (e.type === 'screenshot' ? [e.screenshot_id] : [])))];
    expect(shots.length).toBeGreaterThan(0);
    // No recording.webm: automated Firefox runs with video off.
    // The background page crops each Annotation's screenshot to its element too (E4).
    const crops = doc.events.flatMap((e) => (e.type === 'annotation' && e.crop ? [e.crop.path] : []));
    expect(crops.length).toBeGreaterThan(0);
    expect(files).toEqual(
      ['audio.webm', 'review.md', ...shots.map((id) => `screenshots/${id}.png`), ...crops, 'session.json'].sort(),
    );
    // The media context in the background page recorded the fake mic.
    expect(statSync(join(dir, 'audio.webm')).size).toBeGreaterThan(1000);
    const md = readFileSync(join(dir, 'review.md'), 'utf8');
    expect(md).toContain("Move 'Get started' into the header");
    for (const cited of md.matchAll(/screenshots\/([\w-]+)\.png/g))
      expect(existsSync(join(dir, 'screenshots', `${cited[1]}.png`))).toBe(true);
  } finally {
    await stub.close();
  }
});

test('Firefox without Web Speech: the Session records without captions and says why', async ({
  context,
  extPage,
  openExtensionWindow,
  site,
}) => {
  const onboarding = await extPage('/onboarding.html');
  await onboarding.waitFor(() => !!document.querySelector('[data-testid="no-webspeech"]'), undefined, {
    what: 'the no-speech note',
  });
  expect(await onboarding.evaluate(() => !!document.querySelector('[data-testid="allow-server-speech"]'))).toBe(false);
  await grantMic(onboarding);

  const pricing = await context.newPage();
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  const panel = await openExtensionWindow('sidepanel.html');
  await panel.click('start');
  await panel.waitForText('status', /^Recording$/);
  const sessionId = await activeSessionId(panel);
  await panel.waitForText('captions-off', /no built-in speech recognition/);

  const events = await sessionEvents(panel, sessionId);
  const fallbacks = events.filter((e) => e.type === 'transcription_fallback');
  expect(fallbacks).toEqual([
    expect.objectContaining({ from: 'webspeech', to: 'none', reason: 'speech_recognition_unsupported' }),
  ]);

  await panel.click('stop');
  await extPage('/review.html', 20_000);
});
