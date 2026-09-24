// Slice 3 proof (docs/PLAN.md): an arrow drawn with the mouse from the CTA to the header nav becomes an
// Annotation with a Connector: its tail picks button.cta and its head resolves inside the header.

import { expect, grantMic, test, useScript, useScriptedTranscript } from './fixtures';
import { arrow, center } from './helpers/draw';
import { activeSessionId, ofType, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'review-two-notes.wav' });

for (const twoStroke of [false, true]) {
  test(`an arrow from the CTA to the header nav is a Connector (${twoStroke ? 'shaft + V' : 'one Stroke'})`, async ({
    context,
    serviceWorker,
    site,
    openExtensionPage,
  }) => {
    await useScriptedTranscript(serviceWorker, 'pricing-cta.json');
    await grantMic(openExtensionPage);
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`${site.primaryOrigin}/pricing.html`);
    const panel = await openExtensionPage('sidepanel.html');
    await panel.getByTestId('start').click();
    await expect(panel.getByTestId('status')).toHaveText('Recording');
    const sessionId = (await activeSessionId(serviceWorker))!;
    await panel.getByTestId('draw-toggle').click();
    await page.bringToFront();

    const from = center((await page.locator('button.cta').boundingBox())!);
    const to = center((await page.locator('header nav a[href="/docs.html"]').boundingBox())!);
    await arrow(page, from, to, { twoStroke, jitter: 1.5, seed: 3 });
    await expect(panel.getByTestId('annotation-count')).toHaveText('1', { timeout: 10_000 });

    const events = await sessionEvents(panel, sessionId);
    const [ann] = ofType(events, 'annotation');
    const strokes = ofType(events, 'stroke');
    expect(strokes).toHaveLength(twoStroke ? 2 : 1);
    expect(strokes.every((s) => s.shape === 'arrow')).toBe(true);
    const c = ann!.connector!;
    expect(c.stroke_ids).toEqual(strokes.map((s) => s.stroke_id));
    expect(c.tail.candidates[c.tail.pick!]).toMatchObject({ selector: 'button.cta', role: 'button' });
    const head = c.head.candidates[c.head.pick!]!;
    expect(await page.evaluate((sel) => !!document.querySelector(sel)?.closest('header'), head.selector)).toBe(true);
  });
}

test('scrolling more than 25% of the viewport closes the open Annotation', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  // No speech: the scripted cue's Speech Boundary closes whichever Annotation is open when it lands, and on a
  // 2-CPU runner the circle was still open then, before the scroll this test is about.
  await useScript(serviceWorker, { timestamp_quality: 'approximate', cues: [] });
  await grantMic(openExtensionPage);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${site.primaryOrigin}/pricing.html`);
  const panel = await openExtensionPage('sidepanel.html');
  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  const sessionId = (await activeSessionId(serviceWorker))!;
  await panel.getByTestId('draw-toggle').click();
  await page.bringToFront();

  const { circle } = await import('./helpers/draw');
  await circle(page, (await page.locator('#plan-basic').boundingBox())!);
  // 25% of 720 px is 180 px: scroll 300 px well inside the 1.5 s gap.
  await page.evaluate(() => window.scrollBy(0, 300));
  await expect(panel.getByTestId('annotation-count')).toHaveText('1', { timeout: 10_000 });
  await expect.poll(async () => ofType(await sessionEvents(panel, sessionId), 'scroll_settle').length).toBe(1);
  const events = await sessionEvents(panel, sessionId);
  const [ann] = ofType(events, 'annotation');
  expect(ann!.close_reason).toBe('scroll');
  expect(ann!.t_end).toBeLessThan(ofType(events, 'scroll_settle')[0]!.t);
  expect(ofType(events, 'scroll_settle')[0]!.scroll.y).toBe(300);
});
