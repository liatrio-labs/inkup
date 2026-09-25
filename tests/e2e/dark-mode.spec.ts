// The extension pages follow the system's light or dark scheme (prefers-color-scheme), live, with no toggle: the
// tokens and `dark:` utilities in src/assets/tailwind.css switch on the media query. Status text keeps WCAG AA
// contrast (4.5:1) against what is behind it in both schemes (src/components/tone.ts).
//
// Set DARK_MODE_SHOTS=<dir> to also write a full-page screenshot of each page in each scheme there.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { putRows } from './helpers/seed';

type Scheme = 'light' | 'dark';
type Rgb = [number, number, number];

const SHOTS = process.env.DARK_MODE_SHOTS;

/** The relative luminance (WCAG 2) of an sRGB colour. */
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * An element's text colour and the colour behind it, as sRGB. The computed styles are oklch or color-mix, so a
 * canvas does the conversion; the background paints every ancestor's fill from the root down, so translucent
 * fills (bg-amber-950/60) blend as they do on screen.
 */
async function colours(el: Locator): Promise<{ fg: Rgb; bg: Rgb }> {
  return el.evaluate((node) => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const paint = (colour: string) => {
      ctx.fillStyle = colour;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)] as [number, number, number];
    };
    const chain: Element[] = [];
    for (let e: Element | null = node; e; e = e.parentElement) chain.unshift(e);
    ctx.clearRect(0, 0, 1, 1);
    let bg: [number, number, number] = [0, 0, 0];
    for (const e of chain) bg = paint(getComputedStyle(e).backgroundColor);
    // The text's own colour, painted alone over the background it sits on.
    paint(`rgb(${bg.join(' ')})`);
    const fg = paint(getComputedStyle(node).color);
    return { fg, bg };
  });
}

async function setScheme(page: Page, scheme: Scheme): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
}

/** The page reads as `scheme`: a dark body with light text, or the other way round. */
async function expectScheme(page: Page, scheme: Scheme): Promise<void> {
  await expect
    .poll(async () => {
      const { fg, bg } = await colours(page.locator('body'));
      return { bgDark: luminance(bg) < 0.1, fgLight: luminance(fg) > 0.5 };
    })
    .toEqual(scheme === 'dark' ? { bgDark: true, fgLight: true } : { bgDark: false, fgLight: false });
}

async function expectReadable(el: Locator, what: string): Promise<number> {
  await expect(el).toBeVisible();
  const { fg, bg } = await colours(el);
  const ratio = contrast(fg, bg);
  expect(ratio, `${what}: ${ratio.toFixed(2)}:1 (fg ${fg}, bg ${bg})`).toBeGreaterThanOrEqual(4.5);
  return ratio;
}

