// Slice 7 (PRD P0-4 "degrade gracefully"): drawing over the cross-origin iframe on the fixture site resolves to the
// region only. The content script cannot see into another origin's frame, and the frame element itself is no
// answer, so the Annotation has no Candidates and Process is told "region only".
import { renderEvents } from '../../packages/core/src/process/script.ts';
import { expect, grantMic, test, useScriptedTranscript } from './fixtures';
import { circle } from './helpers/draw';
import { activeSessionId, ofType, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'review-two-notes.wav' });

test('a circle over the cross-origin iframe is a region Annotation with no Candidates', async ({
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
  const frame = page.locator('#partner-frame');
  await frame.scrollIntoViewIfNeeded();
  await expect(page.frameLocator('#partner-frame').locator('body')).not.toBeEmpty();
  expect(new URL((await frame.getAttribute('src'))!).origin).toBe(site.secondOrigin);

  const panel = await openExtensionPage('sidepanel.html');
  await page.bringToFront();
  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  const sessionId = (await activeSessionId(serviceWorker))!;
  await panel.getByTestId('draw-toggle').click();
  await page.bringToFront();

  const box = (await frame.boundingBox())!;
  const inset = {
    x: box.x + box.width * 0.15,
    y: box.y + box.height * 0.15,
    width: box.width * 0.7,
    height: box.height * 0.7,
  };
  await circle(page, inset);
  await expect(panel.getByTestId('annotation-count')).toHaveText('1', { timeout: 10_000 });

  const events = await sessionEvents(panel, sessionId);
  const [ann] = ofType(events, 'annotation');
  expect(ann).toMatchObject({ resolution: 'region', candidates: [], pick: null });
  // The region is where the reviewer drew, in page coordinates, inside the frame's box.
  const pageScrollY: number = await page.evaluate(() => window.scrollY);
  expect(ann!.bbox.x).toBeGreaterThanOrEqual(box.x - 10);
  expect(ann!.bbox.y).toBeGreaterThanOrEqual(box.y + pageScrollY - 10);
  expect(ann!.bbox.x + ann!.bbox.width).toBeLessThanOrEqual(box.x + box.width + 10);
  expect(ann!.screenshot_id).not.toBeNull();
  // Process sees a region, not a guess.
  const { lines } = renderEvents(events, `${site.primaryOrigin}/pricing.html`, 'approximate');
  expect(lines.find((l) => l.includes('ANNOTATION #1'))).toBeTruthy();
  expect(lines.some((l) => /region only: .*\(no element resolved\)/.test(l))).toBe(true);
});
