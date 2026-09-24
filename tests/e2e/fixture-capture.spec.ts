// Not a test: captures real Annotations (Candidates, Strokes, bboxes) from the fixture site so the hand-authored
// Process fixtures in fixtures/sessions use the DOM the extension actually sees. Skipped unless
// CAPTURE_FIXTURES=<output dir> is set. `scripts/gen-session-fixtures.ts` reads its output.
//
//   CAPTURE_FIXTURES=fixtures/sessions/captured pnpm test:e2e fixture-capture
//
// Writes pricing-annotations.session.json (circles) and pricing-arrow.session.json (one arrow Connector).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { expect, grantMic, test, useScript, useScriptedTranscript } from './fixtures';
import { arrow, center, circle } from './helpers/draw';

test.use({ fakeAudio: 'review-two-notes.wav' });

test('capture Annotations for the Process fixtures', async ({ context, serviceWorker, site, openExtensionPage }) => {
  const out = process.env.CAPTURE_FIXTURES;
  test.skip(!out, 'set CAPTURE_FIXTURES=<dir> to capture');
  test.setTimeout(120_000);
  await useScriptedTranscript(serviceWorker, 'pricing-cta.json');
  await grantMic(openExtensionPage);
  const pricing = await context.newPage();
  await pricing.setViewportSize({ width: 1280, height: 720 });
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  const panel = await openExtensionPage('sidepanel.html');
  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  await panel.getByTestId('draw-toggle').click();
  await pricing.bringToFront();

  const draw = async (selector: string, margin: number, n: number) => {
    const box = await pricing.locator(selector).first().boundingBox();
    await circle(pricing, box!, margin);
    await expect(panel.getByTestId('annotation-count')).toHaveText(String(n), { timeout: 10_000 });
  };
  // 1: tight circle on the hero CTA. 2: the "Docs" link in the header nav.
  await draw('button.cta', 1.1, 1);
  await draw('header nav a[href="/docs.html"]', 1.3, 2);
  // 3: loose circle around the hero card (the button covers < 70% of it).
  await draw('.hero-card', 1.12, 3);
  // 4, 5: the two plan cards, after scrolling them into view.
  await pricing.evaluate(() => window.scrollTo(0, 420));
  await pricing.waitForTimeout(300);
  await draw('#plan-pro', 1.06, 4);
  await draw('#plan-basic', 1.06, 5);

  await saveSession(context, serviceWorker, panel, join(out!, 'pricing-annotations.session.json'));
});

async function saveSession(context: BrowserContext, serviceWorker: Worker, panel: Page, path: string) {
  const reviewPromise = context.waitForEvent('page', (p) => p.url().includes('/review.html'));
  await panel.getByTestId('stop').click();
  const review = await reviewPromise;
  await review.getByTestId('download-session').click();
  const downloadId = Number(
    await review.evaluate(async () => {
      for (let i = 0; i < 50 && !document.body.dataset.downloadId; i++) await new Promise((r) => setTimeout(r, 100));
      return document.body.dataset.downloadId;
    }),
  );
  await expect
    .poll(async () =>
      serviceWorker.evaluate(async (id) => (await chrome.downloads.search({ id }))[0]?.state, downloadId),
    )
    .toBe('complete');
  const file = await serviceWorker.evaluate(
    async (id) => (await chrome.downloads.search({ id }))[0]!.filename,
    downloadId,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, readFileSync(file, 'utf8'));
}

test('capture an arrow Connector for the Process fixtures', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  const out = process.env.CAPTURE_FIXTURES;
  test.skip(!out, 'set CAPTURE_FIXTURES=<dir> to capture');
  // No speech: the arrow alone has to carry the meaning, and nothing closes it but the time gap.
  await useScript(serviceWorker, { timestamp_quality: 'approximate', cues: [] });
  await grantMic(openExtensionPage);
  const pricing = await context.newPage();
  await pricing.setViewportSize({ width: 1280, height: 720 });
  await pricing.goto(`${site.primaryOrigin}/pricing.html`);
  const panel = await openExtensionPage('sidepanel.html');
  await panel.getByTestId('start').click();
  await expect(panel.getByTestId('status')).toHaveText('Recording');
  await panel.getByTestId('draw-toggle').click();
  await pricing.bringToFront();
  // 1: a hand-wobbled single-Stroke arrow from the hero CTA to the header nav, next to "Docs".
  const from = center((await pricing.locator('button.cta').boundingBox())!);
  const to = center((await pricing.locator('header nav a[href="/docs.html"]').boundingBox())!);
  await arrow(pricing, from, to, { jitter: 1.2, wobble: 6, seed: 11 });
  await expect(panel.getByTestId('annotation-count')).toHaveText('1', { timeout: 10_000 });
  await saveSession(context, serviceWorker, panel, join(out!, 'pricing-arrow.session.json'));
});
