// E4 proof in Firefox: the MAIN-world bridge runs from the manifest (Firefox 128+), reads React's development build
// on fixtures/site/react.html (Firefox formats the owner stack as `fn@url:line:col`), and the background page crops
// the Annotation's screenshot to the button.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventOf, TimelineEvent } from '../../packages/core/src/timeline.ts';
import { circle } from '../e2e/helpers/draw';
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

test('Firefox: a circle on the React fixture resolves to the button with its source, and gets an element crop', async ({
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
  const panel = await openExtensionWindow('sidepanel.html');
  await panel.click('start');
  await panel.waitForText('status', /^Recording$/);
  const sessionId = await panel.waitFor(
    async () =>
      ((await chrome.storage.session.get('activeSession')).activeSession as { id: string } | undefined)?.id ?? null,
    undefined,
    { what: 'an active Session' },
  );
  await panel.click('draw-toggle');
  await page.bringToFront();
  const cta = (await page.locator('#cta').boundingBox())!;
  await circle(page, cta);
  await panel.waitForText('annotation-count', /^1$/);

  let annotation: EventOf<'annotation'> | undefined;
  await expect
    .poll(
      async () =>
        (annotation = (await sessionEvents(panel, sessionId)).find(
          (e): e is EventOf<'annotation'> => e.type === 'annotation',
        )),
      { timeout: 10_000 },
    )
    .toBeTruthy();
  const pick = annotation!.candidates[annotation!.pick!]!;
  expect(pick.selector).toBe('#cta');
  expect(pick.source).toEqual({ file: 'src/App.js', line: 6, components: ['CtaButton', 'PricingCard', 'App'] });
  const shot = (await sessionEvents(panel, sessionId)).find(
    (e): e is EventOf<'screenshot'> => e.type === 'screenshot' && e.screenshot_id === annotation!.screenshot_id,
  )!;
  expect(annotation!.crop).toMatchObject({ blob_id: `${shot.screenshot_id}.crop` });
  expect(Math.abs(annotation!.crop!.rect.width - (cta.width + 32) * shot.dpr)).toBeLessThanOrEqual(2);
  expect(Math.abs(annotation!.crop!.rect.height - (cta.height + 32) * shot.dpr)).toBeLessThanOrEqual(2);
  await panel.click('stop');
});