async function shoot(page: Page, name: string, scheme: Scheme): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`), fullPage: true });
}

/** Opens `path` dark, checks it reads dark, then flips it to light and back without a reload. */
async function checkPage(page: Page, name: string, statuses: (scheme: Scheme) => Promise<void> = async () => {}) {
  const url = page.url();
  for (const scheme of ['dark', 'light', 'dark'] as const) {
    await setScheme(page, scheme);
    await expectScheme(page, scheme);
    await statuses(scheme);
    await shoot(page, name, scheme);
  }
  // Every flip was live: the page never navigated.
  expect(page.url()).toBe(url);
}

/** A processed Session as stored: its row, a done Process run with these Change Items, and no media. */
function processedSession(id: string) {
  const runId = `${id}-run`;
  const item = (n: number, confidence: number, extra: Record<string, unknown> = {}) => ({
    id: `item_000${n}`,
    title: `Change item_000${n}`,
    category: 'copy',
    intent: 'Make the heading say what the page is for.',
    locations: [],
    evidence: { video: null, screenshots: [] },
    transcript: '',
    confidence,
    agent_prompt: 'Seeded.',
    pinned: false,
    ...extra,
  });
  return {
    runId,
    session: {
      id,
      tab_id: 1,
      t0: 0,
      started_at: '2026-09-20T10:00:00.000Z',
      ended_at: '2026-09-20T10:00:00.000Z',
      duration_ms: 5000,
      start_url: 'https://app.example/pricing',
      start_title: `Seeded ${id}`,
      status: 'ended',
      transcription: null,
      video_off_reason: null,
      media_deleted_at: null,
      audio: null,
      video: null,
    },
    run: {
      id: runId,
      session_id: id,
      created_at: 1,
      finished_at: 2,
      status: 'done',
      model: 'seeded',
      estimate: null,
      items: [
        item(1, 0.9),
        item(2, 0.9),
        item(3, 0.9),
        item(4, 0.9),
        item(5, 0.3, { ambiguity: 'The reviewer said both "bigger" and "smaller" about this heading.' }),
      ],
      calls: [],
      second_pass: [],
      error: null,
      error_code: null,
    },
  };
}

const STATUSES = ['in_progress', 'resolved', 'wont_fix', 'needs_info'] as const;

async function seedReviewed(page: Page): Promise<void> {
  const s = processedSession('dark');
  await putRows(page, {
    sessions: [s.session],
    processRuns: [s.run],
    resolutions: STATUSES.map((status, i) => ({
      id: `r${i}`,
      session_id: 'dark',
      run_id: s.runId,
      item_id: `item_000${i + 1}`,
      status,
      note: status === 'needs_info' ? 'Which heading: the hero or the card?' : '',
      source: 'mcp',
      agent: 'inkup-e2e',
      created_at: Date.now(),
    })),
  });
}

test.beforeEach(async ({ context }) => {
  // A nearly full disk, so the list and the panel show their storage warning callout.
  await context.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:') return;
    Object.defineProperty(navigator.storage, 'estimate', {
      value: async () => ({ usage: 85_000_000, quota: 100_000_000 }),
    });
  });
});

test('the review page follows the system scheme live, and its status colours stay readable in both', async ({
  openExtensionPage,
}) => {
  const list = await openExtensionPage('sessions.html');
  await expect
    .poll(() => list.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === 'inkup')))
    .toBe(true);
  await seedReviewed(list);
  const review = await openExtensionPage('review.html?session=dark');
  await expect(review.getByTestId('item-resolution')).toHaveCount(4);
  await checkPage(review, 'review', async (scheme) => {
    for (const status of STATUSES) {
      const box = review.locator(`[data-testid="item-resolution"][data-status="${status}"]`);
      await expectReadable(box.getByTestId('item-resolution-label'), `${scheme} ${status} label`);
    }
    await expectReadable(review.getByTestId('item-resolution-note'), `${scheme} needs-info note`);
    await expectReadable(review.getByTestId('check-me'), `${scheme} check-me chip`);
    await expectReadable(review.getByTestId('ambiguity'), `${scheme} ambiguity`);
  });
});

test('the Session list follows the system scheme live, and its counts and warning stay readable in both', async ({
  openExtensionPage,
}) => {
  const list = await openExtensionPage('sessions.html');
  await expect
    .poll(() => list.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === 'inkup')))
    .toBe(true);
  await seedReviewed(list);
  await list.reload();
  const counts = list.locator('[data-session="dark"]').getByTestId('session-items');
  await expect(counts).toHaveAttribute('data-in-progress', '1');
  await checkPage(list, 'sessions', async (scheme) => {
    for (const hue of ['in work', 'done', 'needs info'])
      await expectReadable(counts.locator('span', { hasText: hue }), `${scheme} "${hue}" count`);
    await expectReadable(list.getByTestId('storage-warning'), `${scheme} storage warning`);
  });
});

test('the side panel follows the system scheme live, and its warning stays readable in both', async ({
  openExtensionPage,
}) => {
  const panel = await openExtensionPage('sidepanel.html');
  await expect(panel.getByTestId('start')).toBeVisible();
  await checkPage(panel, 'sidepanel', async (scheme) => {
    await expectReadable(panel.getByTestId('storage-warning'), `${scheme} storage warning`);
    await expectReadable(panel.getByTestId('status'), `${scheme} status pill`);
  });
});

for (const page of ['options.html', 'onboarding.html']) {
  test(`${page} follows the system scheme live`, async ({ openExtensionPage }) => {
    const p = await openExtensionPage(page);
    await expect(p.locator('body')).not.toBeEmpty();
    await p.waitForLoadState('networkidle');
    await checkPage(p, page.replace('.html', ''), async (scheme) => {
      // Form fields are native controls: their text follows the scheme too, instead of dark on dark.
      const field = p.locator('input:not([type="checkbox"]):not([type="radio"]), select, textarea').first();
      if (await field.count()) await expectReadable(field, `${scheme} ${page} first field`);
    });
  });
}
