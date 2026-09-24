// E8 proof: adaptive contrast on fixtures/site/contrast.html (light, dark, red and dark-hero-image sections, each a
// full viewport). The toolbar goes light over the dark section and dark again over the light one, from computed
// styles; over the image the styles cannot tell and a capture sample decides (light). The Light setting forces it.
// A Stroke drawn on the red section is not red and stands out at least 3:1 from the red in its screenshot; one drawn
// on the dark section does too. Each Stroke records its ink colour (schema v14), and the review page draws it in that
// ink over a halo.
import type { Page } from '@playwright/test';
import { contrastRatio, parseColor, type Rgb } from '../../packages/core/src/contrast.ts';
import type { EventOf } from '../../packages/core/src/timeline.ts';
import { ALLOW_TAB_CAPTURE, expect, grantMic, test } from './fixtures';
import { stroke } from './helpers/draw';
import { activeSessionId, ofType, screenshotPixel, sessionEvents } from './helpers/session';

test.use({ fakeAudio: 'review-two-notes.wav', extraArgs: [ALLOW_TAB_CAPTURE] });

const RED = parseColor('#c92a2a')!;
const DARK = parseColor('#1a1b1e')!;
const show = (page: Page, id: string) =>
  page.evaluate((id) => window.scrollTo(0, document.getElementById(id)!.offsetTop), id);
const rgb = ([r, g, b]: [number, number, number]): Rgb => ({ r, g, b });

test('the toolbar follows the page (styles, then a sample over an image) and the setting; ink stands out on red and dark', async ({
  context,
  serviceWorker: sw,
  site,
  openExtensionPage,
}) => {
  test.setTimeout(120_000);
  await grantMic(openExtensionPage);
  const page = await context.newPage();
  await page.goto(`${site.primaryOrigin}/contrast.html`);
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://*/contrast.html' });
    (chrome.action.onClicked as unknown as { dispatch(tab: chrome.tabs.Tab): void }).dispatch(tab!);
  });
  const bar = page.getByTestId('toolbar');
  await page.getByTestId('toolbar-start').click();
  await expect(bar).toHaveAttribute('data-state', 'recording');
  const sessionId = (await activeSessionId(sw))!;
  const ext = await openExtensionPage('sessions.html');
  await page.bringToFront();
  // Up from its bottom-right corner: headless Chromium's captures are shorter than the emulated viewport, so a sample
  // there would read nothing. A drag end is also one of the moments the theme is looked at again.
  const grip = (await page.getByTestId('toolbar-grip').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, 300, { steps: 5 });
  await page.mouse.up();

  // The toolbar, from computed styles.
  await expect(bar).toHaveAttribute('data-theme', 'dark');
  await expect(bar).toHaveAttribute('data-theme-from', 'style');
  await show(page, 'dark');
  await expect(bar).toHaveAttribute('data-theme', 'light');
  await expect(page.getByTestId('toolbar-toast')).toHaveAttribute('data-theme', 'light');
  await show(page, 'light');
  await expect(bar).toHaveAttribute('data-theme', 'dark');
  // Over the image: a capture sample of the band around the toolbar.
  await show(page, 'hero');
  await expect(bar).toHaveAttribute('data-theme-from', 'sample', { timeout: 15_000 });
  await expect(bar).toHaveAttribute('data-theme', 'light');

  // Ink: on red, then on dark. Each Stroke's Annotation closes when Draw goes off.
  const vp = page.viewportSize()!;
  const line = Array.from({ length: 30 }, (_, i) => [vp.width * 0.25 + i * 10, vp.height * 0.4] as [number, number]);
  const drawOn = async (id: string) => {
    await show(page, id);
    await page.getByTestId('toolbar-draw').click();
    await expect(page.getByTestId('toolbar-draw')).toHaveAttribute('aria-pressed', 'true');
    await stroke(page, line);
    await page.waitForTimeout(400);
    await page.getByTestId('toolbar-draw').click();
    await expect(page.getByTestId('toolbar-draw')).toHaveAttribute('aria-pressed', 'false');
  };
  const inkOf = async (n: number, bg: Rgb) => {
    await expect
      .poll(
        async () => ofType(await sessionEvents(ext, sessionId), 'annotation').filter((a) => a.screenshot_id).length,
        { timeout: 20_000 },
      )
      .toBeGreaterThanOrEqual(n);
    const events = await sessionEvents(ext, sessionId);
    const ann = ofType(events, 'annotation')[n - 1]!;
    const s = ofType(events, 'stroke').find((e) => e.stroke_id === ann.stroke_ids[0]) as EventOf<'stroke'>;
    const shot = ofType(events, 'screenshot').find((e) => e.screenshot_id === ann.screenshot_id)!;
    const mid = s.points[Math.floor(s.points.length / 2)]!;
    const px = (await screenshotPixel(
      ext,
      shot.screenshot_id,
      (mid.x - shot.scroll.x) * shot.dpr,
      (mid.y - shot.scroll.y) * shot.dpr,
    ))!;
    return { color: s.color, pixel: rgb(px), contrast: contrastRatio(rgb(px), bg) };
  };

  await drawOn('red');
  const onRed = await inkOf(1, RED);
  expect(onRed.color).toMatch(/^#[0-9a-f]{6}$/);
  expect(onRed.color).not.toBe('#e03131');
  expect(contrastRatio(parseColor(onRed.color!)!, RED)).toBeGreaterThanOrEqual(3);
  expect(onRed.contrast, `ink pixel ${JSON.stringify(onRed.pixel)} on red`).toBeGreaterThanOrEqual(3);

  await drawOn('dark');
  const onDark = await inkOf(2, DARK);
  expect(contrastRatio(parseColor(onDark.color!)!, DARK)).toBeGreaterThanOrEqual(3);
  expect(onDark.contrast, `ink pixel ${JSON.stringify(onDark.pixel)} on dark`).toBeGreaterThanOrEqual(3);

  // The setting: Light forces the light toolbar over the light section; back to Auto follows the page again.
  await show(page, 'light');
  await expect(bar).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('toolbar-theme').click();
  await expect(page.getByTestId('toolbar-theme')).toHaveAttribute('data-setting', 'light');
  await expect(bar).toHaveAttribute('data-theme', 'light');
  await expect(bar).toHaveAttribute('data-theme-from', 'setting');
  expect(await sw.evaluate(async () => (await chrome.storage.local.get('toolbarTheme')).toolbarTheme)).toBe('light');
  await page.getByTestId('toolbar-theme').click();
  await expect(page.getByTestId('toolbar-theme')).toHaveAttribute('data-setting', 'dark');
  await page.getByTestId('toolbar-theme').click();
  await expect(page.getByTestId('toolbar-theme')).toHaveAttribute('data-setting', 'auto');
  await expect(bar).toHaveAttribute('data-theme', 'dark');
  await expect(bar).toHaveAttribute('data-theme-from', 'style');

  // The review page draws each Stroke in its recorded ink, over its halo.
  const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await page.getByTestId('toolbar-stop').click();
  const review = await reviewPromise;
  await expect(bar).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
  const drawn = review.getByTestId('stroke-overlay').locator(`[data-color="${onRed.color}"]`).first();
  await expect(drawn).toBeAttached({ timeout: 20_000 });
  const fills = await drawn.locator('path').evaluateAll((paths) => paths.map((p) => p.getAttribute('fill')));
  expect(fills).toHaveLength(2);
  expect(fills[1]).toBe(onRed.color);
  expect(['#000000', '#ffffff']).toContain(fills[0]);
});
