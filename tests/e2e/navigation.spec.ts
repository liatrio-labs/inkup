// Slice 3 proof (docs/PLAN.md): the Session follows its tab across a cross-origin navigation. Drawing keeps
// working on the new page, clicks and navigations are screenshotted, leaving the page closes the open
// Annotation, and looking at another tab logs tab_switch and offers "Go back".
import type { Page } from '@playwright/test';
import { expect, grantMic, test, useScript, useScriptedTranscript } from './fixtures';
import { circle } from './helpers/draw';
import { activeSessionId, ofType, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'review-two-notes.wav' });

async function startOn(page: Page, panel: Page) {
  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  await page.bringToFront();
}

test('draw on /pricing, follow the link to the second origin, draw there', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(90_000);
  // No speech: a scripted cue landing before the draw-toggle click would close Annotation 1 as a Speech Boundary.
  await useScript(serviceWorker, { timestamp_quality: 'word', cues: [] });
  await grantMic(openExtensionPage);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${site.primaryOrigin}/pricing.html`);
  const panel = await openExtensionPage('sidepanel.html');
  await startOn(page, panel);
  const sessionId = (await activeSessionId(serviceWorker))!;

  // 1. Draw mode on, circle the CTA, draw mode off: the toggle closes the Annotation at once.
  await panel.getByTestId('draw-toggle').click();
  await page.bringToFront();
  await circle(page, (await page.locator('button.cta').boundingBox())!);
  await panel.getByTestId('draw-toggle').click();
  await expect(panel.getByTestId('annotation-count')).toHaveText('1', { timeout: 10_000 });

  // 2. Hold Shift to circle the link, then click it straight away: leaving the page closes that Annotation.
  const link = page.locator('#second-origin-link');
  await link.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.keyboard.down('Shift');
  await circle(page, (await link.boundingBox())!, 1.15);
  await page.keyboard.up('Shift');
  // A human press: the click screenshot starts at pointerdown, before the release navigates.
  await link.click({ delay: 120 });
  await page.waitForURL(`${site.secondOrigin}/second/other.html`);
  await expect(panel.getByTestId('recording-tab')).toContainText('Partner Checkout', { timeout: 10_000 });
  await expect(panel.getByTestId('annotation-count')).toHaveText('2', { timeout: 10_000 });

  // 3. Drawing works on the new origin.
  await panel.getByTestId('draw-toggle').click();
  await page.bringToFront();
  await expect(page.locator('var-review-overlay canvas')).toHaveCSS('pointer-events', 'auto');
  await circle(page, (await page.locator('button.cta').boundingBox())!);
  await expect(panel.getByTestId('annotation-count')).toHaveText('3', { timeout: 10_000 });

  const events = await sessionEvents(panel, sessionId);
  const annotations = ofType(events, 'annotation');
  expect(annotations.map((a) => [new URL(a.url).pathname, a.close_reason])).toEqual([
    ['/pricing.html', 'draw_toggle'],
    ['/pricing.html', 'navigation'],
    ['/second/other.html', 'time_gap'],
  ]);
  expect(annotations[2]!.url.startsWith(site.secondOrigin)).toBe(true);
  expect(annotations[2]!.candidates[annotations[2]!.pick!]).toMatchObject({ selector: 'button.cta', name: 'Pay now' });

  const clicks = ofType(events, 'click');
  expect(clicks).toEqual([
    expect.objectContaining({ selector: '#second-origin-link', tag: 'a', name: 'Continue to partner checkout' }),
  ]);
  const navs = ofType(events, 'navigation');
  expect(navs).toEqual([
    expect.objectContaining({ url: `${site.secondOrigin}/second/other.html`, title: 'Partner Checkout' }),
  ]);
  const shots = ofType(events, 'screenshot');
  const clickShot = shots.find((s) => s.trigger === 'click');
  const navShot = shots.find((s) => s.trigger === 'navigation');
  // The link's own Annotation shot, asked for 120 ms after its Stroke, can land just before the press; a click shot
  // right after another screenshot is dropped (throttle). Either way the old page was shot before it went away.
  const own = shots.find((s) => s.annotation_id === annotations[1]!.annotation_id);
  expect(clickShot ?? own).toMatchObject({ url: `${site.primaryOrigin}/pricing.html` });
  expect(navShot).toMatchObject({ url: `${site.secondOrigin}/second/other.html` });
  expect(navShot!.t).toBeGreaterThanOrEqual(navs[0]!.t);
  // The Annotation closed by leaving the page points at a screenshot of that page taken with its ink on screen:
  // its own if it landed, else the click's.
  expect([own?.screenshot_id, clickShot?.screenshot_id]).toContain(annotations[1]!.screenshot_id);
  expect(annotations.every((a) => a.screenshot_id !== null)).toBe(true);
});

test('looking at another tab logs tab_switch and the panel offers Go back', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  await useScriptedTranscript(serviceWorker, 'pricing-cta.json');
  await grantMic(openExtensionPage);
  const page = await context.newPage();
  await page.goto(`${site.primaryOrigin}/pricing.html`);
  const panel = await openExtensionPage('sidepanel.html');
  await startOn(page, panel);
  const sessionId = (await activeSessionId(serviceWorker))!;

  // Open and activate another tab in the Session's window (Playwright gives every page its own window).
  const otherId = await serviceWorker.evaluate(async (url) => {
    const { activeSession } = (await chrome.storage.session.get('activeSession')) as {
      activeSession: { window_id: number };
    };
    const tab = await chrome.tabs.create({ windowId: activeSession.window_id, url, active: true });
    return tab.id!;
  }, `${site.primaryOrigin}/docs.html`);
  await expect(panel.getByTestId('away')).toContainText('Pricing Fixture');
  // No screenshot is possible while the Session tab is hidden.
  const before = ofType(await sessionEvents(panel, sessionId), 'screenshot').length;
  expect(await serviceWorker.evaluate((id) => chrome.tabs.get(id).then((t) => t.active), otherId)).toBe(true);

  await panel.getByTestId('go-back').click();
  await expect(panel.getByTestId('away')).toHaveCount(0);
  const events = await sessionEvents(panel, sessionId);
  expect(ofType(events, 'screenshot')).toHaveLength(before);
  const switches = ofType(events, 'tab_switch');
  expect(switches.map((s) => [s.away, s.to_tab_id])).toEqual([
    [true, otherId],
    [false, expect.any(Number)],
  ]);
});
