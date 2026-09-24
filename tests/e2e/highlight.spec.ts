// U2 regression (feedback batch 1): a circle drawn around an element, followed at once by a scroll of more than
// 25% of the viewport, closes its Annotation by scroll. The pick must still be the circled element, and the
// screenshot must show the page as it was under the Strokes: the recorded scroll matches the image, the Strokes
// land over the element, and the element is where the recorded scroll says it is.
import type { EventOf } from '../../packages/core/src/timeline.ts';
import { expect, grantMic, test, useScript } from './fixtures';
import { circle } from './helpers/draw';
import { activeSessionId, ofType, screenshotPixel, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'review-two-notes.wav' });

test('a circle closed by a scroll still picks the circled element and its screenshot shows it', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(60_000);
  // No speech: a Speech Boundary must not close the Annotation before the scroll does.
  await useScript(serviceWorker, { timestamp_quality: 'word', cues: [] });
  await grantMic(openExtensionPage);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${site.primaryOrigin}/pricing.html`);
  const panel = await openExtensionPage('sidepanel.html');
  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  await panel.getByTestId('draw-toggle').click();
  await page.bringToFront();
  const sessionId = (await activeSessionId(serviceWorker))!;

  const cta = (await page.locator('button.cta').boundingBox())!;
  const ctaPage = { ...cta, y: cta.y + (await page.evaluate(() => scrollY)) };
  await circle(page, cta, 1.3);
  // Lift the pen, then scroll 60% of the viewport, well inside the 1.5 s gap: the scroll closes the Annotation.
  await page.waitForTimeout(400);
  await page.mouse.wheel(0, 430);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(400);

  await expect
    .poll(async () => ofType(await sessionEvents(panel, sessionId), 'annotation').length, { timeout: 10_000 })
    .toBe(1);
  const events = await sessionEvents(panel, sessionId);
  const ann = ofType(events, 'annotation')[0]!;
  const shot = ofType(events, 'screenshot').find((s) => s.screenshot_id === ann.screenshot_id) as
    | EventOf<'screenshot'>
    | undefined;
  const strokes = ofType(events, 'stroke').filter((s) => ann.stroke_ids.includes(s.stroke_id));
  const ys = strokes.flatMap((s) => s.points.map((p) => p.y - (shot?.scroll.y ?? 0)));
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  const ctaTop = ctaPage.y - (shot?.scroll.y ?? 0);
  const observed = {
    close: ann.close_reason,
    resolution: ann.resolution,
    pick: ann.pick === null ? null : ann.candidates[ann.pick]!.selector,
    annScroll: ann.scroll,
    strokeScroll: strokes[0]!.scroll,
    shotScroll: shot?.scroll,
    strokeY: [top, bottom],
    ctaY: [ctaTop, ctaTop + cta.height],
  };
  test.info().annotations.push({ type: 'observed', description: JSON.stringify(observed) });
  expect(ann.close_reason).toBe('scroll');
  expect(ann.resolution).toBe('element');
  expect(ann.candidates[ann.pick!]!.selector).toBe('button.cta');

  // The Strokes, mapped into the screenshot the way the review overlay maps them, lie over the button.
  expect(shot, 'the Annotation has a screenshot').toBeTruthy();
  expect(top).toBeGreaterThanOrEqual(0);
  expect(bottom).toBeLessThanOrEqual(shot!.viewport.height);
  expect(top).toBeLessThan(ctaTop);
  expect(bottom).toBeGreaterThan(ctaTop + cta.height);

  // The image agrees with the recorded scroll: the button's blue fill (left padding, clear of its white label)
  // sits at its recorded place.
  const [r, g, b] = (await screenshotPixel(
    panel,
    shot!.screenshot_id,
    (cta.x + 8) * shot!.dpr,
    (ctaTop + cta.height / 2) * shot!.dpr,
  ))!;
  expect(b).toBeGreaterThan(180);
  expect(r).toBeLessThan(120);
  expect(g).toBeLessThan(140);

  await panel.getByTestId('stop').click();
});
