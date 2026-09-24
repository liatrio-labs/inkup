// Not a test: records real Strokes (pointer events through the overlay) for the shape classifier's unit tests.
// Skipped unless CAPTURE_STROKES=<output dir> is set.
//
//   CAPTURE_STROKES=fixtures/strokes pnpm test:e2e stroke-capture
//
// Each shape is drawn as its own Annotation, then its Strokes are read back from IndexedDB and written to
// <dir>/<name>.json as { name, expected, strokes: [[{x, y, t}, …], …] }.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, grantMic, test, useScriptedTranscript } from './fixtures';
import { arrow, type Box, circle, scribble, stroke, underline } from './helpers/draw';
import { activeSessionId, ofType, sessionEvents } from './helpers/session';

type Draw = (page: Page) => Promise<void>;
const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height });
const hand = { jitter: 3, wobble: 4, seed: 11 };

const SHAPES: [name: string, expected: string, draw: Draw][] = [
  ['circle', 'circle', (p) => circle(p, box(560, 200, 160, 70))],
  ['circle-hand', 'circle', (p) => circle(p, box(520, 180, 240, 120), 1.1, { ...hand, overshoot: 0.12 })],
  [
    'circle-hand-small',
    'circle',
    (p) => circle(p, box(1000, 20, 60, 28), 1.2, { jitter: 1.5, wobble: 1.5, seed: 5, overshoot: 0.06 }),
  ],
  [
    'circle-hand-undershoot',
    'circle',
    (p) => circle(p, box(300, 300, 200, 140), 1, { jitter: 2, wobble: 3, seed: 21, overshoot: -0.08 }),
  ],
  ['underline', 'underline', (p) => underline(p, box(120, 220, 360, 40))],
  ['underline-hand', 'underline', (p) => underline(p, box(120, 300, 300, 20), { jitter: 2, wobble: 4, seed: 3 })],
  ['arrow', 'arrow', (p) => arrow(p, [640, 400], [1040, 60])],
  ['arrow-hand', 'arrow', (p) => arrow(p, [300, 500], [700, 380], { ...hand, seed: 9 })],
  ['arrow-short', 'arrow', (p) => arrow(p, [200, 600], [300, 560], { jitter: 1.5, seed: 4 })],
  ['arrow-left', 'arrow', (p) => arrow(p, [900, 600], [500, 620], { jitter: 2, wobble: 3, seed: 8 })],
  ['arrow-two-stroke', 'arrow', (p) => arrow(p, [640, 400], [1040, 60], { twoStroke: true })],
  ['arrow-two-stroke-hand', 'arrow', (p) => arrow(p, [300, 600], [800, 450], { twoStroke: true, ...hand, seed: 13 })],
  ['scribble', 'scribble', (p) => scribble(p, box(400, 420, 220, 120))],
  ['scribble-hand', 'scribble', (p) => scribble(p, box(700, 420, 160, 100), 10, { jitter: 3, wobble: 5, seed: 17 })],
  [
    'vertical-line',
    'freeform',
    (p) =>
      stroke(
        p,
        Array.from({ length: 30 }, (_, i) => [1100, 150 + i * 12] as const),
      ),
  ],
  [
    'check-mark',
    'freeform',
    (p) =>
      stroke(p, [
        ...Array.from({ length: 10 }, (_, i) => [200 + i * 4, 400 + i * 6] as const),
        ...Array.from({ length: 20 }, (_, i) => [240 + i * 6, 460 - i * 10] as const),
      ]),
  ],
  [
    's-curve',
    'freeform',
    (p) =>
      stroke(
        p,
        Array.from({ length: 50 }, (_, i) => [300 + i * 8, 450 + 60 * Math.sin((i / 49) * 2 * Math.PI)] as const),
      ),
  ],
];

test('capture Stroke fixtures for the shape classifier', async ({
  context,
  serviceWorker,
  site,
  openExtensionPage,
}) => {
  const out = process.env.CAPTURE_STROKES;
  test.skip(!out, 'set CAPTURE_STROKES=<dir> to capture');
  test.setTimeout(180_000);
  await useScriptedTranscript(serviceWorker, 'pricing-cta.json');
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

  mkdirSync(out!, { recursive: true });
  let seen = 0;
  for (const [name, expected, draw] of SHAPES) {
    await draw(page);
    await expect
      .poll(async () => ofType(await sessionEvents(panel, sessionId), 'annotation').length, { timeout: 10_000 })
      .toBe(seen + 1);
    seen++;
    const events = await sessionEvents(panel, sessionId);
    const ann = ofType(events, 'annotation').at(-1)!;
    const strokes = ofType(events, 'stroke').filter((s) => ann.stroke_ids.includes(s.stroke_id));
    const t0 = strokes[0]!.t;
    const json = {
      name,
      expected,
      strokes: strokes.map((s) => s.points.map((q) => ({ x: q.x, y: q.y, t: q.t - t0 }))),
    };
    writeFileSync(join(out!, `${name}.json`), `${JSON.stringify(json)}\n`);
  }
  await panel.getByTestId('stop').click();
});
