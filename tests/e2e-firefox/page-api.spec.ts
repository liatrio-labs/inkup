// E5 proof in Firefox: the MAIN-world bridge exposes `window.__inkup` only while a Session records the tab
// (the isolated overlay and the bridge talk over DOM events with JSON details, which Firefox passes across worlds),
// and `annotate` records an Annotation with no Strokes tagged `source: 'page_api'`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventOf, TimelineEvent } from '../../packages/core/src/timeline.ts';
import { type ExtPage, expect, ROOT, test } from './fixtures';

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

type Api = { annotate(selector: string, options: unknown): Promise<unknown> };

test('Firefox: __inkup exists only while the tab records, and annotate records a page_api Annotation', async ({
  context,
  extPage,
  openExtensionWindow,
  site,
}) => {
  test.setTimeout(120_000);
  const onboarding = await extPage('/onboarding.html');
  const script = JSON.parse(readFileSync(join(ROOT, 'fixtures/transcripts/pricing-cta.json'), 'utf8'));
  await onboarding.evaluate(
    (s) => chrome.storage.local.set({ devOverrides: { transcription: 'scripted', script: s } }),
    script,
  );
  await onboarding.click('allow-mic');
  await onboarding.waitFor(() => !!document.querySelector('[data-testid="mic-status"]'), undefined, {
    timeout: 20_000,
    what: 'the mic grant',
  });

  const page = await context.newPage();
  await page.goto(`${site.primaryOrigin}/react.html`);
  await expect(page.locator('#cta')).toHaveText('Get started');
  const hasApi = () => page.evaluate(() => typeof (window as unknown as { __inkup?: unknown }).__inkup);
  expect(await hasApi()).toBe('undefined');

  const panel = await openExtensionWindow('sidepanel.html');
  await panel.click('start');
  await panel.waitForText('status', /^Recording$/);
  const sessionId = await panel.waitFor(
    async () =>
      ((await chrome.storage.session.get('activeSession')).activeSession as { id: string } | undefined)?.id ?? null,
    undefined,
    { what: 'an active Session' },
  );
  await expect.poll(hasApi, { timeout: 10_000 }).toBe('object');
  await page.bringToFront();
  const result = await page.evaluate(() =>
    (window as unknown as { __inkup: Api }).__inkup.annotate('#cta', {
      comment: 'Make it purple',
      textChange: 'Start free',
    }),
  );
  expect(result).toEqual({ annotation: 1, selector: '#cta' });
  await panel.waitForText('annotation-count', /^1$/);

  const annotation = (await sessionEvents(panel, sessionId)).find(
    (e): e is EventOf<'annotation'> => e.type === 'annotation',
  )!;
  expect(annotation).toMatchObject({ stroke_ids: [], source: 'page_api', page_api: { comment: 'Make it purple' } });
  const edit = (await sessionEvents(panel, sessionId)).find((e): e is EventOf<'style_edit'> => e.type === 'style_edit');
  expect(edit).toMatchObject({
    annotation_id: annotation.annotation_id,
    changes: {},
    text: { from: 'Get started', to: 'Start free' },
  });
  expect(annotation.candidates[annotation.pick!]!).toMatchObject({
    selector: '#cta',
    source: { file: 'src/App.js', line: 6 },
  });

  await panel.click('stop');
  await expect.poll(hasApi, { timeout: 10_000 }).toBe('undefined');
});
